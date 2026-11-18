# 0006. No product-specific Solidity

Status: accepted. Source: issue #1 D6.

## Context

"A new product is a file, not code" must stay true and testable.

## Decision

Products differ only in their template file. Generic contracts (DvPSettlement) are allowed; product logic is not.

## Consequences

Anything needing new logic (yield, lock-ups) is out of scope. Scenario check 7 and test C2 prove it.
