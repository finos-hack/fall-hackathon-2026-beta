// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {KitFixture} from "../helpers/KitFixture.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";

/// @title CastTableIntegrationTest
/// @notice I1: the demo cast table holds end to end on real Shibui + real EAS, and explain says why (I9 throughout).
///
///                 tokenized-deposit   money-market-fund   private-credit-note
///         Alice   yes                 yes                 no  (accreditation)
///         Bob     yes                 yes                 yes
///         Carol   no  (KYC)           no  (KYC)           no  (KYC)
///         Dave    yes                 no  (country)       no  (country, accreditation)
contract CastTableIntegrationTest is KitFixture {
    function _expected(uint256 idx, address w) internal view returns (bool) {
        if (w == alice) return idx != NOTE;
        if (w == bob) return true;
        if (w == carol) return false;
        if (w == dave) return idx == DEPOSIT;
        revert("not in cast");
    }

    function _cast() internal view returns (address[4] memory) {
        return [alice, bob, carol, dave];
    }

    /// I1: 4 investors x 3 tokens. isEligible, canReceive and a real issue() all follow the table.
    ///     If any one of them drifts from the others, the kit would either refuse a valid investor or
    ///     (worse) let an ineligible one hold the token.
    function test_I1_castTable_isEligible_canReceive_and_issue() public {
        address[4] memory cast = _cast();
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            RegulatedToken token = kits[k].token;
            for (uint256 i = 0; i < cast.length; i++) {
                address w = cast[i];
                bool expected = _expected(k, w);
                string memory why = string.concat("I1 ", kits[k].templateId, " / ", _name(w));

                assertEq(kits[k].eligibility.isEligible(w), expected, why);
                assertEq(token.canReceive(w), expected, why);

                if (expected) {
                    issueTo(k, w, 100 * UNIT);
                    assertEq(token.balanceOf(w), 100 * UNIT, why);
                } else {
                    vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, w));
                    vm.prank(issuer);
                    token.issue(w, 100 * UNIT);
                    assertEq(token.balanceOf(w), 0, why);
                }
                assertAllAgree(); // I9 after every state change
            }
            assertEq(token.decimals(), 6, "every template uses 6 decimals");
        }
        assertEq(kits[DEPOSIT].token.symbol(), "dDEP");
        assertEq(kits[FUND].token.symbol(), "dMMF");
        assertEq(kits[NOTE].token.symbol(), "dPCN");
    }

    /// I1: the table also governs holder-to-holder transfers, not only issuance.
    function test_I1_castTable_governs_transfers_from_bob() public {
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            issueTo(k, bob, 100 * UNIT);
            assertAllAgree();
        }

        address[3] memory others = [alice, carol, dave];
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            RegulatedToken token = kits[k].token;
            for (uint256 i = 0; i < others.length; i++) {
                address to = others[i];
                assertEq(token.canTransfer(bob, to, 1 * UNIT), _expected(k, to), "I1 canTransfer follows the table");
                if (_expected(k, to)) {
                    vm.prank(bob);
                    token.transfer(to, 1 * UNIT);
                    assertEq(token.balanceOf(to), 1 * UNIT);
                } else {
                    vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, to));
                    vm.prank(bob);
                    token.transfer(to, 1 * UNIT);
                }
                assertAllAgree();
            }
        }
    }

    /// I1 + explain: each refusal carries the reason the table gives, topic by topic.
    function test_I1_explain_gives_the_tables_reasons() public view {
        // Alice: one clean credential, accreditation NONE.
        assertEveryTopic(DEPOSIT, alice, IEligibility.Status.OK, "alice deposit");
        assertEveryTopic(FUND, alice, IEligibility.Status.OK, "alice fund");
        assertStatus(NOTE, alice, KYC, IEligibility.Status.OK, "alice note KYC");
        assertStatus(NOTE, alice, COUNTRY, IEligibility.Status.OK, "alice note COUNTRY");
        // Required by the plan: POLICY_REJECTED for Alice on the credit note ACCREDITATION topic.
        assertStatus(NOTE, alice, ACCREDITATION, IEligibility.Status.POLICY_REJECTED, "alice note ACCREDITATION");

        // Bob: accredited, passes everything.
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertEveryTopic(k, bob, IEligibility.Status.OK, "bob");
        }

        // Carol: no credential anywhere -> NOT_REGISTERED on every topic of every token.
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            assertEveryTopic(k, carol, IEligibility.Status.NOT_REGISTERED, "carol");
        }

        // Dave: country 156 is outside both allow-lists.
        assertEveryTopic(DEPOSIT, dave, IEligibility.Status.OK, "dave deposit");
        assertStatus(FUND, dave, KYC, IEligibility.Status.OK, "dave fund KYC");
        assertStatus(FUND, dave, AML, IEligibility.Status.OK, "dave fund AML");
        assertStatus(FUND, dave, COUNTRY, IEligibility.Status.POLICY_REJECTED, "dave fund COUNTRY");
        assertStatus(NOTE, dave, KYC, IEligibility.Status.OK, "dave note KYC");
        assertStatus(NOTE, dave, COUNTRY, IEligibility.Status.POLICY_REJECTED, "dave note COUNTRY");
        assertStatus(NOTE, dave, ACCREDITATION, IEligibility.Status.POLICY_REJECTED, "dave note ACCREDITATION");

        assertAllAgree();
    }

    /// The fixture wired exactly what the plan says (D1): shared EAS/proxy, per-token verifier/registry/adapter,
    /// provider A trusted for exactly each template's topics and watched by each slot.
    function test_fixture_wiring_matches_plan() public view {
        for (uint256 k = 0; k < KIT_COUNT; k++) {
            Kit storage kit = kits[k];
            assertEq(kit.verifier.getEASAddress(), address(eas));
            assertEq(kit.verifier.getIdentityProxy(), address(identityProxy));
            assertEq(kit.verifier.getTrustedIssuersAdapter(), address(kit.adapter));
            assertEq(kit.verifier.getClaimTopicsRegistry(), address(kit.topicsRegistry));
            assertEq(kit.adapter.getEASAddress(), address(eas));
            assertEq(kit.adapter.getIssuerAuthSchemaUID(), issuerAuthSchema);
            assertEq(kit.adapter.getAttesterTopics(providerA), kit.topics);
            assertEq(kit.topicsRegistry.getClaimTopics(), kit.topics);
            assertEq(address(kit.eligibility.verifier()), address(kit.verifier));
            assertEq(kit.eligibility.owner(), operator);
            address[] memory watched = kit.eligibility.watchedAttesters();
            assertEq(watched.length, 1);
            assertEq(watched[0], providerA);
            for (uint256 j = 0; j < kit.topics.length; j++) {
                assertEq(kit.verifier.getSchemaUID(kit.topics[j]), investorEligibilitySchema);
                assertEq(kit.verifier.getTopicPolicy(kit.topics[j]), policyFor(k, kit.topics[j]));
            }
            assertTrue(kit.token.hasRole(kit.token.ISSUER_ROLE(), issuer));
            assertTrue(kit.token.hasRole(kit.token.COMPLIANCE_ROLE(), compliance));
            assertTrue(kit.token.hasRole(kit.token.DEFAULT_ADMIN_ROLE(), operator));
            for (uint256 m = k + 1; m < KIT_COUNT; m++) {
                assertTrue(address(kit.verifier) != address(kits[m].verifier), "D1: one verifier per token");
                assertTrue(address(kit.adapter) != address(kits[m].adapter), "D1: one adapter per token");
            }
        }
        assertTrue(resolver.isAuthorizer(operator));
        assertEq(resolver.getAuthorizers().length, 1, "operator is the only resolver authorizer");
        assertEq(address(schemaRegistry.getSchema(issuerAuthSchema).resolver), address(resolver));
        assertEq(address(schemaRegistry.getSchema(investorEligibilitySchema).resolver), address(0));
        assertTrue(schemaRegistry.getSchema(investorEligibilitySchema).revocable);
        // One credential per investor: the same UID is registered across tokens.
        assertEq(kits[DEPOSIT].verifier.getRegisteredAttestation(alice, KYC, providerA), aliceCredential);
        assertEq(kits[FUND].verifier.getRegisteredAttestation(alice, KYC, providerA), aliceCredential);
        assertEq(kits[NOTE].verifier.getRegisteredAttestation(alice, KYC, providerA), aliceCredential);
    }
}
