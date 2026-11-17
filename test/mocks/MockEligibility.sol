// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";

/// @title MockEligibility
/// @notice A test stand-in for the eligibility slot. In `Answer` mode it returns the per-wallet answer set with
///         `setEligible`. Every other mode makes the slot misbehave so tests can prove the token fails closed
///         (decision D3) and that the ERC-7943 views never revert (U6).
/// @dev "Be an EOA" cannot be a mode of a deployed contract. Tests get it by pointing the token at an address
///      with no code, or by wiping this contract's code with `vm.etch(address(mock), "")`.
///      `ReturnEmpty` is the closest in-contract equivalent: the call succeeds and returns no data.
contract MockEligibility is IEligibility {
    enum Mode {
        Answer, // well-behaved: returns abi.encode(eligible[wallet])
        Revert, // reverts with a custom error
        RevertEmpty, // reverts with no data
        Panic, // reverts with Panic(0x12), division by zero
        BurnGas, // consumes every unit of gas it is given (INVALID opcode)
        ReturnEmpty, // succeeds with zero bytes of return data, which is what a call to an EOA looks like
        ReturnShort, // succeeds with 31 bytes, one short of an ABI word
        ReturnLong, // succeeds with 64 bytes whose first word is 1 ("true" plus trailing junk)
        ReturnGarbage, // succeeds with exactly 32 bytes holding `garbage`, which is not a valid ABI bool
        ReturnHuge // succeeds with `hugeSize` bytes of zeros (a "return bomb")
    }

    /// @dev Number of modes, so fuzz tests can pick one with `bound`.
    uint8 public constant MODE_COUNT = 10;

    Mode public mode;
    bytes32 public garbage = bytes32(uint256(2));
    uint256 public hugeSize = 1_000_000;
    mapping(address => bool) public eligible;

    error MockSlotDown(address wallet);

    function setMode(Mode m) external {
        mode = m;
    }

    function setGarbage(bytes32 word) external {
        garbage = word;
    }

    function setHugeSize(uint256 size) external {
        hugeSize = size;
    }

    function setEligible(address wallet, bool yes) external {
        eligible[wallet] = yes;
    }

    function setEligibleBatch(address[] calldata wallets, bool yes) external {
        for (uint256 i; i < wallets.length; ++i) {
            eligible[wallets[i]] = yes;
        }
    }

    /// @notice True when this mock is well-behaved and says yes for `wallet`. Ground truth for invariant checks,
    ///         independent of how the token interprets the slot.
    function answersYes(address wallet) external view returns (bool) {
        return mode == Mode.Answer && eligible[wallet];
    }

    function isEligible(address wallet) external view returns (bool) {
        Mode m = mode;
        if (m == Mode.Answer) return eligible[wallet];
        if (m == Mode.Revert) revert MockSlotDown(wallet);
        if (m == Mode.Panic) {
            uint256 zero = uint256(uint160(wallet)) & 0; // not a compile-time constant, so the division happens
            return (1 / zero) == 1;
        }
        bytes32 word = garbage;
        uint256 size = hugeSize;
        // Not marked memory-safe: ReturnHuge hands back memory far beyond the scratch space.
        assembly {
            switch m
            case 2 {
                // RevertEmpty
                revert(0, 0)
            }
            case 4 {
                // BurnGas
                invalid()
            }
            case 5 {
                // ReturnEmpty
                return(0, 0)
            }
            case 6 {
                // ReturnShort: the last 31 bytes of abi.encode(uint256(1))
                mstore(0, 1)
                return(1, 31)
            }
            case 7 {
                // ReturnLong: abi.encode(uint256(1), uint256(1))
                mstore(0, 1)
                mstore(0x20, 1)
                return(0, 0x40)
            }
            case 9 {
                // ReturnHuge: the callee pays to expand memory to `size`, then hands it all back
                return(0, size)
            }
            default {
                // ReturnGarbage
                mstore(0, word)
                return(0, 0x20)
            }
        }
    }

    function explain(address wallet) external view returns (TopicStatus[] memory out) {
        out = new TopicStatus[](1);
        out[0] = TopicStatus({topic: 1, status: eligible[wallet] ? Status.OK : Status.NOT_REGISTERED});
    }
}
