// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {MockEligibility} from "../mocks/MockEligibility.sol";
import {RegulatedTokenHandler} from "./RegulatedTokenHandler.sol";

/// @title RegulatedTokenInvariantTest
/// @notice Milestone M1 invariants F1-F3 for RegulatedToken against a mock slot, under random sequences of
///         issue, redeem, transfer, transferFrom, freeze, forced transfer, pause and eligibility changes.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = true
contract RegulatedTokenInvariantTest is StdInvariant, Test {
    RegulatedToken internal token;
    MockEligibility internal slot;
    RegulatedTokenHandler internal handler;
    address[] internal actors;

    function setUp() public {
        address operator = makeAddr("operator");
        address issuer = makeAddr("issuer");
        address compliance = makeAddr("compliance");
        // Fictional cast. alice, bob and dave start eligible, carol and erin do not.
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        actors.push(makeAddr("dave"));
        actors.push(makeAddr("erin"));

        slot = new MockEligibility();
        token = new RegulatedToken("Demo Private Credit Note", "dPCN", 6, operator, slot);
        bytes32 issuerRole = token.ISSUER_ROLE();
        bytes32 complianceRole = token.COMPLIANCE_ROLE();
        vm.startPrank(operator);
        token.grantRole(issuerRole, issuer);
        token.grantRole(complianceRole, compliance);
        vm.stopPrank();
        slot.setEligible(actors[0], true);
        slot.setEligible(actors[1], true);
        slot.setEligible(actors[3], true);

        handler = new RegulatedTokenHandler(token, slot, issuer, compliance, actors);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = RegulatedTokenHandler.issue.selector;
        selectors[1] = RegulatedTokenHandler.issue.selector; // weighted: supply has to exist before it can move
        selectors[2] = RegulatedTokenHandler.redeem.selector;
        selectors[3] = RegulatedTokenHandler.transfer.selector;
        selectors[4] = RegulatedTokenHandler.transferFrom.selector;
        selectors[5] = RegulatedTokenHandler.freeze.selector;
        selectors[6] = RegulatedTokenHandler.forcedTransfer.selector;
        selectors[7] = RegulatedTokenHandler.setEligible.selector;
        selectors[8] = RegulatedTokenHandler.setSlotMode.selector;
        selectors[9] = RegulatedTokenHandler.togglePause.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// F1: a balance only ever increases for a wallet that is eligible at that moment.
    function invariant_F1_balanceOnlyGrowsForEligibleWallet() public view {
        assertEq(handler.f1Violations(), 0, "a balance grew for a wallet the slot did not say yes to");
    }

    /// F2: totalSupply == issued - redeemed == sum of the balances of the tracked actors.
    function invariant_F2_supplyEqualsIssuedMinusRedeemedEqualsSumOfBalances() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += token.balanceOf(actors[i]);
        }
        assertEq(token.totalSupply(), handler.ghostIssued() - handler.ghostRedeemed(), "supply != issued - redeemed");
        assertEq(token.totalSupply(), sum, "supply != sum of balances");
    }

    /// F3: the transferable (unfrozen) amount is balance - frozen floored at zero, and canTransfer is false
    ///     whenever the amount exceeds it. When nothing else stands in the way, canTransfer is true at exactly
    ///     that amount, which pins the token's notion of "unfrozen" to balance - frozen.
    function invariant_F3_unfrozenIsBalanceMinusFrozen() public view {
        assertEq(handler.f3Violations(), 0, "a holder-side move succeeded above balance - frozen");
        bool paused = token.paused();
        for (uint256 i; i < actors.length; ++i) {
            address from = actors[i];
            uint256 bal = token.balanceOf(from);
            uint256 frozen = token.getFrozenTokens(from);
            uint256 unfrozen = bal > frozen ? bal - frozen : 0;
            assertLe(unfrozen, bal);
            for (uint256 j; j < actors.length; ++j) {
                address to = actors[j];
                assertFalse(token.canTransfer(from, to, unfrozen + 1), "canTransfer above the unfrozen amount");
                if (!paused && slot.answersYes(from) && slot.answersYes(to)) {
                    assertTrue(token.canTransfer(from, to, unfrozen), "canTransfer refused the unfrozen amount");
                }
            }
        }
    }

    /// U6 under random sequences: canTransfer agreed with every transfer and transferFrom the handler made.
    function invariant_canTransferPredictsTransfer() public view {
        assertEq(handler.canTransferMismatches(), 0, "canTransfer disagreed with transfer");
    }

    /// Not an assertion: shows in -vv output how many actions of each kind succeeded, so a run that never
    /// moved tokens would be noticed.
    function afterInvariant() public {
        string[7] memory names =
            ["issue", "redeem", "transfer", "transferFrom", "freeze", "forcedTransfer", "togglePause"];
        for (uint256 i; i < names.length; ++i) {
            emit log_named_uint(names[i], handler.successes(bytes32(bytes(names[i]))));
        }
    }
}
