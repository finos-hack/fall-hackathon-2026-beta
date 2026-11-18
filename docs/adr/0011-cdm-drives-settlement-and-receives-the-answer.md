# 0011. CDM drives settlement and receives the answer

Status: accepted. Source: issue #5 D-B.

## Context

Post-trade systems need a shared vocabulary for on-chain events.

## Decision

A CDM TransferInstruction (Instructed) drives settle(); the same instruction comes back Settled; every movement is exported as CDM. The trade's on-chain ref is the hash of the instruction. CDM does not drive issuance or templates.

## Consequences

Validated with finos-cdm 7.10.0 in CI. BusinessEvent is not used, because it requires a full CDM trade state (docs/cdm-mapping.md).
