# Interlock

**A reference implementation for interoperable regulated tokens on Ethereum.**

> Interlock is open-source code showing how regulated tokens from different institutions can work together on Ethereum. An investor or a bank is verified once, and every instrument checks that same credential under its own rules. Any app can ask any of the tokens the same three questions through ERC-7943. Two instruments settle against each other in one transaction, from a trade described in the FINOS Common Domain Model, and the result comes back in CDM for the back office. A team can run the whole flow in an afternoon, test their own token or eligibility check against it, and see clearly what still has to be built and agreed before production.

Verify once, hold anywhere the rules allow, settle across instruments, and speak the back office's language. On Ethereum.

**Not a standard.** Interlock references existing standards and models and shows one tested way to connect them. Other ways are possible and welcome. Specification: [spec.md](spec.md).

**Ethereum, explicitly.** The contracts target the Ethereum Virtual Machine (Cancun) and run on a local Ethereum node by default, or on the Sepolia testnet with one setting. Ethereum mainnet is refused by design. Other Ethereum-compatible networks, public or permissioned, are expected to work but are not tested.

## What it connects

| Block | Role |
|---|---|
| `RegulatedToken`: ERC-20 + [ERC-7943](https://eips.ethereum.org/EIPS/eip-7943) | The instrument: issue, redeem, transfer, freeze, forced transfer, pause |
| `IEligibility` slot | "May this wallet hold it?"; the answer is pluggable |
| [Shibui](https://github.com/EntEthAlliance/rnd-rwa-erc3643-eas) (EEA) | Eligibility rules per topic for investors |
| [Ethereum Attestation Service](https://attest.org) | Credentials issued and revoked |
| [OnChainTrust](https://github.com/OnChainTrust/vlei-eas-contracts) `VleiEligibility` | Eligibility for legal entities from GLEIF vLEI credentials |
| [FINOS CDM](https://github.com/finos/common-domain-model) 7.10.0 | Settlement driven by a CDM instruction; every movement exported to CDM |
| `DvPSettlement` | Two instruments settle in one transaction |
| [FINOS CALM](https://calm.finos.org) 1.3 | The architecture, flows and controls as code, validated in CI ([architecture/](../architecture/README.md)) |
| Interlock core | Deployer and action library, bring your own signer, conformance suites |

## What you get

| If you are… | You get |
|---|---|
| A bank, fund manager or issuer | Your product as one config file, issuer controls, an audit trail, and settlement against another institution's instrument |
| A KYC or identity provider | One credential many issuers rely on; revocation that takes effect at once; vLEI for entities |
| A developer or vendor | A core library with your own signer, and conformance suites to test your token or eligibility check |
| An architect or risk team | A written [spec](spec.md), [decision records](adr/README.md), a [threat model](threat-model.md), and a plain list of [limits](limits.md) |
| A post-trade or operations team | A reference [mapping](cdm-mapping.md) between on-chain events and CDM |

## The stories (all fictional institutions and people)

| | Story | Shows |
|---|---|---|
| A | Northvale Bank, tokenized deposit | Payment at any hour; refusal for no credential; revocation |
| B | Quillon Asset Management, money market fund share | The same credential reused; a country rule; pause or freeze |
| C | Saltmarsh Credit Partners, private credit note | Accreditation on every sale; a court order; attester replacement |
| D | Delivery versus payment | A fund share against a tokenized deposit, from a CDM instruction, both legs or neither |
| E | Banks recognised by vLEI | Northvale Bank pays Larkmoor Bank in a token whose slot is OnChainTrust's vLEI check |
| F | The CDM view | Every movement and settlement of A to E as a CDM object, validated with CDM's own tooling |

Play them at https://finos-hack.github.io/fall-hackathon-2026-beta/, or locally with `npm run record` and `web/index.html`.

## Limits, and what must be built and agreed around it

See [limits.md](limits.md). In short: not production, not audited, not legal settlement, not a trust framework, not private, a subset of CDM, one chain. Most of what is missing is agreement between institutions: KYC reliance, a trust framework for attesters, the shared meaning of credentials, legal finality and the choice of network. Then the cash leg and privacy, which are both technical and coordination problems. Then custody, ISO 20022 and core-banking integration, and reporting.
