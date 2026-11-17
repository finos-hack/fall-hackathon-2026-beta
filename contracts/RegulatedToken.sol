// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC7943Fungible} from "./interfaces/IERC7943Fungible.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";

/// @title RegulatedToken
/// @notice One ERC-20 shared by every product template, with issuer controls and the ERC-7943 interface.
///         Before any balance moves it asks the eligibility slot "may this wallet hold the token?".
///         It never checks identity itself (don't #2) and holds no product-specific logic (decision D6).
/// @dev Rules (build plan 3.3):
///      transfer        not paused, sender and recipient eligible, amount within the unfrozen balance
///      issue           ISSUER_ROLE, not paused, recipient eligible
///      redeem          ISSUER_ROLE, not paused, within the unfrozen balance, holder eligibility NOT required
///      setFrozenTokens COMPLIANCE_ROLE, overwrites, may exceed the balance
///      forcedTransfer  COMPLIANCE_ROLE, recipient eligible, works while paused and for an ineligible sender,
///                      unfreezes what it moves (Frozen is emitted before Transfer)
///      pause/unpause   COMPLIANCE_ROLE
///      setEligibility  DEFAULT_ADMIN_ROLE
contract RegulatedToken is ERC20, AccessControl, Pausable, IERC7943Fungible {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    uint8 private immutable _decimals;
    IEligibility public eligibility;
    mapping(address => uint256) private _frozen;

    event EligibilityChanged(address indexed previous, address indexed current);
    event Issued(address indexed to, uint256 amount);
    event Redeemed(address indexed from, uint256 amount);

    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin, IEligibility eligibility_)
        ERC20(name_, symbol_)
    {
        if (admin == address(0) || address(eligibility_) == address(0)) revert ZeroAddress();
        _decimals = decimals_;
        eligibility = eligibility_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit EligibilityChanged(address(0), address(eligibility_));
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ============ Issuer ============

    function issue(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount); // _update enforces: not paused, recipient eligible
        emit Issued(to, amount);
    }

    function redeem(address from, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _burn(from, amount); // _update enforces: not paused, within the unfrozen balance
        emit Redeemed(from, amount);
    }

    // ============ Compliance ============

    function setFrozenTokens(address account, uint256 amount) external onlyRole(COMPLIANCE_ROLE) returns (bool) {
        _frozen[account] = amount;
        emit Frozen(account, amount);
        return true;
    }

    function forcedTransfer(address from, address to, uint256 amount)
        external
        onlyRole(COMPLIANCE_ROLE)
        returns (bool)
    {
        if (!_isEligible(to)) revert ERC7943CannotReceive(to);
        uint256 unfrozen = _unfrozen(from);
        if (amount > unfrozen) {
            uint256 frozen = _frozen[from];
            uint256 release = amount - unfrozen;
            _frozen[from] = release >= frozen ? 0 : frozen - release;
            emit Frozen(from, _frozen[from]);
        }
        super._update(from, to, amount); // bypasses pause and sender checks; reverts if amount > balance
        emit ForcedTransfer(from, to, amount);
        return true;
    }

    function pause() external onlyRole(COMPLIANCE_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(COMPLIANCE_ROLE) {
        _unpause();
    }

    // ============ Admin ============

    function setEligibility(IEligibility newEligibility) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(newEligibility) == address(0)) revert ZeroAddress();
        emit EligibilityChanged(address(eligibility), address(newEligibility));
        eligibility = newEligibility;
    }

    // ============ ERC-7943 views (never revert) ============

    function canSend(address account) public view returns (bool) {
        return _isEligible(account);
    }

    function canReceive(address account) public view returns (bool) {
        return _isEligible(account);
    }

    function canTransfer(address from, address to, uint256 amount) external view returns (bool) {
        return !paused() && amount <= _unfrozen(from) && _isEligible(from) && _isEligible(to);
    }

    function getFrozenTokens(address account) external view returns (uint256) {
        return _frozen[account];
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, IERC165) returns (bool) {
        return interfaceId == type(IERC7943Fungible).interfaceId || super.supportsInterface(interfaceId);
    }

    // ============ Internal ============

    /// @dev Every mint, burn and transfer passes here. forcedTransfer calls super._update and skips it.
    function _update(address from, address to, uint256 amount) internal override {
        _requireNotPaused();
        if (from != address(0)) {
            if (to != address(0) && !_isEligible(from)) revert ERC7943CannotSend(from); // redeem skips this
            uint256 unfrozen = _unfrozen(from);
            if (amount > unfrozen && amount <= balanceOf(from)) {
                revert ERC7943InsufficientUnfrozenBalance(from, amount, unfrozen);
            }
        }
        if (to != address(0) && !_isEligible(to)) revert ERC7943CannotReceive(to);
        super._update(from, to, amount);
    }

    function _unfrozen(address account) internal view returns (uint256) {
        uint256 balance = balanceOf(account);
        uint256 frozen = _frozen[account];
        return balance > frozen ? balance - frozen : 0;
    }

    /// @dev Fails closed (decision D3): a reverting, non-contract or malformed slot means "not eligible".
    function _isEligible(address account) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            address(eligibility).staticcall(abi.encodeCall(IEligibility.isEligible, (account)));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }
}
