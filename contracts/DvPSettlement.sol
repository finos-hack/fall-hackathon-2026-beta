// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DvPSettlement
/// @notice Delivery versus payment between two parties and two ERC-20 tokens (for example a fund share against a
///         tokenized deposit), settled in one transaction: both legs move, or neither does.
/// @dev Generic and product-agnostic: no token, product or party is special. The contract never holds tokens. Each
///      party approves its own leg on its own token, the trade is proposed by one party and affirmed by the other,
///      and the affirmation settles it with `transferFrom` on both tokens. A regulated token therefore checks the
///      real sender and recipient of each leg (for ERC-7943 tokens: eligibility, pause, frozen balance), and any
///      refusal reverts the whole trade. `ref` ties the trade to an off-chain record, such as the hash of the
///      CDM TransferInstruction it settles.
contract DvPSettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One leg: `amount` of `token` moves from `from` to `to`.
    struct Leg {
        address token;
        address from;
        address to;
        uint256 amount;
    }

    enum State {
        None,
        Proposed,
        Settled,
        Cancelled
    }

    struct Trade {
        Leg delivery;
        Leg payment;
        uint64 deadline;
        bytes32 ref;
        address proposer;
        State state;
    }

    mapping(bytes32 => Trade) private _trades;
    mapping(address => uint256) public nonces;

    event TradeProposed(bytes32 indexed id, bytes32 indexed ref, address indexed proposer, Leg delivery, Leg payment, uint64 deadline);
    event TradeSettled(bytes32 indexed id, bytes32 indexed ref, address affirmedBy);
    event TradeCancelled(bytes32 indexed id, address indexed by);

    error InvalidLegs();
    error NotAParty(address caller);
    error NotProposed(bytes32 id);
    error Expired(bytes32 id);
    error OwnProposal(bytes32 id);

    /// @notice Proposes a two-party exchange. The caller must be one of the two parties. Returns the trade id.
    /// @dev The legs must mirror each other: delivery goes from the seller to the buyer, payment from the buyer to
    ///      the seller, in two different tokens, both amounts above zero.
    function propose(Leg calldata delivery, Leg calldata payment, uint64 deadline, bytes32 ref)
        external
        returns (bytes32 id)
    {
        if (
            delivery.token == address(0) || payment.token == address(0) || delivery.token == payment.token
                || delivery.from == address(0) || delivery.to == address(0) || delivery.from == delivery.to
                || delivery.from != payment.to || delivery.to != payment.from || delivery.amount == 0
                || payment.amount == 0
        ) revert InvalidLegs();
        if (msg.sender != delivery.from && msg.sender != payment.from) revert NotAParty(msg.sender);
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline <= block.timestamp) revert Expired(bytes32(0));
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonces[msg.sender]++, delivery, payment, deadline, ref));
        _trades[id] = Trade(delivery, payment, deadline, ref, msg.sender, State.Proposed);
        emit TradeProposed(id, ref, msg.sender, delivery, payment, deadline);
    }

    /// @notice The counterparty affirms the trade, which settles both legs in this transaction.
    function affirm(bytes32 id) external nonReentrant {
        Trade storage t = _trades[id];
        if (t.state != State.Proposed) revert NotProposed(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > t.deadline) revert Expired(id);
        address counterparty = t.proposer == t.delivery.from ? t.payment.from : t.delivery.from;
        if (msg.sender == t.proposer) revert OwnProposal(id);
        if (msg.sender != counterparty) revert NotAParty(msg.sender);
        t.state = State.Settled;
        IERC20(t.delivery.token).safeTransferFrom(t.delivery.from, t.delivery.to, t.delivery.amount);
        IERC20(t.payment.token).safeTransferFrom(t.payment.from, t.payment.to, t.payment.amount);
        emit TradeSettled(id, t.ref, msg.sender);
    }

    /// @notice Either party withdraws a trade that has not settled.
    function cancel(bytes32 id) external {
        Trade storage t = _trades[id];
        if (t.state != State.Proposed) revert NotProposed(id);
        if (msg.sender != t.delivery.from && msg.sender != t.payment.from) revert NotAParty(msg.sender);
        t.state = State.Cancelled;
        emit TradeCancelled(id, msg.sender);
    }

    function trade(bytes32 id) external view returns (Trade memory) {
        return _trades[id];
    }
}
