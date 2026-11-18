# 0012. Core and demo are separate; bring your own signer

Status: accepted. Source: issue #5 S3, S4.

## Context

The action library sat next to the demo cast and its keys, so no institution could reuse it.

## Decision

core/ holds no cast and no keys; createContext takes one viem Account per cast member. Prepare mode returns unsigned transactions. examples/ holds the quickstart.

## Consequences

test/node/core.test.mjs runs the whole flow with a remote signer and no kit key.
