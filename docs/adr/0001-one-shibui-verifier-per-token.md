# 0001. One Shibui verifier per token

Status: accepted. Source: issue #1 D1.

## Context

Shibui's verifier holds one topic list, and products need different rules.

## Decision

Each token gets its own ClaimTopicsRegistry, EASTrustedIssuersAdapter and EASClaimVerifier. EAS, the identity proxy and the policies without settings are shared.

## Consequences

More contracts per product. Enforcement stays in Shibui's code, not copied into the kit. Mirrors ERC-3643, where each token has its own registries.
