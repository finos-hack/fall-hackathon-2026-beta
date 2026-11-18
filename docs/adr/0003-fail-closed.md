# 0003. Fail closed

Status: accepted. Source: issue #1 D3.

## Context

ERC-7943 forbids the can... views from reverting, and a broken configuration must never open the door.

## Decision

Any failure of the slot (revert, no code, malformed answer) means "not eligible".

## Consequences

A misconfigured product refuses everyone rather than accepting everyone. Conformance check E2.
