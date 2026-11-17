// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {EASClaimVerifier} from "@shibui/EASClaimVerifier.sol";
import {IEASClaimVerifier} from "@shibui/interfaces/IEASClaimVerifier.sol";
import {KitFixture} from "../helpers/KitFixture.sol";
import {ShibuiEligibility} from "../../contracts/ShibuiEligibility.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";

/// @title FailClosedIntegrationTest
/// @notice I8 (decision D3: a broken eligibility source means "no", never "yes", and never a reverting view),
///         MISCONFIGURED semantics, and I10 (one token's settings never leak into another, decision D1).
contract FailClosedIntegrationTest is KitFixture {
    // ============ I8 ============

    /// I8: a required topic loses its policy. Shibui's isVerified REVERTS (PolicyNotConfiguredForTopic);
    ///     the slot must turn that into false, the ERC-7943 views must answer false without reverting,
    ///     money must not move, and explain must point at the topic: POLICY_MISSING.
    function test_I8_missingPolicy_failsClosed_withoutRevertingViews() public {
        RegulatedToken token = kits[DEPOSIT].token;
        issueTo(DEPOSIT, alice, 100 * UNIT);
        assertAllAgree();
        issueTo(DEPOSIT, bob, 100 * UNIT);
        assertAllAgree();

        vm.prank(operator);
        kits[DEPOSIT].verifier.setTopicPolicy(SANCTIONS, address(0));
        assertAllAgree(); // the views themselves must not revert

        vm.expectRevert(abi.encodeWithSelector(IEASClaimVerifier.PolicyNotConfiguredForTopic.selector, SANCTIONS));
        kits[DEPOSIT].verifier.isVerified(alice);

        address[3] memory holders = [alice, bob, dave];
        for (uint256 i = 0; i < holders.length; i++) {
            address w = holders[i];
            assertFalse(kits[DEPOSIT].eligibility.isEligible(w), "I8: missing policy must mean not eligible");
            assertFalse(token.canReceive(w), "I8: canReceive false, no revert");
            assertFalse(token.canSend(w), "I8: canSend false, no revert");
            assertFalse(token.canTransfer(bob, w, 1), "I8: canTransfer false, no revert");
            assertStatus(DEPOSIT, w, KYC, IEligibility.Status.OK, "I8: KYC itself is fine");
            assertStatus(DEPOSIT, w, SANCTIONS, IEligibility.Status.POLICY_MISSING, "I8: explain POLICY_MISSING");
        }

        // Issuance (a transfer from the zero address) and forced transfers hit the receive check.
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(issuer);
        token.issue(alice, 1 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(compliance);
        token.forcedTransfer(bob, alice, 1 * UNIT);
        // A holder-to-holder transfer is refused too; RegulatedToken checks the sender first.
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, bob));
        vm.prank(bob);
        token.transfer(alice, 1 * UNIT);
        assertEq(token.balanceOf(alice), 100 * UNIT);
        assertEq(token.balanceOf(bob), 100 * UNIT);

        // D1: the other tokens have their own verifier and are untouched.
        assertTrue(kits[FUND].eligibility.isEligible(alice));
        assertTrue(kits[NOTE].eligibility.isEligible(bob));

        // Restoring the policy restores the door.
        vm.prank(operator);
        kits[DEPOSIT].verifier.setTopicPolicy(SANCTIONS, address(sanctionsPolicy));
        assertAllAgree();
        vm.prank(bob);
        token.transfer(alice, 1 * UNIT);
        assertEq(token.balanceOf(alice), 101 * UNIT);
        assertAllAgree();
    }

    /// I8 variant: a topic whose schema mapping is cleared. Shibui returns false here (no revert);
    ///     explain must still say POLICY_MISSING, not NOT_REGISTERED.
    function test_I8_unmappedSchema_failsClosed_explainPolicyMissing() public {
        vm.prank(operator);
        kits[FUND].verifier.setTopicSchemaMapping(AML, bytes32(0));
        assertAllAgree();

        assertFalse(kits[FUND].verifier.isVerified(alice));
        assertFalse(kits[FUND].eligibility.isEligible(alice));
        assertStatus(FUND, alice, KYC, IEligibility.Status.OK, "I8: KYC fine");
        assertStatus(FUND, alice, AML, IEligibility.Status.POLICY_MISSING, "I8: unmapped schema is POLICY_MISSING");
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(issuer);
        kits[FUND].token.issue(alice, 1 * UNIT);
    }

    /// I8: a verifier whose identity proxy was never set (everything else wired, the credential registered).
    ///     Shibui reverts (IdentityProxyNotConfigured); the slot says no, views do not revert, money does not
    ///     move, and explain reports MISCONFIGURED. Setting the proxy is the only fix needed.
    function test_I8_unsetIdentityProxy_failsClosed_explainMisconfigured() public {
        Kit storage k = kits[DEPOSIT];
        RegulatedToken token = k.token;
        issueTo(DEPOSIT, alice, 100 * UNIT);
        assertAllAgree();
        issueTo(DEPOSIT, bob, 100 * UNIT);
        assertAllAgree();

        vm.startPrank(operator);
        EASClaimVerifier v2 = new EASClaimVerifier(operator);
        v2.setEASAddress(address(eas));
        v2.setTrustedIssuersAdapter(address(k.adapter));
        v2.setClaimTopicsRegistry(address(k.topicsRegistry));
        for (uint256 j = 0; j < k.topics.length; j++) {
            v2.setTopicSchemaMapping(k.topics[j], investorEligibilitySchema);
            v2.setTopicPolicy(k.topics[j], policyFor(DEPOSIT, k.topics[j]));
        }
        ShibuiEligibility e2 = new ShibuiEligibility(v2, operator);
        e2.watchAttester(providerA);
        vm.stopPrank();
        // Registration needs no proxy when the attester itself calls.
        for (uint256 j = 0; j < k.topics.length; j++) {
            vm.prank(providerA);
            v2.registerAttestation(alice, k.topics[j], aliceCredential);
            vm.prank(providerA);
            v2.registerAttestation(bob, k.topics[j], bobCredential);
        }

        vm.prank(operator);
        token.setEligibility(e2);
        k.verifier = v2; // keep the fixture's picture of the kit in sync for I9
        k.eligibility = e2;
        assertAllAgree();

        vm.expectRevert(IEASClaimVerifier.IdentityProxyNotConfigured.selector);
        v2.isVerified(alice);

        assertFalse(e2.isEligible(alice), "I8: unset proxy means not eligible");
        assertFalse(token.canReceive(alice), "I8: canReceive false, no revert");
        assertFalse(token.canSend(bob), "I8: canSend false, no revert");
        assertFalse(token.canTransfer(bob, alice, 1));

        IEligibility.TopicStatus[] memory st = e2.explain(alice);
        assertEq(st.length, 1, "I8: one MISCONFIGURED entry");
        assertEq(st[0].topic, 0);
        assertEq(uint256(st[0].status), uint256(IEligibility.Status.MISCONFIGURED), "I8: explain MISCONFIGURED");

        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(issuer);
        token.issue(alice, 1 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(compliance);
        token.forcedTransfer(bob, alice, 1 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, bob));
        vm.prank(bob);
        token.transfer(alice, 1 * UNIT);

        vm.prank(operator);
        v2.setIdentityProxy(address(identityProxy));
        assertAllAgree();
        assertTrue(e2.isEligible(alice), "I8: the proxy was the only missing piece");
        vm.prank(bob);
        token.transfer(alice, 1 * UNIT);
        assertAllAgree();
    }

    /// MISCONFIGURED appears only when the verifier lacks EAS, adapter, proxy or topics registry, and for each one
    /// of them alone. A fully wired verifier never reports it (assertExplainAgrees checks that in every test).
    function test_explain_MISCONFIGURED_exactlyWhenVerifierLacksWiring() public {
        string[5] memory label = ["no EAS", "no adapter", "no proxy", "no registry", "fully wired"];
        for (uint256 missing = 0; missing <= 4; missing++) {
            EASClaimVerifier v = _depositVerifierMissing(missing);
            vm.prank(operator);
            ShibuiEligibility e = new ShibuiEligibility(v, operator);

            IEligibility.TopicStatus[] memory st = e.explain(alice);
            assertFalse(e.isEligible(alice), label[missing]);
            if (missing < 4) {
                assertEq(st.length, 1, label[missing]);
                assertEq(uint256(st[0].status), uint256(IEligibility.Status.MISCONFIGURED), label[missing]);
            } else {
                assertEq(st.length, 2, label[missing]);
                // Wired, but Alice's credential was never registered on this new verifier.
                assertEq(uint256(st[0].status), uint256(IEligibility.Status.NOT_REGISTERED), label[missing]);
                assertEq(uint256(st[1].status), uint256(IEligibility.Status.NOT_REGISTERED), label[missing]);
            }
            assertExplainAgrees(e, alice);
            assertAllAgree();
        }
    }

    // ============ I10 ============

    /// I10: the fund and the note each own a CountryAllowListPolicy. Changing one never changes the other.
    function test_I10_countryAllowListChangeIsPerToken() public {
        assertTrue(address(kits[FUND].countryPolicy) != address(kits[NOTE].countryPolicy), "D1: separate policies");
        assertFalse(kits[FUND].eligibility.isEligible(dave));

        // Open the fund to country 156.
        vm.prank(operator);
        kits[FUND].countryPolicy.addCountry(CN);
        assertAllAgree();
        assertTrue(kits[FUND].eligibility.isEligible(dave), "I10: fund now admits 156");
        issueTo(FUND, dave, 10 * UNIT);
        assertAllAgree();
        assertFalse(kits[NOTE].eligibility.isEligible(dave), "I10: note unchanged");
        assertStatus(NOTE, dave, COUNTRY, IEligibility.Status.POLICY_REJECTED, "I10: note still rejects 156");
        assertTrue(kits[DEPOSIT].eligibility.isEligible(dave), "I10: deposit unchanged");
        assertAllAgree();

        // Close the note to country 840.
        issueTo(NOTE, bob, 10 * UNIT);
        assertAllAgree();
        vm.prank(operator);
        kits[NOTE].countryPolicy.removeCountry(US);
        assertAllAgree();
        assertFalse(kits[NOTE].eligibility.isEligible(bob), "I10: note no longer admits 840");
        assertStatus(NOTE, bob, COUNTRY, IEligibility.Status.POLICY_REJECTED, "I10: explain names COUNTRY");
        assertStatus(NOTE, bob, ACCREDITATION, IEligibility.Status.OK, "I10: accreditation still fine");
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, bob));
        vm.prank(bob);
        kits[NOTE].token.transfer(bob, 1 * UNIT);

        assertTrue(kits[FUND].eligibility.isEligible(bob), "I10: fund still admits 840");
        assertTrue(kits[FUND].eligibility.isEligible(alice), "I10: fund still admits 840");
        assertTrue(kits[FUND].countryPolicy.isInSet(US));
        issueTo(FUND, alice, 10 * UNIT);
        assertAllAgree();
    }

    // ============ helpers ============

    /// A fresh deposit-shaped verifier with one of its four wiring slots left empty (4 = none left empty).
    function _depositVerifierMissing(uint256 missing) internal returns (EASClaimVerifier v) {
        Kit storage k = kits[DEPOSIT];
        vm.startPrank(operator);
        v = new EASClaimVerifier(operator);
        if (missing != 0) v.setEASAddress(address(eas));
        if (missing != 1) v.setTrustedIssuersAdapter(address(k.adapter));
        if (missing != 2) v.setIdentityProxy(address(identityProxy));
        if (missing != 3) v.setClaimTopicsRegistry(address(k.topicsRegistry));
        for (uint256 j = 0; j < k.topics.length; j++) {
            v.setTopicSchemaMapping(k.topics[j], investorEligibilitySchema);
            v.setTopicPolicy(k.topics[j], policyFor(DEPOSIT, k.topics[j]));
        }
        vm.stopPrank();
    }
}
