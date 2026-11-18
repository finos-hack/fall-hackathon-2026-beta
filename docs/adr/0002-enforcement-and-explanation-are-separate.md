# 0002. Enforcement and explanation are separate

Status: accepted. Source: issue #1 D2.

## Context

Shibui's isVerified gives no reason.

## Decision

Enforcement is Shibui's isVerified. explain() is a separate read-only view that reports each topic's status.

## Consequences

The explanation can never weaken enforcement. The conformance check E4 verifies that the two agree.
