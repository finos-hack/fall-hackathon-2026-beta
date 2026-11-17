// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISchemaResolver} from "@eas/resolver/ISchemaResolver.sol";
import {IEASClaimVerifier} from "@shibui/interfaces/IEASClaimVerifier.sol";
import {EASClaimVerifier} from "@shibui/EASClaimVerifier.sol";
import {KitFixture} from "../helpers/KitFixture.sol";
import {ShibuiEligibility} from "../../contracts/ShibuiEligibility.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";

/// @title ExplainEdgesIntegrationTest
/// @notice I9 in the corners: explain must agree with Shibui's isVerified for every credential state the real
///         contracts can produce, including the ones the demo never shows (remapped schema, malformed payload,
///         two trusted attesters disagreeing). Also the slot's own guards (watchAttester, constructor).
contract ExplainEdgesIntegrationTest is KitFixture {
    address internal judy = makeAddr("judy");

    function setUp() public override {
        super.setUp();
        track(judy);
    }

    /// Topic remapped to a new schema: Alice's registered credential no longer counts. Shibui skips it
    /// (schema mismatch); explain must say NOT_REGISTERED for that topic, and OK for the untouched one.
    function test_explain_schemaRemap_reportsNotRegistered() public {
        vm.prank(operator);
        bytes32 v2 = schemaRegistry.register(INVESTOR_ELIGIBILITY_SCHEMA, ISchemaResolver(address(0)), false);
        assertTrue(v2 != investorEligibilitySchema);
        assertAllAgree();

        vm.prank(operator);
        kits[DEPOSIT].verifier.setTopicSchemaMapping(KYC, v2);
        assertAllAgree();
        assertFalse(kits[DEPOSIT].eligibility.isEligible(alice));
        assertStatus(DEPOSIT, alice, KYC, IEligibility.Status.NOT_REGISTERED, "remapped topic");
        assertStatus(DEPOSIT, alice, SANCTIONS, IEligibility.Status.OK, "untouched topic");
    }

    /// A credential from an attester that is no longer trusted keeps its own state in explain: an EAS-expired one
    /// reads EXPIRED (not "attester not trusted"), and one under a remapped schema reads NOT_REGISTERED.
    function test_explain_untrustedAttester_credentialStateComesFirst() public {
        Credential memory c = credential(US, ACC_ACCREDITED);
        c.easExpirationTime = uint64(block.timestamp + 30 days);
        c.expirationTimestamp = 0;
        onboard(providerA, judy, c);
        assertAllAgree();
        rotate(providerA, providerB, allKitTopics(), "KYC Provider B (demo)");
        assertAllAgree();
        assertStatus(DEPOSIT, judy, KYC, IEligibility.Status.ATTESTER_NOT_TRUSTED, "live credential, attester removed");

        vm.warp(c.easExpirationTime);
        assertAllAgree();
        assertStatus(DEPOSIT, judy, KYC, IEligibility.Status.EXPIRED, "expired credential, attester removed");

        vm.prank(operator);
        bytes32 v2 = schemaRegistry.register(INVESTOR_ELIGIBILITY_SCHEMA, ISchemaResolver(address(0)), false);
        vm.prank(operator);
        kits[DEPOSIT].verifier.setTopicSchemaMapping(KYC, v2);
        assertAllAgree();
        assertStatus(DEPOSIT, judy, KYC, IEligibility.Status.NOT_REGISTERED, "old-schema credential, attester removed");
    }

    /// A trusted provider attests a payload that is not a 320-byte Investor Eligibility record. EAS does not
    /// validate payloads and registration does not either; the policies reject it. explain: POLICY_REJECTED.
    function test_explain_malformedPayload_reportsPolicyRejected() public {
        bytes32 uid = attestRaw(providerA, judy, abi.encode(judy, KYC_VERIFIED), 0); // 64 bytes
        register(providerA, judy, uid);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertFalse(kits[k].eligibility.isEligible(judy));
            assertEveryTopic(k, judy, IEligibility.Status.POLICY_REJECTED, "malformed payload");
        }
    }

    /// A fresh, live credential whose content fails one policy: only that topic is POLICY_REJECTED.
    function test_explain_kycRevokedInPayload_reportsPolicyRejectedOnKycOnly() public {
        Credential memory c = credential(US, ACC_ACCREDITED);
        c.kycStatus = KYC_REVOKED;
        onboard(providerA, judy, c);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertFalse(kits[k].eligibility.isEligible(judy));
            assertStatus(k, judy, KYC, IEligibility.Status.POLICY_REJECTED, "KYC status REVOKED in payload");
        }
        assertStatus(DEPOSIT, judy, SANCTIONS, IEligibility.Status.OK, "sanctions still clear");
        assertStatus(NOTE, judy, ACCREDITATION, IEligibility.Status.OK, "accreditation still fine");
    }

    /// Two trusted attesters (A and B) for the same investor. Shibui passes a topic as soon as ONE attester's
    /// credential passes; explain must report OK then, and otherwise the reason closest to passing.
    function test_explain_twoTrustedAttesters_okWinsThenClosestReason() public {
        authorize(providerB, allKitTopics(), "KYC Provider B (demo)");
        bytes32 fromA = onboard(providerA, judy, credential(US, ACC_ACCREDITED));
        assertAllAgree();

        // A revoked, B nothing: REVOKED beats NOT_REGISTERED.
        revoke(providerA, fromA);
        assertAllAgree();
        assertEveryTopic(DEPOSIT, judy, IEligibility.Status.REVOKED, "A revoked, B absent");

        // B attests with a short EAS expiry: OK while it lasts, even though A's credential is revoked.
        Credential memory c = credential(US, ACC_ACCREDITED);
        c.easExpirationTime = uint64(block.timestamp + 1 days);
        onboard(providerB, judy, c);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertTrue(kits[k].eligibility.isEligible(judy), "one passing attester is enough");
            assertEveryTopic(k, judy, IEligibility.Status.OK, "B passes");
        }

        // B's expires: EXPIRED beats REVOKED.
        vm.warp(block.timestamp + 1 days);
        assertAllAgree();
        assertEveryTopic(DEPOSIT, judy, IEligibility.Status.EXPIRED, "A revoked, B expired");

        // B re-attests with content that fails the deposit's policies: POLICY_REJECTED beats REVOKED.
        Credential memory bad = credential(US, ACC_ACCREDITED);
        bad.kycStatus = KYC_REVOKED;
        bad.sanctionsStatus = SANCTIONS_HIT;
        onboard(providerB, judy, bad);
        assertAllAgree();
        assertEveryTopic(DEPOSIT, judy, IEligibility.Status.POLICY_REJECTED, "A revoked, B rejected");

        // B is de-trusted: A's REVOKED (trusted attester) beats B's ATTESTER_NOT_TRUSTED (watched attester).
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            vm.prank(operator);
            kits[k].adapter.removeTrustedAttester(providerB);
        }
        assertAllAgree();
        assertEveryTopic(DEPOSIT, judy, IEligibility.Status.REVOKED, "A revoked, B untrusted");
    }

    /// A watched, untrusted attester that never registered anything for the wallet is not a reason.
    function test_explain_watchedAttesterWithoutRegistrationIsIgnored() public {
        rotate(providerA, providerB, allKitTopics(), "KYC Provider B (demo)");
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertEveryTopic(k, carol, IEligibility.Status.NOT_REGISTERED, "carol has nothing from A or B");
            assertEveryTopic(k, alice, IEligibility.Status.ATTESTER_NOT_TRUSTED, "alice has A's credential");
        }
    }

    /// watchAttester is owner-only, rejects zero, is idempotent, and is bounded (explain stays cheap).
    function test_watchAttester_guards() public {
        ShibuiEligibility e = kits[DEPOSIT].eligibility;

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, providerA));
        vm.prank(providerA);
        e.watchAttester(providerA);

        vm.expectRevert(ShibuiEligibility.ZeroAddress.selector);
        vm.prank(operator);
        e.watchAttester(address(0));

        // Re-watching is a no-op: no event, no duplicate.
        vm.recordLogs();
        vm.prank(operator);
        e.watchAttester(providerA);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(e.watchedAttesters().length, 1);
        assertAllAgree();

        uint256 max = e.MAX_WATCHED_ATTESTERS();
        for (uint256 i = 1; i < max; i++) {
            address a = address(uint160(0xA770000 + i));
            vm.expectEmit(true, false, false, false, address(e));
            emit ShibuiEligibility.AttesterWatched(a);
            vm.prank(operator);
            e.watchAttester(a);
            assertAllAgree();
        }
        assertEq(e.watchedAttesters().length, max);
        vm.expectRevert(ShibuiEligibility.TooManyWatchedAttesters.selector);
        vm.prank(operator);
        e.watchAttester(address(0xBEEF));

        // Watching only changes explanations: enforcement for the cast is unchanged.
        assertAllAgree();
        assertTrue(e.isEligible(alice));
    }

    /// The slot refuses a zero verifier, and isEligible fails closed (false, no revert) when the verifier is not a
    /// contract. (explain is not asserted here: it makes high-level calls to the verifier and reverts in this case.)
    function test_slot_constructorAndNonContractVerifier_failClosed() public {
        vm.expectRevert(ShibuiEligibility.ZeroAddress.selector);
        new ShibuiEligibility(IEASClaimVerifier(address(0)), operator);

        vm.expectRevert(ShibuiEligibility.NotAContract.selector);
        new ShibuiEligibility(IEASClaimVerifier(makeAddr("not a contract")), operator);

        // A verifier that loses its code after deployment: enforcement fails closed and explain reports
        // MISCONFIGURED instead of reverting, so the console can still show a reason.
        address doomed = address(new EASClaimVerifier(operator));
        ShibuiEligibility hollow = new ShibuiEligibility(IEASClaimVerifier(doomed), operator);
        vm.etch(doomed, "");
        assertFalse(hollow.isEligible(alice), "D3: non-contract verifier means not eligible");
        IEligibility.TopicStatus[] memory why = hollow.explain(alice);
        assertEq(why.length, 1);
        assertEq(uint8(why[0].status), uint8(IEligibility.Status.MISCONFIGURED));

        RegulatedToken token = new RegulatedToken("Hollow Demo", "dHOL", 6, operator, hollow);
        vm.prank(operator);
        token.grantRole(keccak256("ISSUER_ROLE"), issuer);
        assertFalse(token.canReceive(alice));
        assertFalse(token.canSend(bob));
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(issuer);
        token.issue(alice, 1 * UNIT);
        assertAllAgree(); // the kit tokens are untouched
    }
}
