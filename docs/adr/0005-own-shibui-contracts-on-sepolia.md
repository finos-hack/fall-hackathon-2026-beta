# 0005. Own Shibui contracts on Sepolia

Status: accepted. Source: issue #1 D5.

## Context

The kit needs operator rights to set topics and attesters.

## Decision

On Sepolia the kit deploys its own Shibui contracts and resolver, and reuses the public EAS.

## Consequences

A Sepolia deployment costs more gas, but is fully controlled.
