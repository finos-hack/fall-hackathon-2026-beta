# 0010. Settlement between instruments: a generic DvP

Status: accepted. Source: issue #5 D-A.

## Context

Issue #1 put cash settlement out of scope; instruments working together needs atomic settlement.

## Decision

DvPSettlement: each party approves its leg, one proposes, the other affirms, and the affirmation moves both legs with transferFrom. The contract never holds tokens.

## Consequences

Each regulated token checks the real sender and recipient of its leg, and any refusal reverts both legs. Not legal finality (docs/limits.md).
