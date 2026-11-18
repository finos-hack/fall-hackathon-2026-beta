# 0008. Node and git only

Status: accepted. Source: issue #1 D8.

## Context

The easiest possible start.

## Decision

Foundry comes from npm (@foundry-rs/forge, @foundry-rs/anvil). CDM validation needs Python, but only in CI and for developers who want it (CDM_PYTHON).

## Consequences

No global Foundry, Docker or wallet extension needed to run the kit.
