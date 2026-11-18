// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";

/// @dev Purpose-built broken contracts: the conformance suites (core/conformance.mjs) must FAIL on each of them.

/// A token whose ERC-7943 views revert, and that claims ERC-7943 anyway.
contract RevertingViewsToken {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x3edbb4c4 || id == 0x01ffc9a7;
    }

    function canSend(address) external pure returns (bool) {
        revert("not today");
    }

    function canReceive(address) external pure returns (bool) {
        revert("not today");
    }

    function canTransfer(address, address, uint256) external pure returns (bool) {
        revert("not today");
    }

    function getFrozenTokens(address) external pure returns (uint256) {
        return 0;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// A slot that says yes to everyone (fails open) while explain says nobody is registered.
contract FailOpenEligibility is IEligibility {
    function isEligible(address) external pure returns (bool) {
        return true;
    }

    function explain(address) external pure returns (TopicStatus[] memory out) {
        out = new TopicStatus[](1);
        out[0] = TopicStatus({topic: 1, status: Status.NOT_REGISTERED});
    }
}

/// A slot whose explain says every topic is OK while isEligible says no.
contract DisagreeingEligibility is IEligibility {
    function isEligible(address) external pure returns (bool) {
        return false;
    }

    function explain(address) external pure returns (TopicStatus[] memory out) {
        out = new TopicStatus[](1);
        out[0] = TopicStatus({topic: 1, status: Status.OK});
    }
}
