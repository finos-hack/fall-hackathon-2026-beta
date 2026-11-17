// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {KitFixture} from "../helpers/KitFixture.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";

/// @title CredentialLifecycleIntegrationTest
/// @notice I2 (one credential, updated credential), I3 (revocation on EAS), I4 (expiry, both kinds).
///         Real EAS, real Shibui. I9 (explain agrees with enforcement) is asserted after every state change.
contract CredentialLifecycleIntegrationTest is KitFixture {
    address internal erin = makeAddr("erin"); // extra fictional counterparty, eligible on every token
    bytes32 internal erinCredential;

    function setUp() public override {
        super.setUp();
        erinCredential = onboard(providerA, erin, credential(GB, ACC_QUALIFIED_PURCHASER));
        track(erin);
        assertAllAgree();
    }

    // ============ I2 ============

    /// I2: ONE credential serves the deposit and the fund. The credit note opens only once the provider issues an
    ///     UPDATED credential carrying an accreditation AND registers it: an attestation alone changes nothing,
    ///     because Shibui only reads UIDs that were registered with the verifier.
    function test_I2_oneCredentialServesDepositAndFund_noteOpensOnlyAfterUpdatedCredentialIsRegistered() public {
        // The same UID backs every topic of both tokens.
        for (uint256 k = 0; k < 2; k++) {
            for (uint256 j = 0; j < kits[k].topics.length; j++) {
                assertEq(
                    kits[k].verifier.getRegisteredAttestation(alice, kits[k].topics[j], providerA),
                    aliceCredential,
                    "I2: one credential, registered on every topic of deposit and fund"
                );
            }
        }
        assertTrue(kits[DEPOSIT].eligibility.isEligible(alice));
        assertTrue(kits[FUND].eligibility.isEligible(alice));
        assertFalse(kits[NOTE].eligibility.isEligible(alice));
        assertStatus(NOTE, alice, ACCREDITATION, IEligibility.Status.POLICY_REJECTED, "I2: note refuses NONE");

        // The provider writes an updated credential: accreditation ACCREDITED. Not registered yet.
        bytes32 updated = attest(providerA, alice, credential(US, ACC_ACCREDITED));
        assertTrue(updated != aliceCredential);
        assertAllAgree();
        assertFalse(kits[NOTE].eligibility.isEligible(alice), "I2: an unregistered attestation must not open the note");
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, alice));
        vm.prank(issuer);
        kits[NOTE].token.issue(alice, 10 * UNIT);

        // Registration (W2 step 2) is what opens the door.
        register(providerA, alice, updated);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertTrue(kits[k].eligibility.isEligible(alice), "I2: updated credential serves all three tokens");
            assertEveryTopic(k, alice, IEligibility.Status.OK, "I2: all topics OK after update");
            assertEq(kits[k].verifier.getRegisteredAttestation(alice, KYC, providerA), updated);
        }
        issueTo(NOTE, alice, 10 * UNIT);
        assertEq(kits[NOTE].token.balanceOf(alice), 10 * UNIT);
        assertAllAgree();

        // Revoking the superseded credential is harmless: nothing points at it any more.
        revoke(providerA, aliceCredential);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertTrue(kits[k].eligibility.isEligible(alice), "I2: revoking the old credential does not matter");
        }
    }

    // ============ I3 ============

    /// I3: the provider revokes Bob's credential on EAS. With no action on any token, the very next transfer
    ///     involving Bob fails on all three, and explain says REVOKED for every topic of every token.
    function test_I3_revocationOnEAS_blocksNextTransferOnEveryToken() public {
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            issueTo(k, bob, 100 * UNIT);
            issueTo(k, erin, 100 * UNIT);
            vm.prank(bob);
            kits[k].token.transfer(erin, 1 * UNIT); // works before revocation
            assertAllAgree();
        }

        revoke(providerA, bobCredential); // W6: one EAS call, no token touched
        assertTrue(eas.getAttestation(bobCredential).revocationTime != 0);
        assertAllAgree();

        for (uint256 k = 0; k < KIT_COUNT; k++) {
            RegulatedToken token = kits[k].token;
            assertFalse(kits[k].eligibility.isEligible(bob), "I3: revoked credential is not eligible");
            assertFalse(token.canReceive(bob));
            assertFalse(token.canTransfer(bob, erin, 1 * UNIT));

            vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, bob));
            vm.prank(bob);
            token.transfer(erin, 1 * UNIT);

            vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, bob));
            vm.prank(erin);
            token.transfer(bob, 1 * UNIT);

            assertEveryTopic(k, bob, IEligibility.Status.REVOKED, "I3: explain says REVOKED on every topic");

            // Erin, whose credential was not revoked, is unaffected: she can still receive and send.
            issueTo(k, erin, 1 * UNIT);
            vm.prank(erin);
            token.transfer(erin, 1 * UNIT);
            assertTrue(kits[k].eligibility.isEligible(erin));
            assertAllAgree();
        }
    }

    // ============ I4 ============

    /// I4(a): EAS-level expirationTime. Eligible up to the last second, refused from the expiry second on
    ///        (Shibui treats expirationTime <= block.timestamp as expired); explain says EXPIRED.
    function test_I4a_easLevelExpiration_blocksTransfersAfterWarp() public {
        address frank = makeAddr("frank");
        track(frank);
        Credential memory c = credential(US, ACC_ACCREDITED);
        c.easExpirationTime = uint64(block.timestamp + 30 days);
        c.expirationTimestamp = 0; // isolate the EAS-level check
        onboard(providerA, frank, c);
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            issueTo(k, frank, 100 * UNIT);
            assertAllAgree();
        }

        vm.warp(c.easExpirationTime - 1);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            vm.prank(frank);
            kits[k].token.transfer(erin, 1 * UNIT); // still valid one second before expiry
            assertAllAgree();
        }

        vm.warp(c.easExpirationTime);
        assertAllAgree();
        _assertExpiredEverywhere(frank);
    }

    /// I4(b): the payload's own expirationTimestamp (EAS attestation never expires). The topic policies reject it,
    ///        and explain must still say EXPIRED rather than a generic POLICY_REJECTED.
    function test_I4b_payloadExpirationTimestamp_blocksTransfersAfterWarp() public {
        address frank = makeAddr("frank");
        track(frank);
        Credential memory c = credential(US, ACC_ACCREDITED);
        c.easExpirationTime = 0;
        c.expirationTimestamp = uint64(block.timestamp + 30 days);
        onboard(providerA, frank, c);
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            issueTo(k, frank, 100 * UNIT);
            assertAllAgree();
        }

        vm.warp(c.expirationTimestamp - 1);
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            vm.prank(frank);
            kits[k].token.transfer(erin, 1 * UNIT);
            assertAllAgree();
        }

        vm.warp(c.expirationTimestamp);
        assertAllAgree();
        _assertExpiredEverywhere(frank);
    }

    /// I4: a fresh credential after expiry restores eligibility (the provider re-attests, W2 again).
    function test_I4_reattestationAfterExpiryRestoresEligibility() public {
        address frank = makeAddr("frank");
        track(frank);
        Credential memory c = credential(US, ACC_ACCREDITED);
        c.easExpirationTime = uint64(block.timestamp + 1 days);
        onboard(providerA, frank, c);
        vm.warp(block.timestamp + 2 days);
        assertAllAgree();
        _assertExpiredEverywhere(frank);

        onboard(providerA, frank, credential(US, ACC_ACCREDITED));
        assertAllAgree();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertTrue(kits[k].eligibility.isEligible(frank), "I4: re-attested investor is eligible again");
        }
    }

    function _assertExpiredEverywhere(address w) internal {
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            RegulatedToken token = kits[k].token;
            assertFalse(kits[k].eligibility.isEligible(w), "I4: expired credential is not eligible");
            assertFalse(token.canReceive(w));

            if (token.balanceOf(w) > 0) {
                vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, w));
                vm.prank(w);
                token.transfer(erin, 1 * UNIT);
            }
            vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, w));
            vm.prank(erin);
            token.transfer(w, 1 * UNIT);

            assertEveryTopic(k, w, IEligibility.Status.EXPIRED, "I4: explain says EXPIRED on every topic");
        }
    }
}
