# Interlock specification, v0.1

Interlock is a **reference implementation for interoperable regulated tokens on Ethereum**. It is not a standard. This document says what the implementation promises at its edges, so other implementations can be compared with it, and its conformance suites (section 9) can check them. Where this document and the code disagree, it is a bug in one of them: please open an issue.

Version 0.1, issue #5. Keywords MUST, MUST NOT and MAY are used as in RFC 2119.

## 1. Scope

- **Network.** Contracts target the Ethereum Virtual Machine, Cancun. Tested on a local Ethereum node (anvil) and specified for the Sepolia testnet. Ethereum mainnet (chain id 1) MUST be refused before any transaction is signed.
- **Parts.** A token (`RegulatedToken`), an eligibility slot interface (`IEligibility`) with two implementations, a settlement contract (`DvPSettlement`), a template format, a cast format, a CDM mapping, and a JavaScript core that deploys and drives them.
- **Not in scope:** economics (yield, NAV, fees), legal treatment, privacy, cross-chain.

## 2. The eligibility slot: `IEligibility`

`contracts/interfaces/IEligibility.sol`. OnChainTrust's `VleiEligibility` implements a verbatim copy of it.

| Function | Rule |
|---|---|
| `isEligible(wallet) → bool` | True only if `wallet` may hold the token now. MUST NOT return true on error (fail closed). MUST NOT revert |
| `explain(wallet) → TopicStatus[]` | One `{topic, status}` per required topic. Read-only, for people; MUST NOT be used for enforcement. MUST NOT revert |

**Agreement.** For every wallet, `isEligible(wallet)` MUST equal "`explain(wallet)` is non-empty and every status is `OK`" (conformance check E4).

**Statuses** (`IEligibility.Status`, in order): `OK`, `NOT_REGISTERED` (no credential), `REVOKED`, `EXPIRED`, `ATTESTER_NOT_TRUSTED`, `POLICY_REJECTED` (live credential, content fails the rule), `POLICY_MISSING`, `MISCONFIGURED`. The last two fail closed.

**Topics.** Shibui numbering: KYC 1, AML 2, country 3, accreditation 7, professional investor 9, institutional investor 10, sanctions 13, source of funds 14, vLEI legal entity 15, vLEI authorized role 16.

## 3. The token: `RegulatedToken`

ERC-20 with the ERC-7943 fungible interface (interface id `0x3edbb4c4`, recomputed from the six selectors in tests). The token asks its slot before every balance change; it never checks eligibility itself.

| Action | Role | Rule |
|---|---|---|
| Transfer, `transferFrom` | Holder (or an approved spender) | Not paused. Sender eligible. Recipient eligible. Amount within the unfrozen balance |
| Issue | `ISSUER_ROLE` | Not paused. Recipient eligible |
| Redeem | `ISSUER_ROLE` | Not paused. Within the unfrozen balance. Holder eligibility not required |
| Freeze (`setFrozenTokens`) | `COMPLIANCE_ROLE` | Sets the frozen amount; may exceed the balance |
| Forced transfer | `COMPLIANCE_ROLE` | Recipient eligible. Works while paused and for an ineligible sender. Unfreezes what it moves |
| Pause, unpause | `COMPLIANCE_ROLE` | Stops transfers, issuance and redemption; forced transfer still works |
| `setEligibility`, roles | Admin | Emits an event; the zero address is refused |

`canSend`, `canReceive` and `canTransfer` MUST NOT revert, including when the slot reverts or returns malformed data.

## 4. Templates

A product is one JSON file. Schema: [`schemas/template.schema.json`](../schemas/template.schema.json). The loader (`core/lib/config.mjs`) applies the schema, plus rules that need other files: attester ids must exist in the cast, ids and symbols must be unique across templates, and roles must name a signer from the cast.

| Field | Meaning |
|---|---|
| `id`, `name`, `symbol`, `decimals` | Identity and ERC-20 metadata |
| `eligibility` | Optional. `{ "source": "shibui" }` (default) or `{ "source": "vlei", "credentialTypes": ["LE", ...], "topic": 15 }` |
| `requiredTopics`, `trustedAttesters` | Shibui only: the topics every holder must pass, and the KYC providers trusted for them |
| `country`, `accreditation` | Shibui only, required when the matching topic is listed |
| `roles` | Optional: who signs issuer and compliance operations (`issuer`, `compliance`, or an institution id). Default: the kit's issuer and compliance roles |
| `labels` | Words for issue and redeem |

## 5. Credentials

