// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IEAS, AttestationRequest, AttestationRequestData} from "@eas/IEAS.sol";
import {IEASTrustedIssuersAdapter} from "@shibui/interfaces/IEASTrustedIssuersAdapter.sol";
import {EASTrustedIssuersAdapter} from "@shibui/EASTrustedIssuersAdapter.sol";
import {KitFixture} from "../helpers/KitFixture.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";

/// @title AttesterTrustIntegrationTest
/// @notice I5 (attester rotation, W7), I6 (only resolver authorizers can authorize issuers),
///         I7 (an investor cannot register their own credential). Real EAS, real Shibui, I9 after every change.
contract AttesterTrustIntegrationTest is KitFixture {
    /// EAS reverts with its own InvalidAttestation() when a schema resolver returns false (EAS.sol, 0.8.28).
    bytes4 internal constant EAS_INVALID_ATTESTATION = bytes4(keccak256("InvalidAttestation()"));

    // ============ I5 ============

    /// I5: rotate KYC provider A out and B in, step by step, checking every way the swap can go wrong.
    function test_I5_attesterRotation_everyFailurePath_thenBReattests() public {
        issueTo(DEPOSIT, alice, 100 * UNIT);
        assertAllAgree();
        issueTo(FUND, alice, 100 * UNIT);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            issueTo(k, bob, 100 * UNIT);
            assertAllAgree();
        }

        // Step 1. Stop trusting A on every token. Every A-backed investor is refused on the next transfer,
        //         and explain names the reason: the credential exists, its attester is no longer trusted.
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            EASTrustedIssuersAdapter adapter = kits[k].adapter;
            vm.expectEmit(true, false, false, true, address(adapter));
            emit IEASTrustedIssuersAdapter.TrustedAttesterRemoved(providerA);
            vm.prank(operator);
            adapter.removeTrustedAttester(providerA);
            assertAllAgree();
        }
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertFalse(kits[k].eligibility.isEligible(bob), "I5: removing A blocks A-backed investors");
            assertEveryTopic(k, bob, IEligibility.Status.ATTESTER_NOT_TRUSTED, "I5: explain ATTESTER_NOT_TRUSTED");
            assertEveryTopic(k, carol, IEligibility.Status.NOT_REGISTERED, "I5: carol never had a credential");
            vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, bob));
            vm.prank(bob);
            kits[k].token.transfer(bob, 1 * UNIT);
        }

        uint256[] memory depositTopics = kits[DEPOSIT].topics;
        EASTrustedIssuersAdapter depositAdapter = kits[DEPOSIT].adapter;

        // Step 2. B without any authorization: refused (no UID, or a UID that is not an Issuer Authorization).
        vm.expectRevert(IEASTrustedIssuersAdapter.IssuerAuthAttestationMissing.selector);
        vm.prank(operator);
        depositAdapter.addTrustedAttester(providerB, depositTopics, bytes32(0));

        vm.expectRevert(IEASTrustedIssuersAdapter.IssuerAuthAttestationMissing.selector);
        vm.prank(operator);
        depositAdapter.addTrustedAttester(providerB, depositTopics, aliceCredential); // wrong schema

        // ... nor with someone else's live authorization.
        vm.expectRevert(IEASTrustedIssuersAdapter.IssuerAuthRecipientMismatch.selector);
        vm.prank(operator);
        depositAdapter.addTrustedAttester(providerB, depositTopics, providerAAuth);

        // Step 3. B with a REVOKED authorization: refused.
        bytes32 revokedAuth = attestIssuerAuth(providerB, allKitTopics(), "KYC Provider B (demo)");
        assertAllAgree();
        revoke(operator, revokedAuth);
        assertAllAgree();
        vm.expectRevert(IEASTrustedIssuersAdapter.IssuerAuthAttestationMissing.selector);
        vm.prank(operator);
        depositAdapter.addTrustedAttester(providerB, depositTopics, revokedAuth);

        // Step 4. B with a live authorization that does not cover the topics: refused.
        bytes32 kycOnlyAuth = attestIssuerAuth(providerB, _list(KYC), "KYC Provider B (KYC only)");
        assertAllAgree();
        vm.expectRevert(IEASTrustedIssuersAdapter.IssuerAuthTopicsNotAuthorized.selector);
        vm.prank(operator);
        depositAdapter.addTrustedAttester(providerB, depositTopics, kycOnlyAuth); // KYC + SANCTIONS > KYC

        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertFalse(kits[k].adapter.isTrustedAttester(providerB), "I5: no failed attempt left B trusted");
        }
        assertAllAgree();

        // Step 5. A live authorization covering the topics: EAS records it (Attested) and every adapter accepts B.
        vm.recordLogs();
        bytes32 authB = attestIssuerAuth(providerB, allKitTopics(), "KYC Provider B (demo)");
        _assertAttestedLogged(authB, providerB, operator, issuerAuthSchema);
        assertAllAgree();

        for (uint256 k = 0; k < KIT_COUNT; k++) {
            vm.expectEmit(true, false, false, true, address(kits[k].adapter));
            emit IEASTrustedIssuersAdapter.TrustedAttesterAdded(providerB, kits[k].topics);
            trust(k, providerB, authB, allKitTopics());
            assertEq(kits[k].adapter.getAttesterTopics(providerB), kits[k].topics);
            assertAllAgree();
        }

        // B is trusted but has attested nobody yet: still refused. The closest reason is still A's credential.
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertFalse(kits[k].eligibility.isEligible(bob), "I5: trusting B alone does not re-open anything");
            assertEveryTopic(k, bob, IEligibility.Status.ATTESTER_NOT_TRUSTED, "I5: A's credential still named");
        }

        // Step 6. B re-attests the cast (W2 again). The cast table holds again under B.
        onboard(providerB, alice, credential(US, ACC_NONE));
        assertAllAgree();
        onboard(providerB, bob, credential(US, ACC_ACCREDITED));
        assertAllAgree();
        onboard(providerB, dave, credential(CN, ACC_NONE));
        assertAllAgree();
        _assertCastTable();

        for (uint256 k = 0; k < KIT_COUNT; k++) {
            vm.prank(bob);
            kits[k].token.transfer(bob, 1 * UNIT); // Bob can move his tokens again
            assertAllAgree();
        }
        vm.prank(bob);
        kits[FUND].token.transfer(alice, 1 * UNIT);
        assertAllAgree();

        // A cannot come back through registration: new A credentials are refused at registerAttestation.
        bytes32 lateA = attest(providerA, carol, credential(US, ACC_ACCREDITED));
        assertAllAgree();
        vm.expectRevert(bytes("Attester not trusted"));
        vm.prank(providerA);
        kits[DEPOSIT].verifier.registerAttestation(carol, KYC, lateA);
        assertAllAgree();
    }

    /// I5 / W7 through the fixture's rotate() helper: nobody passes between rotation and re-attestation,
    /// and after B re-attests the original cast table is restored exactly.
    function test_I5_rotateHelper_W7_restoresCastTableUnderB() public {
        rotate(providerA, providerB, allKitTopics(), "KYC Provider B (demo)");
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertFalse(kits[k].adapter.isTrustedAttester(providerA));
            assertTrue(kits[k].adapter.isTrustedAttester(providerB));
            address[] memory watched = kits[k].eligibility.watchedAttesters();
            assertEq(watched.length, 2);
            assertEq(watched[0], providerA);
            assertEq(watched[1], providerB);
            assertFalse(kits[k].eligibility.isEligible(alice));
            assertFalse(kits[k].eligibility.isEligible(bob));
            assertFalse(kits[k].eligibility.isEligible(dave));
        }

        onboard(providerB, alice, credential(US, ACC_NONE));
        assertAllAgree();
        onboard(providerB, bob, credential(US, ACC_ACCREDITED));
        assertAllAgree();
        onboard(providerB, dave, credential(CN, ACC_NONE));
        assertAllAgree();
        _assertCastTable();
    }

    // ============ I6 ============

    /// I6: only addresses on the TrustedIssuerResolver's authorizer list can create an Issuer Authorization.
    ///     A KYC provider cannot authorize itself; nor can the issuer, compliance or an investor.
    function test_I6_nonAuthorizerCannotCreateIssuerAuthorization() public {
        address[5] memory outsiders = [providerA, providerB, issuer, compliance, alice];
        for (uint256 i = 0; i < outsiders.length; i++) {
            address x = outsiders[i];
            assertFalse(resolver.isAuthorizer(x));
            AttestationRequest memory req = _issuerAuthRequest(providerB, allKitTopics(), "self-authorized");
            vm.expectRevert(EAS_INVALID_ATTESTATION);
            vm.prank(x);
            eas.attest(req);
        }

        // B never obtained an authorization, so no adapter can be told to trust it.
        vm.expectRevert(IEASTrustedIssuersAdapter.IssuerAuthAttestationMissing.selector);
        vm.prank(operator);
        kits[DEPOSIT].adapter.addTrustedAttester(providerB, kits[DEPOSIT].topics, bytes32(0));

        // Positive control: the operator (the one authorizer) can.
        bytes32 ok = attestIssuerAuth(providerB, allKitTopics(), "KYC Provider B (demo)");
        assertEq(eas.getAttestation(ok).attester, operator);
        assertAllAgree();

        // The gate is the authorizer list, not identity: add compliance, it can; remove it, it cannot.
        vm.prank(operator);
        resolver.addAuthorizer(compliance);
        assertAllAgree();
        AttestationRequest memory req2 = _issuerAuthRequest(providerB, allKitTopics(), "via compliance");
        vm.prank(compliance);
        bytes32 viaCompliance = eas.attest(req2);
        assertEq(eas.getAttestation(viaCompliance).attester, compliance);
        assertAllAgree();

        vm.prank(operator);
        resolver.removeAuthorizer(compliance);
        assertAllAgree();
        vm.expectRevert(EAS_INVALID_ATTESTATION);
        vm.prank(compliance);
        eas.attest(req2);
        assertAllAgree();
    }

    // ============ I7 ============

    /// I7: an investor holding a live credential from a trusted provider still cannot register it.
    ///     Only the attester (or an identity-proxy agent) can; otherwise investors could pick their own evidence.
    function test_I7_investorCannotRegisterOwnCredential() public {
        address grace = makeAddr("grace");
        track(grace);
        bytes32 uid = attest(providerA, grace, credential(US, ACC_ACCREDITED)); // right schema, recipient, attester
        assertAllAgree();

        for (uint256 k = 0; k < KIT_COUNT; k++) {
            for (uint256 j = 0; j < kits[k].topics.length; j++) {
                uint256 topic = kits[k].topics[j];
                vm.expectRevert(bytes("Caller not authorized"));
                vm.prank(grace);
                kits[k].verifier.registerAttestation(grace, topic, uid);
            }
            assertFalse(kits[k].eligibility.isEligible(grace), "I7: self-registration must not open the door");
            assertEveryTopic(k, grace, IEligibility.Status.NOT_REGISTERED, "I7: still NOT_REGISTERED");
        }

        // Nor can another investor or the token's issuer register it for her.
        vm.expectRevert(bytes("Caller not authorized"));
        vm.prank(bob);
        kits[DEPOSIT].verifier.registerAttestation(grace, KYC, uid);
        vm.expectRevert(bytes("Caller not authorized"));
        vm.prank(issuer);
        kits[DEPOSIT].verifier.registerAttestation(grace, KYC, uid);

        // Alice cannot re-register her own existing credential either.
        vm.expectRevert(bytes("Caller not authorized"));
        vm.prank(alice);
        kits[NOTE].verifier.registerAttestation(alice, ACCREDITATION, aliceCredential);

        // A self-issued credential fails earlier: its attester is not trusted.
        bytes32 selfIssued = attest(grace, grace, credential(US, ACC_INSTITUTIONAL));
        vm.expectRevert(bytes("Attester not trusted"));
        vm.prank(grace);
        kits[DEPOSIT].verifier.registerAttestation(grace, KYC, selfIssued);
        assertAllAgree();

        // Positive controls: an identity-proxy agent (the operator) and the provider itself can register.
        vm.prank(operator);
        kits[DEPOSIT].verifier.registerAttestation(grace, KYC, uid);
        assertAllAgree();
        register(providerA, grace, uid);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertTrue(kits[k].eligibility.isEligible(grace), "I7: provider registration works");
        }
    }

    // ============ helpers ============

    function _assertCastTable() internal view {
        bool[4][3] memory expected = [
            [true, true, false, true], // deposit: alice, bob, carol, dave
            [true, true, false, false], // fund
            [false, true, false, false] // note
        ];
        address[4] memory cast = [alice, bob, carol, dave];
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            for (uint256 i = 0; i < 4; i++) {
                assertEq(kits[k].eligibility.isEligible(cast[i]), expected[k][i], "cast table");
                assertEq(kits[k].token.canReceive(cast[i]), expected[k][i], "cast table canReceive");
            }
        }
        assertStatus(NOTE, alice, ACCREDITATION, IEligibility.Status.POLICY_REJECTED, "alice note");
        assertStatus(FUND, dave, COUNTRY, IEligibility.Status.POLICY_REJECTED, "dave fund");
    }

    function _issuerAuthRequest(address provider, uint256[] memory topics, string memory issuerName)
        internal
        view
        returns (AttestationRequest memory)
    {
        return AttestationRequest({
            schema: issuerAuthSchema,
            data: AttestationRequestData({
                recipient: provider,
                expirationTime: 0,
                revocable: true,
                refUID: bytes32(0),
                data: abi.encode(provider, topics, issuerName),
                value: 0
            })
        });
    }

    /// I5: the authorization is an EAS event an auditor can find: Attested(recipient, attester, uid, schema).
    function _assertAttestedLogged(bytes32 uid, address recipient, address attester, bytes32 schema) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(eas) || logs[i].topics[0] != IEAS.Attested.selector) continue;
            if (abi.decode(logs[i].data, (bytes32)) != uid) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(recipient))), "Attested.recipient");
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(attester))), "Attested.attester");
            assertEq(logs[i].topics[3], schema, "Attested.schemaUID");
            found++;
        }
        assertEq(found, 1, "I5: EAS must emit exactly one Attested event for the authorization");
    }
}
