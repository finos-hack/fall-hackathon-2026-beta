# 0004. Real EAS contracts locally

Status: accepted. Source: issue #1 D4.

## Context

Who may authorize an attester is enforced only by the real EAS contracts.

## Decision

The local chain runs the real EAS 1.9.0 contracts, not a mock.

## Consequences

The same behaviour locally and on Sepolia. Two compiler versions in one build (0.8.24 and 0.8.28).
