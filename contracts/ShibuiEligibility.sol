// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEAS} from "@eas/IEAS.sol";
import {Attestation} from "@eas/Common.sol";
import {IEASClaimVerifier} from "@shibui/interfaces/IEASClaimVerifier.sol";
import {IEASTrustedIssuersAdapter} from "@shibui/interfaces/IEASTrustedIssuersAdapter.sol";
import {IEASIdentityProxy} from "@shibui/interfaces/IEASIdentityProxy.sol";
import {IClaimTopicsRegistry} from "@shibui/interfaces/IClaimTopicsRegistry.sol";
import {ITopicPolicy} from "@shibui/policies/ITopicPolicy.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";

/// @title ShibuiEligibility
/// @notice Default eligibility slot. Enforcement is Shibui's own `isVerified`, unchanged (decision D2).
///         `explain` is a separate read-only view that replays the verifier's per-topic check through
///         Shibui's public getters, so a refusal can be shown as "accreditation: policy rejected".
/// @dev Fails closed (decision D3): any failure of the verifier call means "not eligible".
contract ShibuiEligibility is IEligibility, Ownable {
    /// @notice Bound on attesters `explain` inspects beyond the currently trusted ones.
    uint256 public constant MAX_WATCHED_ATTESTERS = 20;

    IEASClaimVerifier public immutable verifier;

    /// @dev Attesters that were ever trusted. Lets `explain` say "attester not trusted" after a removal.
    address[] private _watched;
    mapping(address => bool) private _isWatched;

    event AttesterWatched(address indexed attester);

    error ZeroAddress();
    error TooManyWatchedAttesters();

    constructor(IEASClaimVerifier verifier_, address owner_) Ownable(owner_) {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
    }

    /// @notice Adds an attester to the list `explain` inspects. Explanation only: never affects enforcement.
    function watchAttester(address attester) external onlyOwner {
        if (attester == address(0)) revert ZeroAddress();
        if (_isWatched[attester]) return;
        if (_watched.length >= MAX_WATCHED_ATTESTERS) revert TooManyWatchedAttesters();
        _isWatched[attester] = true;
        _watched.push(attester);
        emit AttesterWatched(attester);
    }

    function watchedAttesters() external view returns (address[] memory) {
        return _watched;
    }

    /// @inheritdoc IEligibility
    function isEligible(address wallet) external view returns (bool result) {
        address target = address(verifier);
        bytes memory data = abi.encodeCall(IEASClaimVerifier.isVerified, (wallet));
        assembly ("memory-safe") {
            mstore(0x00, 0)
            let ok := staticcall(gas(), target, add(data, 0x20), mload(data), 0x00, 0x20)
            result := and(ok, and(eq(returndatasize(), 0x20), eq(mload(0x00), 1)))
        }
    }

    /// @inheritdoc IEligibility
    function explain(address wallet) external view returns (TopicStatus[] memory out) {
        IEAS eas = IEAS(verifier.getEASAddress());
        IEASTrustedIssuersAdapter adapter = IEASTrustedIssuersAdapter(verifier.getTrustedIssuersAdapter());
        IEASIdentityProxy proxy = IEASIdentityProxy(verifier.getIdentityProxy());
        IClaimTopicsRegistry registry = IClaimTopicsRegistry(verifier.getClaimTopicsRegistry());
        if (
            address(eas) == address(0) || address(adapter) == address(0) || address(proxy) == address(0)
                || address(registry) == address(0)
        ) {
            out = new TopicStatus[](1);
            out[0] = TopicStatus(0, Status.MISCONFIGURED);
            return out;
        }
        address identity = proxy.getIdentity(wallet);
        uint256[] memory topics = registry.getClaimTopics();
        out = new TopicStatus[](topics.length);
        for (uint256 i = 0; i < topics.length; i++) {
            out[i] = TopicStatus(topics[i], _topicStatus(eas, adapter, identity, topics[i]));
        }
    }

    /// @dev Mirrors EASClaimVerifier._verifyTopic. Returns OK exactly when that function returns true.
    function _topicStatus(IEAS eas, IEASTrustedIssuersAdapter adapter, address identity, uint256 topic)
        internal
        view
        returns (Status best)
    {
        address policy = verifier.getTopicPolicy(topic);
        bytes32 schema = verifier.getSchemaUID(topic);
        if (policy == address(0) || schema == bytes32(0)) return Status.POLICY_MISSING;

        best = Status.NOT_REGISTERED;
        address[] memory trusted = adapter.getTrustedAttestersForTopic(topic);
        for (uint256 i = 0; i < trusted.length; i++) {
            Status s = _credentialStatus(eas, policy, schema, identity, topic, trusted[i]);
            if (s == Status.OK) return Status.OK;
            if (_rank(s) < _rank(best)) best = s;
        }
        for (uint256 i = 0; i < _watched.length; i++) {
            address a = _watched[i];
            if (adapter.isAttesterTrusted(a, topic)) continue; // already covered above
            if (verifier.getRegisteredAttestation(identity, topic, a) == bytes32(0)) continue;
            if (_rank(Status.ATTESTER_NOT_TRUSTED) < _rank(best)) best = Status.ATTESTER_NOT_TRUSTED;
        }
    }

    function _credentialStatus(
        IEAS eas,
        address policy,
        bytes32 schema,
        address identity,
        uint256 topic,
        address attester
    ) internal view returns (Status) {
        bytes32 uid = verifier.getRegisteredAttestation(identity, topic, attester);
        if (uid == bytes32(0)) return Status.NOT_REGISTERED;
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0) || att.schema != schema) return Status.NOT_REGISTERED;
        if (att.revocationTime != 0) return Status.REVOKED;
        if (att.expirationTime != 0 && att.expirationTime <= block.timestamp) return Status.EXPIRED;
        (bool ok, bytes memory ret) = policy.staticcall(abi.encodeCall(ITopicPolicy.validate, (att)));
        if (ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1) return Status.OK;
        // Investor Eligibility payload: field 8 (index 7) is expirationTimestamp.
        if (att.data.length >= 320) {
            (,,,,,,, uint64 payloadExpiry) =
                abi.decode(att.data, (address, uint8, uint8, uint8, uint8, uint8, uint16, uint64));
            if (payloadExpiry != 0 && payloadExpiry <= block.timestamp) return Status.EXPIRED;
        }
        return Status.POLICY_REJECTED;
    }

    /// @dev Lower is more informative: the reason closest to passing wins.
    function _rank(Status s) internal pure returns (uint256) {
        if (s == Status.OK) return 0;
        if (s == Status.POLICY_REJECTED) return 1;
        if (s == Status.EXPIRED) return 2;
        if (s == Status.REVOKED) return 3;
        if (s == Status.ATTESTER_NOT_TRUSTED) return 4;
        return 5;
    }
}
