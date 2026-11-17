# EEA Tokenization Starter Kit

**Hackathon Track:** {track name/number}

**Status:** specification. Nothing below is built yet; the definition of done is the build plan.

An open-source kit that issues three sample regulated tokens with one command: a tokenized deposit, a money market fund share and a private credit note. Each is a standard ERC-20 with issuer controls (pause, freeze, forced transfer, redeem), and each is defined by one small config file. Every "who may hold this?" check runs through [Shibui](https://github.com/EntEthAlliance/rnd-rwa-erc3643-eas), the Enterprise Ethereum Alliance's open-source eligibility layer.

## Outcome

Any institution can try compliant tokenization in an afternoon, on a local chain or a public testnet, without writing Solidity. Investors are verified once and recognised across all three tokens, and each token still applies its own rules.

## The three templates

| Template | Who may hold it (Shibui topics) | Issuance |
|---|---|---|
| Tokenized deposit | KYC + sanctions | Mint on deposit, burn on withdrawal |
| Money market fund share | KYC + AML + country | Mint on subscription, burn on redemption |
| Private credit note | KYC + accreditation + country | Mint at closing, burn at repayment |

A template is one config file: name, symbol, required topics and trusted attesters. Adding a fourth product is a new file, not new code.

## Definition of done

- [ ] One command starts a local chain with the three tokens, Shibui and a small web console. One setting switches it to Sepolia.
- [ ] Issuance and redemption work for all three tokens.
- [ ] An investor with a single KYC attestation can hold the deposit and the fund, and is refused the credit note until they have accreditation.
- [ ] Revoking a credential blocks the investor's next transfer, with the reason shown by topic.
- [ ] A trusted attester can be replaced, leaving an audit trail.
- [ ] Issuer controls work: pause, freeze, forced transfer.
- [ ] Adding a fourth product takes a new config file and no new code.
- [ ] A newcomer can follow this README from a clean checkout.

## What it connects

| Piece | Role |
|---|---|
| [Shibui](https://github.com/EntEthAlliance/rnd-rwa-erc3643-eas) (EEA) | Eligibility policies: KYC, AML, sanctions, country, accreditation |
| [Ethereum Attestation Service](https://attest.org) | Where KYC providers publish and revoke credentials |
| ERC-20 and [ERC-7943](https://eips.ethereum.org/EIPS/eip-7943) | The token and its standard control interface |
| [OnChainTrust](https://onchaintrust.org/) and GLEIF vLEI | An open slot for the authorization check. Shibui answers it today; OnChainTrust plugs in once its contracts are available |
| Networks | Local, Sepolia, or a private Besu network |

## Out of scope

NAV and yield, interest, cash settlement, lock-ups, holder caps and legal treatment. A tokenized deposit is a bank liability, not a security; the kit shows the mechanics only. Shibui is a research model and this kit is a hackathon build: testnet only, not audited, not for production use.

## Installation

Not available yet. The target is one command from a clean checkout.

## Usage example

To be added with the first build: the web console walking through issuance, a refused transfer, a revocation and an attester rotation.

## Development setup

To be added with the first build.

## Roadmap

This project was built during a time-boxed FINOS hackathon. After the hackathon, if the project continues:

1. Connect OnChainTrust and vLEI credentials to the authorization slot.
2. Offer full ERC-3643 (T-REX) as an alternative token base.
3. Drive issuance and lifecycle events from FINOS CDM objects and a Fluxnova workflow.
4. Run a pilot with one issuer, one KYC provider and two tokens.

## Contributing

Coding agents should follow [AGENTS.md](./AGENTS.md), which requires a Developer Certificate of Origin sign-off on every commit.

**All commits** must be signed with a DCO signature to avoid being flagged by the DCO Bot. This means that your commit log message must contain a line that looks like the following one, with your actual name and email address:

```
Signed-off-by: John Doe <john.doe@example.com>
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more information.

## License

Copyright 2026 FINOS

Distributed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).

SPDX-License-Identifier: [Apache-2.0](https://spdx.org/licenses/Apache-2.0)
