# 0014. vLEI through OnChainTrust's slot, with fictional banks

Status: accepted. Source: issue #5 D-D, D-E.

## Context

OnChainTrust's real Sepolia credentials name real institutions; the demo must use fictional ones.

## Decision

The interbank deposit token uses OnChainTrust's VleiEligibility (pinned, unmodified). CI and the public demo use a local test bridge under the same schema, with fictional banks (Larkmoor Bank) and test LEIs. A manual Sepolia recording uses the real bridge and never writes the real names.

## Consequences

Shibui's VLEIPolicy is not used, because it treats verifiedAt as freshness and the bridge does not refresh it. The recorder refuses to write a Sepolia recording that contains a real name or LEI.
