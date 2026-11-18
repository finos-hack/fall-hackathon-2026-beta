# Threat model

What Interlock protects, who can do what, and what is left to the people who deploy it. Interlock is a reference implementation on Ethereum testnets: **not audited, not for production use**. This page is for risk and architecture teams evaluating the design, not a security guarantee.

## Assets

- Token balances, and who may hold each token.
- The integrity of eligibility answers (a wallet must not hold a token it is not eligible for).
- Atomicity of settlement (a party must never deliver without being paid, or the reverse).
- The link between an on-chain trade and its CDM record.
- Privacy of people and institutions (no personal data on chain; no real names in the demo).
- Signing keys.

## Who can do what

| Actor | Can | Cannot |
|---|---|---|
| Admin of a token (operator) | Grant and revoke roles; change the eligibility slot | Move tokens directly |
| `ISSUER_ROLE` | Issue to eligible wallets; redeem (even from a lapsed holder) | Issue to an ineligible wallet |
| `COMPLIANCE_ROLE` | Freeze, pause, unpause, force a transfer to an eligible wallet | Force to an ineligible wallet; issue or redeem |
| Operator of a Shibui set | Choose trusted attesters (with a live Issuer Authorization), topics and policies | Authorize an attester without being a registered authorizer of the resolver |
| KYC provider (attester) | Issue and revoke its own credentials; register them per token | Revoke another provider's credential |
| vLEI bridge | Issue and revoke bridge attestations (enforced by `AttesterResolver`) | Make a wallet eligible on a Shibui token |
| Holder | Transfer within the rules; approve and affirm a DvP trade | Register their own credential; settle a trade they are not party to |
| Anyone | Register an existing vLEI attestation for its own recipient; read everything | Replace a live vLEI registration with an older attestation |

The admin and compliance roles are powerful by design: a regulated issuer needs them (issue #1, section 3.3). They are the first thing to put behind custody (HSM, MPC, multi-signature) in a real deployment.

## Threats and mitigations

| Threat | Mitigation in Interlock | Left to the deployer |
|---|---|---|
| A broken or malicious eligibility slot lets everyone in | Fail closed: any revert, missing code or malformed answer means "not eligible" (ADR 0003); conformance checks E1, E2 and E4 | Review any slot before `setEligibility`; monitor the event |
| `explain` disagrees with enforcement | Enforcement never uses `explain` (ADR 0002); test I9 and conformance E4 | — |
| A compromised attester issues false credentials | Per-token trusted-attester lists; replacement leaves an audit trail (story C, W7) | Trust framework, monitoring, revocation procedures |
| A revoked credential is still honoured | Shibui and `VleiEligibility` read EAS liveness on every check; the next transfer is refused | — |
| A stale vLEI attestation | `VleiEligibility` relies on EAS expiry and revocation, not `verifiedAt` (ADR 0014) | The bridge's renewal and revocation process |
| A DvP leg moves without the other | Both legs move in one transaction; any refusal reverts both; the contract never holds tokens; fuzz test | — |
| A third party settles someone else's trade | Only the counterparty can affirm; legs must mirror the two parties | — |
| An approval is left open after a cancelled trade | Approvals are per party and per amount; `cancel` stops settlement | Clear allowances after cancelling (approve 0) |
| Reentrancy during settlement | `nonReentrant` on `affirm`; state set to Settled before transfers | — |
| The CDM record and the on-chain trade diverge | `ref` = keccak256 of the canonical CDM instruction, stored with the trade and emitted | Store the instruction; recompute the hash when reconciling |
| Keys exposed by the tools | The core holds no keys; the console never returns one (test X3); keys are not enumerable on actors | Custody and key management (ADR 0012: bring your own signer) |
| Running against mainnet by mistake | Chain id read before anything; chain id 1 refused before signing (C3) | — |
| Personal or real-institution data published | Credentials carry codes and a hash; the demo cast is fictional; the Sepolia recorder refuses to write real names or LEIs | Privacy-preserving network or credentials (docs/limits.md) |
| Front-running a visible trade | Not mitigated: trades are public on a public chain | Permissioned network, private mempool, or off-chain matching |

## Static analysis

Slither runs in CI (report only, does not block). The run for this round is triaged in [`docs/slither.md`](slither.md).

## Out of scope

Legal finality, operational resilience, key ceremonies, economic attacks on real markets, and the security of upstream code (Shibui, OnChainTrust, EAS, OpenZeppelin), which is used as published at pinned versions.
