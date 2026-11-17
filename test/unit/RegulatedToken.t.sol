// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {IERC7943Fungible} from "../../contracts/interfaces/IERC7943Fungible.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";
import {MockEligibility} from "../mocks/MockEligibility.sol";

/// @dev Shared fixture for milestone M1: one RegulatedToken wired to a MockEligibility slot.
///      Cast (fictional): operator = DEFAULT_ADMIN_ROLE, issuer = ISSUER_ROLE, compliance = COMPLIANCE_ROLE,
///      alice and bob are eligible, carol never is, stranger holds no role.
abstract contract RegulatedTokenFixture is Test {
    RegulatedToken internal token;
    MockEligibility internal slot;

    address internal operator = makeAddr("operator");
    address internal issuer = makeAddr("issuer");
    address internal compliance = makeAddr("compliance");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    bytes32 internal ISSUER;
    bytes32 internal COMPLIANCE;
    bytes32 internal constant ADMIN = 0x00; // DEFAULT_ADMIN_ROLE

    uint8 internal constant DECIMALS = 6;
    uint256 internal constant UNIT = 10 ** DECIMALS;
    /// @dev Large enough for real amounts, small enough that sums in fuzz tests never overflow.
    uint256 internal constant MAX_AMOUNT = 1e36;
    /// @dev Gas budget of one real transaction, for calls into a slot that burns all the gas it is given.
    uint256 internal constant TX_GAS = 30_000_000;

    function setUp() public virtual {
        slot = new MockEligibility();
        token = new RegulatedToken("Demo Tokenized Deposit", "dDEP", DECIMALS, operator, slot);
        // Read the role ids before pranking: a prank applies to the very next call, including a getter.
        ISSUER = token.ISSUER_ROLE();
        COMPLIANCE = token.COMPLIANCE_ROLE();
        vm.startPrank(operator);
        token.grantRole(ISSUER, issuer);
        token.grantRole(COMPLIANCE, compliance);
        vm.stopPrank();
        slot.setEligible(alice, true);
        slot.setEligible(bob, true);
    }

    // ---------- helpers ----------

    function _issue(address to, uint256 amount) internal {
        vm.prank(issuer);
        token.issue(to, amount);
    }

    function _freeze(address account, uint256 amount) internal {
        vm.prank(compliance);
        token.setFrozenTokens(account, amount);
    }

    function _pause() internal {
        vm.prank(compliance);
        token.pause();
    }

    function _unpause() internal {
        vm.prank(compliance);
        token.unpause();
    }

    function _expectUnauthorized(address caller, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, role));
    }

    function _expectCannotSend(address account) internal {
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, account));
    }

    function _expectCannotReceive(address account) internal {
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, account));
    }

    function _expectInsufficientUnfrozen(address account, uint256 amount, uint256 unfrozen) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC7943Fungible.ERC7943InsufficientUnfrozenBalance.selector, account, amount, unfrozen
            )
        );
    }

    function _expectInsufficientBalance(address account, uint256 balance, uint256 needed) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, account, balance, needed)
        );
    }

    function _unfrozenOf(address account) internal view returns (uint256) {
        uint256 bal = token.balanceOf(account);
        uint256 frozen = token.getFrozenTokens(account);
        return bal > frozen ? bal - frozen : 0;
    }

    /// @dev Index of the first log from `emitter` whose topic0 is `sig`, or type(uint256).max if none.
    function _indexOf(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == sig) return i;
        }
        return type(uint256).max;
    }

    function _countOf(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == sig) ++n;
        }
    }
}

