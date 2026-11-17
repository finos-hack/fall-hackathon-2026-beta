// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {MockEligibility} from "../mocks/MockEligibility.sol";

/// @title RegulatedTokenHandler
/// @notice Drives a RegulatedToken through random sequences of every role's actions for the M1 invariants.
///         Every action is wrapped in try/catch, so a refused action is a normal outcome, not a failed run.
///         The handler keeps ghost totals (F2) and counts rule breaks it can only see during an action
///         (F1, F3, and canTransfer/transfer agreement). The invariant contract asserts those counters stay 0.
/// @dev Tokens only ever reach the fixed actor set, so "sum of actor balances" covers every holder (F2).
contract RegulatedTokenHandler is Test {
    RegulatedToken public immutable token;
    MockEligibility public immutable slot;
    address public immutable issuer;
    address public immutable compliance;

    address[] internal _actors;

    /// @dev Upper bound per issuance; with the default depth the supply stays far from uint256 overflow.
    uint256 internal constant MAX_ISSUE = 1e30;

    // ---------- ghost state ----------
    uint256 public ghostIssued;
    uint256 public ghostRedeemed;

    /// F1: a balance went up for a wallet the slot did not say yes to at that moment.
    uint256 public f1Violations;
    /// F3: a holder-side move (transfer, transferFrom, redeem) succeeded above the wallet's balance - frozen.
    uint256 public f3Violations;
    /// U6 consistency: canTransfer(from, to, amount) disagreed with what transfer/transferFrom then did.
    uint256 public canTransferMismatches;

    /// Successful calls per action, logged by the invariant test so a run that never moves tokens is visible.
    mapping(bytes32 => uint256) public successes;

    constructor(
        RegulatedToken token_,
        MockEligibility slot_,
        address issuer_,
        address compliance_,
        address[] memory actors_
    ) {
        token = token_;
        slot = slot_;
        issuer = issuer_;
        compliance = compliance_;
        _actors = actors_;
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    // ---------- F1 bookkeeping ----------

    /// @dev Snapshot every actor's balance, run the action, then flag any increase for a wallet the slot did
    ///      not say yes to. Uses the mock's own answer (ground truth), not the token's reading of it.
    modifier watchIncreases() {
        uint256 n = _actors.length;
        uint256[] memory before = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            before[i] = token.balanceOf(_actors[i]);
        }
        _;
        for (uint256 i; i < n; ++i) {
            address a = _actors[i];
            if (token.balanceOf(a) > before[i] && !slot.answersYes(a)) ++f1Violations;
        }
    }

    // ---------- actions ----------

    function issue(uint256 toSeed, uint256 amount) external watchIncreases {
        address to = _actor(toSeed);
        amount = _bound(amount, 0, MAX_ISSUE);
        vm.prank(issuer);
        try token.issue(to, amount) {
            ghostIssued += amount;
            ++successes["issue"];
        } catch {}
    }

    function redeem(uint256 fromSeed, uint256 amount) external watchIncreases {
        address from = _actor(fromSeed);
        amount = _bound(amount, 0, token.balanceOf(from) + 1);
        uint256 unfrozen = _unfrozen(from);
        vm.prank(issuer);
        try token.redeem(from, amount) {
            ghostRedeemed += amount;
            if (amount > unfrozen) ++f3Violations;
            ++successes["redeem"];
        } catch {}
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external watchIncreases {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = _bound(amount, 0, token.balanceOf(from) + 1);
        uint256 unfrozen = _unfrozen(from);
        bool predicted = token.canTransfer(from, to, amount);
        bool ok;
        vm.prank(from);
        try token.transfer(to, amount) returns (bool r) {
            ok = r;
        } catch {}
        if (ok != predicted) ++canTransferMismatches;
        if (ok && amount > unfrozen) ++f3Violations;
        if (ok) ++successes["transfer"];
    }

    function transferFrom(uint256 spenderSeed, uint256 fromSeed, uint256 toSeed, uint256 amount)
        external
        watchIncreases
    {
        address spender = _actor(spenderSeed);
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = _bound(amount, 0, token.balanceOf(from) + 1);
        vm.prank(from);
        token.approve(spender, type(uint256).max); // approve never moves a balance and is not gated
        uint256 unfrozen = _unfrozen(from);
        bool predicted = token.canTransfer(from, to, amount);
        bool ok;
        vm.prank(spender);
        try token.transferFrom(from, to, amount) returns (bool r) {
            ok = r;
        } catch {}
        if (ok != predicted) ++canTransferMismatches;
        if (ok && amount > unfrozen) ++f3Violations;
        if (ok) ++successes["transferFrom"];
    }

    function freeze(uint256 seed, uint256 amount) external watchIncreases {
        address account = _actor(seed);
        // Sometimes below, sometimes above the balance: the frozen amount may exceed it (U3).
        amount = _bound(amount, 0, token.balanceOf(account) * 2 + 10);
        vm.prank(compliance);
        try token.setFrozenTokens(account, amount) {
            ++successes["freeze"];
        } catch {}
    }

    function forcedTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external watchIncreases {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = _bound(amount, 0, token.balanceOf(from) + 1);
        vm.prank(compliance);
        try token.forcedTransfer(from, to, amount) {
            ++successes["forcedTransfer"];
        } catch {}
    }

    /// @dev Grants three times out of four so holders exist, and still revokes often enough that tokens sit
    ///      with wallets that are no longer eligible (the case F1 and U7 care about).
    function setEligible(uint256 seed, uint8 coin) external watchIncreases {
        slot.setEligible(_actor(seed), coin % 4 != 0);
    }

    /// @dev Mostly keeps the slot well-behaved so tokens keep moving; sometimes breaks it so the fail-closed
    ///      paths are exercised mid-sequence. BurnGas is left to the unit tests: each call to it costs 63/64
    ///      of the remaining gas, which would starve the invariant checks rather than test the token.
    function setSlotMode(uint8 seed) external watchIncreases {
        uint256 pick = _bound(seed, 0, 15);
        MockEligibility.Mode m = MockEligibility.Mode.Answer;
        if (pick == 1) m = MockEligibility.Mode.Revert;
        else if (pick == 2) m = MockEligibility.Mode.ReturnEmpty;
        else if (pick == 3) m = MockEligibility.Mode.ReturnGarbage;
        else if (pick == 4) m = MockEligibility.Mode.ReturnShort;
        slot.setMode(m);
    }

    /// @dev Unpauses whenever paused, pauses one time in four, so most of a sequence runs unpaused and tokens
    ///      keep moving, while every sequence still has a fair chance of a paused stretch.
    function togglePause(uint8 seed) external watchIncreases {
        bool isPaused = token.paused(); // read first: a prank applies to the very next external call
        if (!isPaused && seed % 4 != 0) return;
        vm.prank(compliance);
        if (isPaused) {
            token.unpause();
        } else {
            token.pause();
        }
        ++successes["togglePause"];
    }

    // ---------- helpers ----------

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _unfrozen(address account) internal view returns (uint256) {
        uint256 bal = token.balanceOf(account);
        uint256 frozen = token.getFrozenTokens(account);
        return bal > frozen ? bal - frozen : 0;
    }
}