**Investors (Shibui).** One EAS attestation under the Investor Eligibility schema, `address identity, uint8 kycStatus, uint8 amlStatus, uint8 sanctionsStatus, uint8 sourceOfFundsStatus, uint8 accreditationType, uint16 countryCode, uint64 expirationTimestamp, bytes32 evidenceHash, uint8 verificationMethod`. It is registered by its attester in each token's verifier, once per topic; an investor cannot register their own. Each topic's policy (Shibui, pinned) reads one field:

| Topic | Passes when |
|---|---|
| KYC | `kycStatus == 1` (verified) |
| AML | `amlStatus == 0` (clear) |
| Sanctions | `sanctionsStatus == 0` (clear) |
| Source of funds | `sourceOfFundsStatus == 1` (verified) |
| Accreditation | `accreditationType` is in the template's `allowedTypes` |
| Country | `countryCode` is in (allow) or not in (block) the template's list |
| Professional investor | `accreditationType >= 1` |
| Institutional investor | `accreditationType == 4` |

Credentials carry statuses, codes and a hash, never personal data.

**Legal entities (vLEI, OnChainTrust).** An EAS attestation from the vLEI bridge under the schema `string lei, string legalName, string credType, string keriAid, bytes32 vleiSaid, uint64 verifiedAt`, gated by `AttesterResolver` to one bridge wallet. `VleiEligibility` accepts a wallet when its registered attestation is under that schema, from that attester, issued to that wallet, not revoked, not expired, and of an accepted credential type. Liveness is EAS liveness (`verifiedAt` is not a freshness signal). Anyone may register an attestation UID for a wallet; a stranger cannot replace a live one with an older one.

## 6. The cast

Who takes part: roles (operator, issuer, compliance), KYC providers, investors, institutions, and an optional local vLEI bridge with its holders. Schema: [`schemas/kit-config.schema.json`](../schemas/kit-config.schema.json). Every id is unique across the file. **The cast holds no keys.**

## 7. Settlement: `DvPSettlement`

Delivery versus payment between two parties and two ERC-20 tokens.

1. Each party approves `DvPSettlement` for its own leg on its own token.
2. One party calls `propose(delivery, payment, deadline, ref)`. The legs MUST mirror each other: delivery from seller to buyer, payment from buyer to seller, in two different tokens, both amounts above zero.
3. The other party calls `affirm(id)`, which moves both legs with `transferFrom` in the same transaction. Any refusal on either leg reverts both.
4. Either party MAY `cancel` an unsettled trade; an expired trade cannot settle.

The contract MUST NOT hold tokens, so each token checks the real sender and recipient of its leg. `ref` is the keccak256 of the canonical JSON of the CDM instruction being settled (section 8).

## 8. CDM

FINOS CDM 7.10.0, `TransferInstruction`: in (Instructed, two legs) to drive settlement, and out (Settled, with the transaction hash), plus one-leg instructions for every movement. Rules: [`docs/cdm-mapping.md`](cdm-mapping.md). Objects MUST validate with `finos-cdm` 7.10.0, including Rune conditions.

## 9. Signers

The core (`core/index.mjs`) holds no keys. `createContext({ rpcUrl, cast, signers })` takes one viem `Account` per cast member: a local key, a remote signer (an HSM or MPC service wrapped with `toAccount`), or a JSON-RPC account. In **prepare mode** (`withMode(ctx, 'prepare')`), every single-transaction action simulates and returns the unsigned transaction `{from, to, data, value, chainId}` instead of sending it. Multi-transaction actions refuse with `PrepareNotSupported`. Refusals are still decoded with the reason by topic.

## 10. Conformance

`npm run conformance` (`core/conformance.mjs`), read-only, needs only an RPC URL and an address:

| Id | Check |
|---|---|
| T1 | The ERC-7943 interface id of the six functions is `0x3edbb4c4` |
| T2 to T4 | `supportsInterface` answers ERC-7943 and ERC-165 correctly |
| T5 to T7 | `canSend`, `canReceive`, `canTransfer` and `getFrozenTokens` never revert |
| T8 | `canTransfer` is false beyond the unfrozen balance |
| E1 | `isEligible` and `explain` never revert |
| E2 | Fails closed: a stranger is not eligible |
| E3 | `explain` reports at least one topic, with a known status |
| E4 | `explain` agrees with `isEligible` |
| E5 | Optional: answers what an expectations file says |

## 11. Versioning

This is v0.1. Breaking changes to sections 2, 3, 4, 5, 7 or 8 bump the minor version until 1.0. The pinned upstreams are Shibui `4414538`, OnChainTrust `vlei-eas-contracts` `f036d82`, EAS contracts 1.9.0, OpenZeppelin 5.6.1, and FINOS CDM 7.10.0.
