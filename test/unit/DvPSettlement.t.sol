// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DvPSettlement} from "../../contracts/DvPSettlement.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";
import {MockEligibility} from "../mocks/MockEligibility.sol";

/// @dev Issue #5, S6 (decision D-A): delivery versus payment between two RegulatedTokens with different eligibility
///      slots. A fund share (`fund`) against a tokenized deposit (`cash`). Bob sells, Alice buys. Dave is eligible
///      for the deposit but not for the fund.
contract DvPSettlementTest is Test {
    DvPSettlement internal dvp;
    RegulatedToken internal fund;
    RegulatedToken internal cash;
    MockEligibility internal fundSlot;
    MockEligibility internal cashSlot;

    address internal operator = makeAddr("operator");
    address internal issuer = makeAddr("issuer");
    address internal compliance = makeAddr("compliance");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal dave = makeAddr("dave");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant UNIT = 1e6;
    bytes32 internal constant REF = keccak256("cdm TransferInstruction");

    function setUp() public {
        dvp = new DvPSettlement();
        fundSlot = new MockEligibility();
        cashSlot = new MockEligibility();
        fund = _token("Demo Money Market Fund Share", "dMMF", fundSlot);
        cash = _token("Demo Tokenized Deposit", "dDEP", cashSlot);
        for (uint256 i; i < 3; ++i) {
            address w = [alice, bob, dave][i];
            cashSlot.setEligible(w, true);
            if (w != dave) fundSlot.setEligible(w, true);
        }
        vm.startPrank(issuer);
        fund.issue(bob, 500 * UNIT);
        cash.issue(alice, 1_000 * UNIT);
        cash.issue(dave, 1_000 * UNIT);
        vm.stopPrank();
    }

    function _token(string memory name, string memory symbol, MockEligibility slot) internal returns (RegulatedToken t) {
        t = new RegulatedToken(name, symbol, 6, operator, slot);
        bytes32 issuerRole = t.ISSUER_ROLE();
        bytes32 complianceRole = t.COMPLIANCE_ROLE();
        vm.startPrank(operator);
        t.grantRole(issuerRole, issuer);
        t.grantRole(complianceRole, compliance);
        vm.stopPrank();
    }

    function _legs(address buyer, uint256 shares, uint256 price)
        internal
        view
        returns (DvPSettlement.Leg memory delivery, DvPSettlement.Leg memory payment)
    {
        delivery = DvPSettlement.Leg(address(fund), bob, buyer, shares);
        payment = DvPSettlement.Leg(address(cash), buyer, bob, price);
    }

    /// Bob approves and proposes; the buyer approves. Returns the trade id.
    function _propose(address buyer, uint256 shares, uint256 price) internal returns (bytes32 id) {
        (DvPSettlement.Leg memory d, DvPSettlement.Leg memory p) = _legs(buyer, shares, price);
        vm.prank(bob);
        fund.approve(address(dvp), shares);
        vm.prank(buyer);
        cash.approve(address(dvp), price);
        vm.prank(bob);
        id = dvp.propose(d, p, uint64(block.timestamp + 1 days), REF);
    }

    function test_settlesBothLegsInOneTransaction() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        vm.expectEmit(true, true, false, true, address(dvp));
        emit DvPSettlement.TradeSettled(id, REF, alice);
        vm.prank(alice);
        dvp.affirm(id);
        assertEq(fund.balanceOf(alice), 100 * UNIT);
        assertEq(fund.balanceOf(bob), 400 * UNIT);
        assertEq(cash.balanceOf(bob), 100 * UNIT);
        assertEq(cash.balanceOf(alice), 900 * UNIT);
        assertEq(uint8(dvp.trade(id).state), uint8(DvPSettlement.State.Settled));
        assertEq(fund.balanceOf(address(dvp)) + cash.balanceOf(address(dvp)), 0, "never holds tokens");
    }

    function test_refusalOnOneLegRevertsBoth() public {
        bytes32 id = _propose(dave, 100 * UNIT, 100 * UNIT);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, dave));
        dvp.affirm(id);
        assertEq(cash.balanceOf(dave), 1_000 * UNIT, "the cash leg did not move");
        assertEq(fund.balanceOf(bob), 500 * UNIT, "the delivery leg did not move");
        assertEq(uint8(dvp.trade(id).state), uint8(DvPSettlement.State.Proposed), "still open, nothing settled");
    }

    function test_refusalOnThePaymentLegRevertsBoth() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        cashSlot.setEligible(bob, false); // the seller may no longer receive the deposit token
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, bob));
        dvp.affirm(id);
        assertEq(fund.balanceOf(alice), 0);
    }

    function test_pausedOrFrozenLegReverts() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        vm.prank(compliance);
        fund.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dvp.affirm(id);
        vm.prank(compliance);
        fund.unpause();
        vm.prank(compliance);
        fund.setFrozenTokens(bob, 450 * UNIT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943InsufficientUnfrozenBalance.selector, bob, 100 * UNIT, 50 * UNIT));
        dvp.affirm(id);
    }

    function test_missingApprovalRefused() public {
        (DvPSettlement.Leg memory d, DvPSettlement.Leg memory p) = _legs(alice, 100 * UNIT, 100 * UNIT);
        vm.prank(bob);
        fund.approve(address(dvp), 100 * UNIT);
        vm.prank(bob);
        bytes32 id = dvp.propose(d, p, uint64(block.timestamp + 1 days), REF);
        vm.prank(alice); // Alice never approved her cash leg
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(dvp), 0, 100 * UNIT));
        dvp.affirm(id);
    }

    function test_onlyTheCounterpartyAffirms() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.OwnProposal.selector, id));
        dvp.affirm(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.NotAParty.selector, stranger));
        dvp.affirm(id);
    }

    function test_onlyAPartyProposes() public {
        (DvPSettlement.Leg memory d, DvPSettlement.Leg memory p) = _legs(alice, 1, 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.NotAParty.selector, stranger));
        dvp.propose(d, p, uint64(block.timestamp + 1), REF);
    }

    function test_legsMustMirrorEachOther() public {
        DvPSettlement.Leg memory d = DvPSettlement.Leg(address(fund), bob, alice, 1);
        DvPSettlement.Leg[5] memory bad = [
            DvPSettlement.Leg(address(cash), alice, dave, 1), // pays someone else
            DvPSettlement.Leg(address(fund), alice, bob, 1), // same token on both legs
            DvPSettlement.Leg(address(cash), alice, bob, 0), // zero amount
            DvPSettlement.Leg(address(0), alice, bob, 1), // no token
            DvPSettlement.Leg(address(cash), dave, bob, 1) // the buyer is not the payer
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bob);
            vm.expectRevert(DvPSettlement.InvalidLegs.selector);
            dvp.propose(d, bad[i], uint64(block.timestamp + 1), REF);
        }
    }

    function test_expiredTradeCannotSettle() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.Expired.selector, id));
        dvp.affirm(id);
        (DvPSettlement.Leg memory d, DvPSettlement.Leg memory p) = _legs(alice, 1, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.Expired.selector, bytes32(0)));
        dvp.propose(d, p, uint64(block.timestamp), REF);
    }

    function test_cancelThenNoSettlement() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        vm.prank(alice);
        dvp.cancel(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.NotProposed.selector, id));
        dvp.affirm(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.NotProposed.selector, id));
        dvp.cancel(id);
    }

    function test_strangerCannotCancel() public {
        bytes32 id = _propose(alice, 100 * UNIT, 100 * UNIT);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.NotAParty.selector, stranger));
        dvp.cancel(id);
    }

    function test_settledTradeCannotSettleTwice() public {
        bytes32 id = _propose(alice, 10 * UNIT, 10 * UNIT);
        vm.prank(alice);
        dvp.affirm(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DvPSettlement.NotProposed.selector, id));
        dvp.affirm(id);
    }

    function test_eachProposalHasItsOwnId() public {
        bytes32 a = _propose(alice, 1, 1);
        bytes32 b = _propose(alice, 1, 1);
        assertTrue(a != b);
    }

    /// Fuzz: whatever the amounts and eligibility, balances are conserved, the contract holds nothing, and either
    /// both legs moved or neither did.
    function testFuzz_bothOrNeither(uint256 shares, uint256 price, bool buyerEligible, bool sellerEligible) public {
        shares = bound(shares, 1, 600 * UNIT); // may exceed Bob's 500: then the delivery leg must refuse
        price = bound(price, 1, 1_200 * UNIT); // may exceed Alice's 1,000
        fundSlot.setEligible(alice, buyerEligible);
        cashSlot.setEligible(bob, sellerEligible);
        uint256 fundTotal = fund.totalSupply();
        uint256 cashTotal = cash.totalSupply();
        bytes32 id = _propose(alice, shares, price);
        vm.prank(alice);
        (bool ok,) = address(dvp).call(abi.encodeCall(DvPSettlement.affirm, (id)));
        bool expectOk = buyerEligible && sellerEligible && shares <= 500 * UNIT && price <= 1_000 * UNIT;
        assertEq(ok, expectOk);
        assertEq(fund.balanceOf(alice), ok ? shares : 0);
        assertEq(cash.balanceOf(bob), ok ? price : 0);
        assertEq(fund.balanceOf(alice) + fund.balanceOf(bob), fundTotal);
        assertEq(cash.balanceOf(alice) + cash.balanceOf(bob) + cash.balanceOf(dave), cashTotal);
        assertEq(fund.balanceOf(address(dvp)) + cash.balanceOf(address(dvp)), 0);
    }
}
