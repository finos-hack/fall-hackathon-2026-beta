// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IERC7943Fungible
/// @notice ERC-7943 (uRWA, Final) interface for ERC-20 based tokens. https://eips.ethereum.org/EIPS/eip-7943
/// @dev Interface ID 0x3edbb4c4. Recomputed in test/unit/RegulatedToken.t.sol rather than trusted.
interface IERC7943Fungible is IERC165 {
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount);
    event Frozen(address indexed account, uint256 amount);

    error ERC7943CannotSend(address account);
    error ERC7943CannotReceive(address account);
    error ERC7943CannotTransfer(address from, address to, uint256 amount);
    error ERC7943InsufficientUnfrozenBalance(address account, uint256 amount, uint256 unfrozen);

    function forcedTransfer(address from, address to, uint256 amount) external returns (bool result);
    function setFrozenTokens(address account, uint256 amount) external returns (bool result);
    function canSend(address account) external view returns (bool allowed);
    function canReceive(address account) external view returns (bool allowed);
    function getFrozenTokens(address account) external view returns (uint256 amount);
    function canTransfer(address from, address to, uint256 amount) external view returns (bool allowed);
}
