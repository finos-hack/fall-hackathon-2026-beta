// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IEligibility
/// @notice The eligibility slot: the single question a RegulatedToken asks before any balance moves.
/// @dev Think of the token as a club and the slot as its door. The club never checks IDs itself.
///      Shibui answers today (ShibuiEligibility); OnChainTrust or vLEI can answer later without
///      touching the token.
interface IEligibility {
    /// @notice Per-topic outcome reported by `explain`.
    enum Status {
        OK, // a trusted attester's live credential satisfies the topic policy
        NOT_REGISTERED, // no credential registered for this topic
        REVOKED, // the registered credential was revoked on EAS
        EXPIRED, // the credential expired (EAS-level or in its own payload)
        ATTESTER_NOT_TRUSTED, // a credential exists, but its attester is no longer trusted for the topic
        POLICY_REJECTED, // the credential is live, but its content fails the topic policy
        POLICY_MISSING, // the topic has no policy or schema configured: fails closed
        MISCONFIGURED // the eligibility source itself is not wired up: fails closed
    }

    struct TopicStatus {
        uint256 topic;
        Status status;
    }

    /// @notice True if `wallet` may hold the token right now. Implementations must not grant on error.
    function isEligible(address wallet) external view returns (bool);

    /// @notice Each required topic with its status. Read-only, never used for enforcement.
    function explain(address wallet) external view returns (TopicStatus[] memory);
}