contract RegulatedTokenTest is RegulatedTokenFixture {
    // =====================================================================================================
    // U1 Roles: only the issuer issues/redeems, only compliance pauses/unpauses/freezes/forces,
    //           only the admin changes the slot. Everyone else gets AccessControlUnauthorizedAccount.
    // =====================================================================================================

    function test_U1_onlyIssuerCanIssue() public {
        address[4] memory notIssuers = [operator, compliance, alice, stranger];
        for (uint256 i; i < notIssuers.length; ++i) {
            _expectUnauthorized(notIssuers[i], ISSUER);
            vm.prank(notIssuers[i]);
            token.issue(alice, UNIT);
        }
        _issue(alice, UNIT);
        assertEq(token.balanceOf(alice), UNIT);
    }

    function test_U1_onlyIssuerCanRedeem() public {
        _issue(alice, 10 * UNIT);
        address[4] memory notIssuers = [operator, compliance, alice, stranger];
        for (uint256 i; i < notIssuers.length; ++i) {
            _expectUnauthorized(notIssuers[i], ISSUER);
            vm.prank(notIssuers[i]);
            token.redeem(alice, UNIT);
        }
        vm.prank(issuer);
        token.redeem(alice, UNIT);
        assertEq(token.balanceOf(alice), 9 * UNIT);
    }

    function test_U1_onlyComplianceCanFreeze() public {
        address[4] memory others = [operator, issuer, alice, stranger];
        for (uint256 i; i < others.length; ++i) {
            _expectUnauthorized(others[i], COMPLIANCE);
            vm.prank(others[i]);
            token.setFrozenTokens(alice, UNIT);
        }
        _freeze(alice, UNIT);
        assertEq(token.getFrozenTokens(alice), UNIT);
    }

    function test_U1_onlyComplianceCanForceTransfer() public {
        _issue(alice, 10 * UNIT);
        address[4] memory others = [operator, issuer, alice, stranger];
        for (uint256 i; i < others.length; ++i) {
            _expectUnauthorized(others[i], COMPLIANCE);
            vm.prank(others[i]);
            token.forcedTransfer(alice, bob, UNIT);
        }
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, UNIT);
        assertEq(token.balanceOf(bob), UNIT);
    }

    function test_U1_onlyComplianceCanPause() public {
        address[4] memory others = [operator, issuer, alice, stranger];
        for (uint256 i; i < others.length; ++i) {
            _expectUnauthorized(others[i], COMPLIANCE);
            vm.prank(others[i]);
            token.pause();
        }
        _pause();
        assertTrue(token.paused());
    }

    function test_U1_onlyComplianceCanUnpause() public {
        _pause();
        address[4] memory others = [operator, issuer, alice, stranger];
        for (uint256 i; i < others.length; ++i) {
            _expectUnauthorized(others[i], COMPLIANCE);
            vm.prank(others[i]);
            token.unpause();
        }
        _unpause();
        assertFalse(token.paused());
    }

    function test_U1_onlyAdminCanChangeSlot() public {
        MockEligibility other = new MockEligibility();
        address[4] memory others = [issuer, compliance, alice, stranger];
        for (uint256 i; i < others.length; ++i) {
            _expectUnauthorized(others[i], ADMIN);
            vm.prank(others[i]);
            token.setEligibility(other);
        }
        vm.prank(operator);
        token.setEligibility(other);
        assertEq(address(token.eligibility()), address(other));
    }

    /// U1: roles are held exactly as granted; the admin is not implicitly an issuer or compliance officer.
    function test_U1_rolesAreSeparated() public view {
        assertTrue(token.hasRole(ADMIN, operator));
        assertFalse(token.hasRole(ISSUER, operator));
        assertFalse(token.hasRole(COMPLIANCE, operator));
        assertTrue(token.hasRole(ISSUER, issuer));
        assertFalse(token.hasRole(COMPLIANCE, issuer));
        assertFalse(token.hasRole(ADMIN, issuer));
        assertTrue(token.hasRole(COMPLIANCE, compliance));
        assertFalse(token.hasRole(ISSUER, compliance));
        assertFalse(token.hasRole(ADMIN, compliance));
        assertEq(token.getRoleAdmin(ISSUER), ADMIN);
        assertEq(token.getRoleAdmin(COMPLIANCE), ADMIN);
    }

    /// U1: only the admin grants roles, and revoking the issuer role takes the power away at once.
    function test_U1_adminGrantsAndRevokes() public {
        _expectUnauthorized(issuer, ADMIN);
        vm.prank(issuer);
        token.grantRole(ISSUER, stranger);

        vm.prank(operator);
        token.revokeRole(ISSUER, issuer);
        _expectUnauthorized(issuer, ISSUER);
        vm.prank(issuer);
        token.issue(alice, UNIT);
    }

    function testFuzz_U1_nonIssuerCannotIssueOrRedeem(address caller) public {
        vm.assume(caller != issuer);
        _expectUnauthorized(caller, ISSUER);
        vm.prank(caller);
        token.issue(alice, UNIT);
        _expectUnauthorized(caller, ISSUER);
        vm.prank(caller);
        token.redeem(alice, 0);
    }

    function testFuzz_U1_nonComplianceCannotFreezeForceOrPause(address caller) public {
        vm.assume(caller != compliance);
        _expectUnauthorized(caller, COMPLIANCE);
        vm.prank(caller);
        token.setFrozenTokens(alice, 1);
        _expectUnauthorized(caller, COMPLIANCE);
        vm.prank(caller);
        token.forcedTransfer(alice, bob, 0);
        _expectUnauthorized(caller, COMPLIANCE);
        vm.prank(caller);
        token.pause();
    }

    function testFuzz_U1_nonAdminCannotChangeSlot(address caller) public {
        vm.assume(caller != operator);
        _expectUnauthorized(caller, ADMIN);
        vm.prank(caller);
        token.setEligibility(IEligibility(address(0xBEEF)));
    }

    // =====================================================================================================
    // U2 Transfers ask the slot about both holders: an ineligible sender gets ERC7943CannotSend, an
    //    ineligible recipient gets ERC7943CannotReceive, through transfer and transferFrom alike.
    // =====================================================================================================

    function test_U2_eligibleToEligibleTransferWorks() public {
        _issue(alice, 10 * UNIT);
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(alice, bob, 4 * UNIT);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 4 * UNIT));
        assertEq(token.balanceOf(alice), 6 * UNIT);
        assertEq(token.balanceOf(bob), 4 * UNIT);
    }

    function test_U2_transferRefusedForIneligibleSender() public {
        _issue(alice, 10 * UNIT);
        slot.setEligible(alice, false); // e.g. her credential was revoked after she received tokens
        _expectCannotSend(alice);
        vm.prank(alice);
        token.transfer(bob, UNIT);
    }

    function test_U2_transferRefusedForIneligibleRecipient() public {
        _issue(alice, 10 * UNIT);
        _expectCannotReceive(carol);
        vm.prank(alice);
        token.transfer(carol, UNIT);
    }

    /// U2: the sender check comes first when neither holder is eligible.
    function test_U2_senderCheckedBeforeRecipient() public {
        _issue(alice, 10 * UNIT);
        slot.setEligible(alice, false);
        _expectCannotSend(alice);
        vm.prank(alice);
        token.transfer(carol, UNIT);
    }

    function test_U2_transferFromRefusedForIneligibleSender() public {
        _issue(alice, 10 * UNIT);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        slot.setEligible(alice, false);
        _expectCannotSend(alice);
        vm.prank(bob);
        token.transferFrom(alice, bob, UNIT);
    }

    function test_U2_transferFromRefusedForIneligibleRecipient() public {
        _issue(alice, 10 * UNIT);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        _expectCannotReceive(carol);
        vm.prank(bob);
        token.transferFrom(alice, carol, UNIT);
    }

    /// U2: the spender is not a holder. Rule 3.3 asks about the wallets whose balances move, not the caller.
    function test_U2_transferFromAsksAboutHoldersNotSpender() public {
        _issue(alice, 10 * UNIT);
        vm.prank(alice);
        token.approve(carol, 3 * UNIT);
        vm.prank(carol); // carol is not eligible, but she only moves alice's tokens to bob
        assertTrue(token.transferFrom(alice, bob, 3 * UNIT));
        assertEq(token.balanceOf(bob), 3 * UNIT);
        assertEq(token.allowance(alice, carol), 0);
    }

    /// U2: issuance asks the slot about the recipient as well.
    function test_U2_issueRefusedForIneligibleRecipient() public {
        _expectCannotReceive(carol);
        vm.prank(issuer);
        token.issue(carol, UNIT);
        assertEq(token.totalSupply(), 0);
    }

    function test_U2_issueEmitsIssuedAndTransfer() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(address(0), alice, 5 * UNIT);
        vm.expectEmit(true, false, false, true, address(token));
        emit RegulatedToken.Issued(alice, 5 * UNIT);
        _issue(alice, 5 * UNIT);
        assertEq(token.totalSupply(), 5 * UNIT);
    }

    /// U2: a wallet that becomes eligible later can receive from then on (the slot is asked live, not cached).
    function test_U2_eligibilityIsAskedLive() public {
        _issue(alice, 10 * UNIT);
        _expectCannotReceive(carol);
        vm.prank(alice);
        token.transfer(carol, UNIT);

        slot.setEligible(carol, true);
        vm.prank(alice);
        token.transfer(carol, UNIT);
        assertEq(token.balanceOf(carol), UNIT);
    }

    // =====================================================================================================
    // U3 Freeze: amounts above the unfrozen balance are refused with
    //    ERC7943InsufficientUnfrozenBalance(account, amount, unfrozen); a new value overwrites the old one;
    //    the frozen amount may exceed the balance; Frozen is emitted.
    // =====================================================================================================

    function test_U3_transferAboveUnfrozenRefused() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 60 * UNIT);
        _expectInsufficientUnfrozen(alice, 40 * UNIT + 1, 40 * UNIT);
        vm.prank(alice);
        token.transfer(bob, 40 * UNIT + 1);

        vm.prank(alice);
        token.transfer(bob, 40 * UNIT); // exactly the unfrozen balance is fine
        assertEq(token.balanceOf(alice), 60 * UNIT);
        assertEq(token.getFrozenTokens(alice), 60 * UNIT);
    }

    function test_U3_transferFromAboveUnfrozenRefused() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 60 * UNIT);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        _expectInsufficientUnfrozen(alice, 50 * UNIT, 40 * UNIT);
        vm.prank(bob);
        token.transferFrom(alice, bob, 50 * UNIT);
    }

    /// U3: above the whole balance the plain ERC-20 error wins, so callers can tell "frozen" from "not there".
    function test_U3_transferAboveBalanceRevertsWithERC20Error() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 60 * UNIT);
        _expectInsufficientBalance(alice, 100 * UNIT, 100 * UNIT + 1);
        vm.prank(alice);
        token.transfer(bob, 100 * UNIT + 1);
    }

    function test_U3_newValueOverwritesOld() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 60 * UNIT);
        _freeze(alice, 10 * UNIT); // overwrite, not add: 10, not 70
        assertEq(token.getFrozenTokens(alice), 10 * UNIT);
        vm.prank(alice);
        token.transfer(bob, 90 * UNIT);
        assertEq(token.balanceOf(alice), 10 * UNIT);

        _freeze(alice, 0); // unfreezing everything restores the full balance
        vm.prank(alice);
        token.transfer(bob, 10 * UNIT);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_U3_frozenMayExceedBalance() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 1000 * UNIT);
        assertEq(token.getFrozenTokens(alice), 1000 * UNIT);
        assertFalse(token.canTransfer(alice, bob, 1));
        _expectInsufficientUnfrozen(alice, 1, 0); // unfrozen floors at zero, it never underflows
        vm.prank(alice);
        token.transfer(bob, 1);

        // tokens issued later are covered by the standing freeze until the balance passes it
        _issue(alice, 900 * UNIT);
        assertFalse(token.canTransfer(alice, bob, 1));
        _issue(alice, 5 * UNIT);
        assertTrue(token.canTransfer(alice, bob, 5 * UNIT));
        assertFalse(token.canTransfer(alice, bob, 5 * UNIT + 1));
        vm.prank(alice);
        token.transfer(bob, 5 * UNIT);
    }

    /// U3: a wallet with no balance (and no eligibility) can be frozen ahead of time.
    function test_U3_freezeWalletWithNoBalance() public {
        _freeze(carol, 7 * UNIT);
        assertEq(token.getFrozenTokens(carol), 7 * UNIT);
        assertEq(token.balanceOf(carol), 0);
    }

    function test_U3_freezeEmitsFrozenAndReturnsTrue() public {
        _issue(alice, 100 * UNIT);
        vm.expectEmit(true, false, false, true, address(token));
        emit IERC7943Fungible.Frozen(alice, 60 * UNIT);
        vm.prank(compliance);
        assertTrue(token.setFrozenTokens(alice, 60 * UNIT));

        vm.expectEmit(true, false, false, true, address(token));
        emit IERC7943Fungible.Frozen(alice, 0);
        vm.prank(compliance);
        token.setFrozenTokens(alice, 0);
    }

    /// U3: compliance can still freeze while the token is paused (an incident is when it matters most).
    function test_U3_freezeWorksWhilePaused() public {
        _issue(alice, 100 * UNIT);
        _pause();
        _freeze(alice, 100 * UNIT);
        assertEq(token.getFrozenTokens(alice), 100 * UNIT);
    }

    /// U3 fuzz: the outcome of a transfer is decided by balance, frozen amount and requested amount alone.
    function testFuzz_U3_transferFreezeArithmetic(uint256 balance, uint256 frozen, uint256 amount) public {
        balance = bound(balance, 0, MAX_AMOUNT);
        frozen = bound(frozen, 0, MAX_AMOUNT * 2);
        amount = bound(amount, 0, MAX_AMOUNT + 1);
        _issue(alice, balance);
        _freeze(alice, frozen);
        uint256 unfrozen = balance > frozen ? balance - frozen : 0;

        bool predicted = token.canTransfer(alice, bob, amount);
        assertEq(predicted, amount <= unfrozen, "canTransfer must equal amount <= balance - frozen");

        if (amount > balance) {
            _expectInsufficientBalance(alice, balance, amount);
        } else if (amount > unfrozen) {
            _expectInsufficientUnfrozen(alice, amount, unfrozen);
        }
        vm.prank(alice);
        token.transfer(bob, amount);

        if (amount <= unfrozen) {
            assertEq(token.balanceOf(alice), balance - amount);
            assertEq(token.balanceOf(bob), amount);
            assertEq(token.getFrozenTokens(alice), frozen, "an ordinary transfer never changes the frozen amount");
        } else {
            assertEq(token.balanceOf(alice), balance);
            assertEq(token.balanceOf(bob), 0);
        }
        assertEq(token.totalSupply(), balance);
    }

    /// U3 fuzz: overwriting is last-writer-wins, whatever the order and size of the values.
    function testFuzz_U3_freezeOverwrites(uint256 first, uint256 second) public {
        _freeze(alice, first);
        _freeze(alice, second);
        assertEq(token.getFrozenTokens(alice), second);
    }

    // =====================================================================================================
    // U4 Forced transfer: works for an ineligible sender and while paused, refuses an ineligible recipient,
    //    unfreezes what it moves (Frozen BEFORE Transfer), emits ForcedTransfer, and amount > balance
    //    reverts with ERC20InsufficientBalance.
    // =====================================================================================================

    function test_U4_worksForIneligibleSender() public {
        _issue(alice, 100 * UNIT);
        slot.setEligible(alice, false);
        vm.prank(compliance);
        assertTrue(token.forcedTransfer(alice, bob, 100 * UNIT));
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), 100 * UNIT);
    }

    function test_U4_worksWhilePaused() public {
        _issue(alice, 100 * UNIT);
        _pause();
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 30 * UNIT);
        assertEq(token.balanceOf(bob), 30 * UNIT);
        assertTrue(token.paused());
    }

    /// U4: works when the sender's slot answer is broken too: only the recipient is asked.
    function test_U4_worksForIneligibleSenderWhilePausedAndFrozen() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 100 * UNIT);
        slot.setEligible(alice, false);
        _pause();
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 100 * UNIT);
        assertEq(token.balanceOf(bob), 100 * UNIT);
        assertEq(token.getFrozenTokens(alice), 0);
    }

    function test_U4_refusesIneligibleRecipient() public {
        _issue(alice, 100 * UNIT);
        _expectCannotReceive(carol);
        vm.prank(compliance);
        token.forcedTransfer(alice, carol, UNIT);
    }

    function test_U4_amountAboveBalanceReverts() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 30 * UNIT);
        _expectInsufficientBalance(alice, 100 * UNIT, 100 * UNIT + 1);
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 100 * UNIT + 1);
        assertEq(token.getFrozenTokens(alice), 30 * UNIT, "a reverted forced transfer must not unfreeze anything");
    }

    function test_U4_emitsForcedTransfer() public {
        _issue(alice, 100 * UNIT);
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(alice, bob, 25 * UNIT);
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC7943Fungible.ForcedTransfer(alice, bob, 25 * UNIT);
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 25 * UNIT);
    }

    /// U4: 100 held, 80 frozen, 20 unfrozen. Forcing 50 uses the 20 unfrozen and releases 30 frozen,
    ///     leaving 50 held and 50 frozen. ERC-7943 requires Frozen to be emitted before Transfer.
    function test_U4_unfreezesWhatItMovesAndEmitsFrozenBeforeTransfer() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 80 * UNIT);

        vm.recordLogs();
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 50 * UNIT);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(token.balanceOf(alice), 50 * UNIT);
        assertEq(token.getFrozenTokens(alice), 50 * UNIT);
        assertEq(token.balanceOf(bob), 50 * UNIT);

        uint256 iFrozen = _indexOf(logs, address(token), IERC7943Fungible.Frozen.selector);
        uint256 iTransfer = _indexOf(logs, address(token), IERC20.Transfer.selector);
        uint256 iForced = _indexOf(logs, address(token), IERC7943Fungible.ForcedTransfer.selector);
        assertTrue(iFrozen != type(uint256).max, "Frozen not emitted");
        assertTrue(iTransfer != type(uint256).max, "Transfer not emitted");
        assertTrue(iForced != type(uint256).max, "ForcedTransfer not emitted");
        assertLt(iFrozen, iTransfer, "Frozen must come before Transfer");
        assertLt(iTransfer, iForced, "ForcedTransfer follows the Transfer it describes");
        assertEq(_countOf(logs, address(token), IERC7943Fungible.Frozen.selector), 1);

        assertEq(logs[iFrozen].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(abi.decode(logs[iFrozen].data, (uint256)), 50 * UNIT);
        assertEq(logs[iTransfer].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(logs[iTransfer].topics[2], bytes32(uint256(uint160(bob))));
        assertEq(abi.decode(logs[iTransfer].data, (uint256)), 50 * UNIT);
        assertEq(logs[iForced].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(logs[iForced].topics[2], bytes32(uint256(uint160(bob))));
        assertEq(abi.decode(logs[iForced].data, (uint256)), 50 * UNIT);
    }

    /// U4: within the unfrozen balance nothing is unfrozen and no Frozen event is emitted.
    function test_U4_withinUnfrozenLeavesFreezeAlone() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 30 * UNIT);
        vm.recordLogs();
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 70 * UNIT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(token.getFrozenTokens(alice), 30 * UNIT);
        assertEq(_countOf(logs, address(token), IERC7943Fungible.Frozen.selector), 0);
        assertEq(_countOf(logs, address(token), IERC7943Fungible.ForcedTransfer.selector), 1);
    }

    /// U4: frozen above the balance is reduced by exactly what is moved, never below zero.
    function test_U4_frozenAboveBalanceReducedByAmountMoved() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 500 * UNIT);
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 40 * UNIT);
        assertEq(token.getFrozenTokens(alice), 460 * UNIT);
        assertEq(token.balanceOf(alice), 60 * UNIT);
    }

    /// U4: moving everything that was frozen clears the freeze.
    function test_U4_movingAllClearsFreeze() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 100 * UNIT);
        vm.expectEmit(true, false, false, true, address(token));
        emit IERC7943Fungible.Frozen(alice, 0);
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, 100 * UNIT);
        assertEq(token.getFrozenTokens(alice), 0);
    }

    /// U4 fuzz: a forced transfer takes unfrozen tokens first, then frozen ones; what stays behind keeps its
    ///          frozen status. Equivalently: new unfrozen = max(0, old unfrozen - amount) and
    ///          new frozen = old frozen - max(0, amount - old unfrozen), floored at zero.
    function testFuzz_U4_forcedTransferArithmetic(uint256 balance, uint256 frozen, uint256 amount, bool senderOk)
        public
    {
        balance = bound(balance, 0, MAX_AMOUNT);
        frozen = bound(frozen, 0, MAX_AMOUNT * 2);
        amount = bound(amount, 0, MAX_AMOUNT + 1);
        _issue(alice, balance);
        _freeze(alice, frozen);
        slot.setEligible(alice, senderOk); // the sender's eligibility must not matter
        uint256 unfrozen = balance > frozen ? balance - frozen : 0;

        if (amount > balance) {
            _expectInsufficientBalance(alice, balance, amount);
            vm.prank(compliance);
            token.forcedTransfer(alice, bob, amount);
            assertEq(token.getFrozenTokens(alice), frozen);
            return;
        }

        vm.recordLogs();
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, amount);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 needed = amount > unfrozen ? amount - unfrozen : 0;
        uint256 expectedFrozen = needed >= frozen ? 0 : frozen - needed;
        assertEq(token.balanceOf(alice), balance - amount);
        assertEq(token.balanceOf(bob), amount);
        assertEq(token.getFrozenTokens(alice), expectedFrozen);
        assertEq(_unfrozenOf(alice), unfrozen > amount ? unfrozen - amount : 0);
        assertLe(token.getFrozenTokens(alice), frozen, "forced transfer never freezes more");
        assertEq(token.totalSupply(), balance);
        assertEq(
            _countOf(logs, address(token), IERC7943Fungible.Frozen.selector),
            amount > unfrozen ? 1 : 0,
            "Frozen is emitted exactly when frozen tokens had to move"
        );
    }

    // =====================================================================================================
    // U5 Pause blocks transfer, issue and redeem; unpause restores them.
    // =====================================================================================================

    function test_U5_pauseBlocksTransfer() public {
        _issue(alice, 10 * UNIT);
        _pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        token.transfer(bob, UNIT);
    }

    function test_U5_pauseBlocksTransferFrom() public {
        _issue(alice, 10 * UNIT);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        _pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(bob);
        token.transferFrom(alice, bob, UNIT);
    }

    function test_U5_pauseBlocksIssue() public {
        _pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(issuer);
        token.issue(alice, UNIT);
    }

    function test_U5_pauseBlocksRedeem() public {
        _issue(alice, 10 * UNIT);
        _pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(issuer);
        token.redeem(alice, UNIT);
    }

    function test_U5_unpauseRestoresTransferIssueRedeem() public {
        _issue(alice, 10 * UNIT);
        _pause();
        _unpause();
        vm.prank(alice);
        token.transfer(bob, 2 * UNIT);
        _issue(alice, 5 * UNIT);
        vm.prank(issuer);
        token.redeem(alice, 3 * UNIT);
        assertEq(token.balanceOf(alice), 10 * UNIT);
        assertEq(token.balanceOf(bob), 2 * UNIT);
        assertEq(token.totalSupply(), 12 * UNIT);
    }

    function test_U5_pauseAndUnpauseEmitAndAreNotRepeatable() public {
        vm.expectEmit(false, false, false, true, address(token));
        emit Pausable.Paused(compliance);
        _pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(compliance);
        token.pause();

        vm.expectEmit(false, false, false, true, address(token));
        emit Pausable.Unpaused(compliance);
        _unpause();
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vm.prank(compliance);
        token.unpause();
    }

    // =====================================================================================================
    // U6 ERC-7943 conformance: interface id, ERC-165, and views that never revert and fail closed.
    // =====================================================================================================

    /// U6: recompute the ERC-7943 fungible interface id from the six function signatures, independently
    ///     of the interface file, and check both the published value and what the compiler derives.
    function test_U6_interfaceIdIsXorOfTheSixSelectors() public pure {
        bytes4 forced = bytes4(keccak256("forcedTransfer(address,address,uint256)"));
        bytes4 setFrozen = bytes4(keccak256("setFrozenTokens(address,uint256)"));
        bytes4 send = bytes4(keccak256("canSend(address)"));
        bytes4 receive_ = bytes4(keccak256("canReceive(address)"));
        bytes4 getFrozen = bytes4(keccak256("getFrozenTokens(address)"));
        bytes4 transfer_ = bytes4(keccak256("canTransfer(address,address,uint256)"));

        // the interface file declares exactly these signatures
        assertEq(IERC7943Fungible.forcedTransfer.selector, forced);
        assertEq(IERC7943Fungible.setFrozenTokens.selector, setFrozen);
        assertEq(IERC7943Fungible.canSend.selector, send);
        assertEq(IERC7943Fungible.canReceive.selector, receive_);
        assertEq(IERC7943Fungible.getFrozenTokens.selector, getFrozen);
        assertEq(IERC7943Fungible.canTransfer.selector, transfer_);

        bytes4 id = forced ^ setFrozen ^ send ^ receive_ ^ getFrozen ^ transfer_;
        assertEq(id, bytes4(0x3edbb4c4), "ERC-7943 (Final) fungible interface id");
        assertEq(id, type(IERC7943Fungible).interfaceId);
    }

    function test_U6_supportsInterface() public view {
        assertTrue(token.supportsInterface(0x3edbb4c4), "ERC-7943 fungible");
        assertTrue(token.supportsInterface(type(IERC7943Fungible).interfaceId));
        assertTrue(token.supportsInterface(type(IERC165).interfaceId), "ERC-165");
        assertTrue(token.supportsInterface(0x01ffc9a7));
        assertTrue(token.supportsInterface(type(IAccessControl).interfaceId));
        assertFalse(token.supportsInterface(0xffffffff), "ERC-165 requires false for 0xffffffff");
        assertFalse(token.supportsInterface(0x00000000));
    }

    function test_U6_viewsReflectTheSlot() public {
        _issue(alice, 10 * UNIT);
        assertTrue(token.canSend(alice));
        assertTrue(token.canReceive(bob));
        assertFalse(token.canSend(carol));
        assertFalse(token.canReceive(carol));
        assertTrue(token.canTransfer(alice, bob, 10 * UNIT));
        assertFalse(token.canTransfer(alice, carol, UNIT), "ineligible recipient");
        slot.setEligible(alice, false);
        assertFalse(token.canTransfer(alice, bob, UNIT), "ineligible sender");
    }

    function test_U6_canTransferFalseWhenPaused() public {
        _issue(alice, 10 * UNIT);
        assertTrue(token.canTransfer(alice, bob, UNIT));
        _pause();
        assertFalse(token.canTransfer(alice, bob, UNIT));
        assertFalse(token.canTransfer(alice, bob, 0));
        assertTrue(token.canSend(alice), "pause is not an eligibility question");
    }

    function test_U6_canTransferFalseAboveUnfrozen() public {
        _issue(alice, 10 * UNIT);
        _freeze(alice, 4 * UNIT);
        assertTrue(token.canTransfer(alice, bob, 6 * UNIT));
        assertFalse(token.canTransfer(alice, bob, 6 * UNIT + 1));
        assertFalse(token.canTransfer(alice, bob, 11 * UNIT), "above the balance");
    }

    function test_U6_getFrozenTokensDefaultsToZero() public view {
        assertEq(token.getFrozenTokens(alice), 0);
        assertEq(token.getFrozenTokens(address(0)), 0);
    }

    /// U6/D3: when the slot misbehaves the views return false (never revert) and every move that needs an
    ///        eligibility answer is refused. Alice holds tokens before the slot breaks.
    function _assertFailsClosed() internal {
        assertFalse(token.canSend(alice), "canSend");
        assertFalse(token.canReceive(bob), "canReceive");
        assertFalse(token.canTransfer(alice, bob, UNIT), "canTransfer");
        assertFalse(token.canTransfer(alice, bob, 0), "canTransfer(0)");

        _expectCannotSend(alice);
        vm.prank(alice);
        token.transfer(bob, UNIT);

        _expectCannotReceive(bob);
        vm.prank(issuer);
        token.issue(bob, UNIT);

        _expectCannotReceive(bob);
        vm.prank(compliance);
        token.forcedTransfer(alice, bob, UNIT);

        assertEq(token.balanceOf(alice), 10 * UNIT);
        assertEq(token.balanceOf(bob), 0);
    }

    function _breakSlot(MockEligibility.Mode m) internal {
        _issue(alice, 10 * UNIT);
        slot.setMode(m);
    }

    function test_U6_failsClosed_slotReverts() public {
        _breakSlot(MockEligibility.Mode.Revert);
        _assertFailsClosed();
    }

    function test_U6_failsClosed_slotRevertsWithoutData() public {
        _breakSlot(MockEligibility.Mode.RevertEmpty);
        _assertFailsClosed();
    }

    function test_U6_failsClosed_slotPanics() public {
        _breakSlot(MockEligibility.Mode.Panic);
        _assertFailsClosed();
    }

    /// The slot eats all gas it is given (63/64 of what is left, EIP-150). The token keeps the remaining 1/64,
    /// which must be enough to return false. Each call gets a 30M budget, the size of a real transaction, so the
    /// test models production and does not depend on the test runner's much larger gas limit.
    function test_U6_failsClosed_slotBurnsAllGas_views() public {
        _breakSlot(MockEligibility.Mode.BurnGas);
        assertFalse(token.canSend{gas: TX_GAS}(alice));
        assertFalse(token.canReceive{gas: TX_GAS}(bob));
        assertFalse(token.canTransfer{gas: TX_GAS}(alice, bob, UNIT));
        assertFalse(token.canTransfer{gas: TX_GAS}(alice, bob, 0));
    }

    function test_U6_failsClosed_slotBurnsAllGas_actions() public {
        _breakSlot(MockEligibility.Mode.BurnGas);
        _expectCannotSend(alice);
        vm.prank(alice);
        token.transfer{gas: TX_GAS}(bob, UNIT);

        _expectCannotReceive(bob);
        vm.prank(issuer);
        token.issue{gas: TX_GAS}(bob, UNIT);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_U6_failsClosed_slotReturnsNothing() public {
        _breakSlot(MockEligibility.Mode.ReturnEmpty);
        _assertFailsClosed();
    }

    function test_U6_failsClosed_slotReturnsShortData() public {
        _breakSlot(MockEligibility.Mode.ReturnShort);
        _assertFailsClosed();
    }

    function test_U6_failsClosed_slotReturnsLongData() public {
        _breakSlot(MockEligibility.Mode.ReturnLong);
        _assertFailsClosed();
    }

    function test_U6_failsClosed_slotReturnsGarbageWord() public {
        _breakSlot(MockEligibility.Mode.ReturnGarbage); // abi word 2: not a bool
        _assertFailsClosed();
    }

    /// A slot that returns a few kilobytes of zeros instead of one word: malformed, so not eligible.
    function test_U6_failsClosed_slotReturnsLargeData() public {
        _breakSlot(MockEligibility.Mode.ReturnHuge);
        slot.setHugeSize(4096);
        _assertFailsClosed();
    }

    /// A word whose low byte is 1 but whose high bits are dirty is not `true`.
    function test_U6_failsClosed_slotReturnsDirtyTrue() public {
        _breakSlot(MockEligibility.Mode.ReturnGarbage);
        slot.setGarbage(bytes32(type(uint256).max - 0xfe)); // 0xff..ff01
        _assertFailsClosed();
    }

    /// Control for the garbage mode: the exact ABI word for `true` does grant, so the mode can say yes and the
    /// fail-closed tests above are not passing for an unrelated reason.
    function test_U6_garbageModeGrantsOnExactTrueWord() public {
        _breakSlot(MockEligibility.Mode.ReturnGarbage);
        slot.setGarbage(bytes32(uint256(1)));
        assertTrue(token.canSend(alice));
        vm.prank(alice);
        token.transfer(bob, UNIT);
        assertEq(token.balanceOf(bob), UNIT);
    }

    /// The slot address loses its code (the "slot is an EOA" case): a call to it succeeds with no data.
    function test_U6_failsClosed_slotIsEOA() public {
        _issue(alice, 10 * UNIT);
        vm.etch(address(slot), "");
        assertEq(address(slot).code.length, 0);
        _assertFailsClosed();
    }

    /// The admin points the slot at an address that never had code.
    function test_U6_failsClosed_slotIsCodelessAddress() public {
        _issue(alice, 10 * UNIT);
        vm.prank(operator);
        token.setEligibility(IEligibility(makeAddr("not-a-contract")));
        _assertFailsClosed();
    }

    /// Precompiles answer every call: identity (0x04) echoes 36 bytes, sha256 (0x02) returns a 32-byte hash.
    function test_U6_failsClosed_slotIsPrecompile() public {
        _issue(alice, 10 * UNIT);
        vm.prank(operator);
        token.setEligibility(IEligibility(address(0x04)));
        _assertFailsClosed();
        vm.prank(operator);
        token.setEligibility(IEligibility(address(0x02)));
        _assertFailsClosed();
    }

    /// U6 fuzz: only the exact ABI encoding of `true` (a 32-byte word equal to 1) grants.
    function testFuzz_U6_onlyExactTrueWordGrants(bytes32 word) public {
        slot.setMode(MockEligibility.Mode.ReturnGarbage);
        slot.setGarbage(word);
        bool yes = word == bytes32(uint256(1));
        assertEq(token.canSend(alice), yes);
        assertEq(token.canReceive(carol), yes);
    }

    /// U6 fuzz: in every slot mode the three views return without reverting, and only a well-behaved slot
    ///          can make them true.
    function testFuzz_U6_viewsNeverRevert(uint8 modeSeed, bytes32 word, address a, address b, uint256 amount) public {
        MockEligibility.Mode m = MockEligibility.Mode(bound(modeSeed, 0, slot.MODE_COUNT() - 1));
        vm.assume(word != bytes32(uint256(1)));
        // A gas-sized return bomb makes the views run out of gas today: kept out of this fuzz test and covered by
        // RegulatedTokenRegressionTest.test_U6_viewsDoNotRevertWhenSlotReturnsHugeData.
        vm.assume(m != MockEligibility.Mode.ReturnHuge);
        slot.setEligible(a, true);
        slot.setEligible(b, true);
        slot.setMode(m);
        slot.setGarbage(word);
        // a transaction-sized budget per call: BurnGas would otherwise shrink the test's own gas 64-fold per call
        bool s = token.canSend{gas: TX_GAS}(a);
        bool r = token.canReceive{gas: TX_GAS}(b);
        bool t = token.canTransfer{gas: TX_GAS}(a, b, amount);
        if (m == MockEligibility.Mode.Answer) {
            assertTrue(s && r);
            assertEq(t, amount <= _unfrozenOf(a));
        } else {
            assertFalse(s || r || t);
        }
    }

    /// U6 fuzz: canTransfer predicts exactly whether transfer succeeds, over pause, freeze and both holders'
    ///          eligibility.
    function testFuzz_U6_canTransferPredictsTransfer(
        uint256 balance,
        uint256 frozen,
        uint256 amount,
        bool fromOk,
        bool toOk,
        bool isPaused
    ) public {
        balance = bound(balance, 0, MAX_AMOUNT);
        frozen = bound(frozen, 0, MAX_AMOUNT * 2);
        amount = bound(amount, 0, MAX_AMOUNT + 1);
        _issue(alice, balance);
        _freeze(alice, frozen);
        slot.setEligible(alice, fromOk);
        slot.setEligible(bob, toOk);
        if (isPaused) _pause();

        bool predicted = token.canTransfer(alice, bob, amount);
        uint256 unfrozen = balance > frozen ? balance - frozen : 0;
        assertEq(predicted, !isPaused && fromOk && toOk && amount <= unfrozen);

        bool ok;
        vm.prank(alice);
        try token.transfer(bob, amount) returns (bool r) {
            ok = r;
        } catch {}
        assertEq(ok, predicted, "canTransfer and transfer disagree");
    }

    // =====================================================================================================
    // U7 Redeem lowers supply, stays within the unfrozen balance, and works for a holder who is no longer
    //    eligible.
    // =====================================================================================================

    function test_U7_redeemLowersSupplyAndEmits() public {
        _issue(alice, 10 * UNIT);
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(alice, address(0), 4 * UNIT);
        vm.expectEmit(true, false, false, true, address(token));
        emit RegulatedToken.Redeemed(alice, 4 * UNIT);
        vm.prank(issuer);
        token.redeem(alice, 4 * UNIT);
        assertEq(token.balanceOf(alice), 6 * UNIT);
        assertEq(token.totalSupply(), 6 * UNIT);
    }

    function test_U7_redeemStaysWithinUnfrozen() public {
        _issue(alice, 100 * UNIT);
        _freeze(alice, 60 * UNIT);
        _expectInsufficientUnfrozen(alice, 41 * UNIT, 40 * UNIT);
        vm.prank(issuer);
        token.redeem(alice, 41 * UNIT);

        vm.prank(issuer);
        token.redeem(alice, 40 * UNIT);
        assertEq(token.totalSupply(), 60 * UNIT);
        assertEq(token.getFrozenTokens(alice), 60 * UNIT);
    }

    function test_U7_redeemAboveBalanceRevertsWithERC20Error() public {
        _issue(alice, 10 * UNIT);
        _expectInsufficientBalance(alice, 10 * UNIT, 10 * UNIT + 1);
        vm.prank(issuer);
        token.redeem(alice, 10 * UNIT + 1);
    }

    /// U7: a holder whose credential lapsed can still be paid out: redeem does not ask the slot about her.
    function test_U7_redeemWorksForHolderNoLongerEligible() public {
        _issue(alice, 10 * UNIT);
        slot.setEligible(alice, false);
        assertFalse(token.canSend(alice));
        vm.prank(issuer);
        token.redeem(alice, 10 * UNIT);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
    }

    /// U7: redeem needs no eligibility answer at all, so it works even when the slot is down.
    function test_U7_redeemWorksWhenSlotIsDown() public {
        _issue(alice, 10 * UNIT);
        slot.setMode(MockEligibility.Mode.Revert);
        vm.prank(issuer);
        token.redeem(alice, 3 * UNIT);
        assertEq(token.balanceOf(alice), 7 * UNIT);
    }

    /// U7 fuzz: redeem succeeds exactly within the unfrozen balance and lowers supply by the amount.
    function testFuzz_U7_redeemArithmetic(uint256 balance, uint256 frozen, uint256 amount, bool holderOk) public {
        balance = bound(balance, 0, MAX_AMOUNT);
        frozen = bound(frozen, 0, MAX_AMOUNT * 2);
        amount = bound(amount, 0, MAX_AMOUNT + 1);
        _issue(alice, balance);
        _freeze(alice, frozen);
        slot.setEligible(alice, holderOk);
        uint256 unfrozen = balance > frozen ? balance - frozen : 0;

        if (amount > balance) {
            _expectInsufficientBalance(alice, balance, amount);
        } else if (amount > unfrozen) {
            _expectInsufficientUnfrozen(alice, amount, unfrozen);
        }
        vm.prank(issuer);
        token.redeem(alice, amount);

        uint256 burned = amount <= unfrozen ? amount : 0;
        assertEq(token.balanceOf(alice), balance - burned);
        assertEq(token.totalSupply(), balance - burned);
        assertEq(token.getFrozenTokens(alice), frozen, "redeem never changes the frozen amount");
    }

    // =====================================================================================================
    // U8 setEligibility emits EligibilityChanged(old, new) and rejects zero; the constructor rejects a zero
    //    admin or slot; decimals() returns the constructor value.
    // =====================================================================================================

    function test_U8_setEligibilityEmitsOldAndNew() public {
        MockEligibility next = new MockEligibility();
        vm.expectEmit(true, true, false, true, address(token));
        emit RegulatedToken.EligibilityChanged(address(slot), address(next));
        vm.prank(operator);
        token.setEligibility(next);
        assertEq(address(token.eligibility()), address(next));
    }

    /// U8: the new slot is used from the next call on. It knows nobody yet, so alice is refused.
    function test_U8_newSlotTakesEffectImmediately() public {
        _issue(alice, 10 * UNIT);
        MockEligibility next = new MockEligibility();
        next.setEligible(bob, true);
        vm.prank(operator);
        token.setEligibility(next);
        _expectCannotSend(alice);
        vm.prank(alice);
        token.transfer(bob, UNIT);
        next.setEligible(alice, true);
        vm.prank(alice);
        token.transfer(bob, UNIT);
        assertEq(token.balanceOf(bob), UNIT);
    }

    function test_U8_setEligibilityRejectsZero() public {
        vm.expectRevert(RegulatedToken.ZeroAddress.selector);
        vm.prank(operator);
        token.setEligibility(IEligibility(address(0)));
        assertEq(address(token.eligibility()), address(slot));
    }

    function test_U8_constructorRejectsZeroAdmin() public {
        vm.expectRevert(RegulatedToken.ZeroAddress.selector);
        new RegulatedToken("x", "x", 6, address(0), slot);
    }

    function test_U8_constructorRejectsZeroSlot() public {
        vm.expectRevert(RegulatedToken.ZeroAddress.selector);
        new RegulatedToken("x", "x", 6, operator, IEligibility(address(0)));
    }

    function test_U8_constructorEmitsInitialSlotAndSetsMetadata() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(true, true, false, true, predicted);
        emit RegulatedToken.EligibilityChanged(address(0), address(slot));
        RegulatedToken t = new RegulatedToken("Demo Money Market Fund", "dMMF", 6, operator, slot);
        assertEq(address(t), predicted);
        assertEq(t.name(), "Demo Money Market Fund");
        assertEq(t.symbol(), "dMMF");
        assertEq(t.decimals(), 6);
        assertEq(address(t.eligibility()), address(slot));
        assertEq(t.totalSupply(), 0);
        assertFalse(t.paused());
    }

    function test_U8_decimalsIsConstructorValue() public view {
        assertEq(token.decimals(), DECIMALS);
    }

    function testFuzz_U8_decimalsIsConstructorValue(uint8 d) public {
        RegulatedToken t = new RegulatedToken("x", "x", d, operator, slot);
        assertEq(t.decimals(), d);
    }
}

/// @notice Regression tests for three defects found while writing M1 and fixed in contracts/RegulatedToken.sol.
/// @dev forcedTransfer calls ERC20's internal `super._update(from, to, amount)` directly. That function is the
///      shared mint/burn/transfer primitive: unlike ERC20._transfer it has no zero-address guards. Without the fix:
///        - from == address(0) minted: COMPLIANCE_ROLE created supply without ISSUER_ROLE, while paused, with
///          no Issued event, which broke F2 (totalSupply == issued - redeemed).
///        - to == address(0) burned, if the slot ever answered yes for address(0): COMPLIANCE_ROLE destroyed a
///          holder's tokens without ISSUER_ROLE and with no Redeemed event.
///      Fixed with ERC20InvalidSender / ERC20InvalidReceiver checks in forcedTransfer.
///      Separately, `_isEligible` copied the slot's entire return data, so a slot returning a gas-sized blob
///      made the ERC-7943 views revert (out of gas) instead of returning false (U6). It now copies 32 bytes.
contract RegulatedTokenRegressionTest is RegulatedTokenFixture {
    /// U4/F2: a forced transfer moves existing tokens between holders; it must never create them.
    function test_U4_forcedTransferFromZeroAddressMustNotMint() public {
        _pause(); // even while paused, and with no ISSUER_ROLE
        uint256 supplyBefore = token.totalSupply();
        vm.prank(compliance);
        try token.forcedTransfer(address(0), bob, 1_000_000 * UNIT) {} catch {}
        assertEq(token.totalSupply(), supplyBefore, "forcedTransfer(address(0), ...) minted new supply");
        assertEq(token.balanceOf(bob), 0);
    }

    /// U4/F2: a forced transfer must never destroy tokens either, even if the slot is misconfigured to say yes
    ///        for address(0). Burning is redeem's job (ISSUER_ROLE, Redeemed event).
    function test_U4_forcedTransferToZeroAddressMustNotBurn() public {
        _issue(alice, 10 * UNIT);
        slot.setEligible(address(0), true);
        vm.prank(compliance);
        try token.forcedTransfer(alice, address(0), 10 * UNIT) {} catch {}
        assertEq(token.totalSupply(), 10 * UNIT, "forcedTransfer(..., address(0), ...) burned supply");
        assertEq(token.balanceOf(alice), 10 * UNIT);
    }

    /// U6 (low severity, needs a misbehaving slot): ERC-7943 views must never revert, and a slot answering with an
    ///    oversized blob is malformed data. `_isEligible` copies the whole return data into memory
    ///    (`bytes memory ret`). A return bomb sizes its blob to spend nearly all the 63/64 of the gas it is given:
    ///    3.8 MB costs about 27.9M gas of memory expansion, which fits in a 30M transaction. The token then has to
    ///    pay as much again to copy it with the ~2M it has left, runs out of gas, and the view reverts instead of
    ///    returning false. A fix: do the staticcall in assembly with a 32-byte output buffer and require
    ///    returndatasize() == 32, so nothing beyond one word is ever copied.
    function test_U6_viewsDoNotRevertWhenSlotReturnsHugeData() public {
        _issue(alice, 10 * UNIT);
        slot.setMode(MockEligibility.Mode.ReturnHuge);
        slot.setHugeSize(3_800_000);
        bytes[3] memory calls = [
            abi.encodeCall(token.canSend, (alice)),
            abi.encodeCall(token.canReceive, (bob)),
            abi.encodeCall(token.canTransfer, (alice, bob, UNIT))
        ];
        for (uint256 i; i < calls.length; ++i) {
            // the gas budget of one real transaction
            (bool ok, bytes memory ret) = address(token).staticcall{gas: 30_000_000}(calls[i]);
            assertTrue(ok, "an ERC-7943 view reverted on a return bomb");
            assertFalse(abi.decode(ret, (bool)));
        }
    }
}
