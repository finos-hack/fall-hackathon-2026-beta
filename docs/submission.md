# FINOS Fall 2026 hackathon submission

**Interlock** (the EEA Tokenization Starter Kit) is open-source code showing how regulated tokens from different institutions can work together on Ethereum. An investor or a bank is verified once, and every instrument checks that credential under its own rules. A trade described in FINOS CDM settles two instruments in one transaction, and the result comes back in CDM.

| | |
|---|---|
| Live demo | https://finos-hack.github.io/fall-hackathon-2026-beta/ |
| 61-second video | [The Second Gate](https://finos-hack.github.io/fall-hackathon-2026-beta/) ([MP4](https://raw.githubusercontent.com/finos-hack/fall-hackathon-2026-beta/main/web/media/the-second-gate.mp4)) |
| Talk track for the demo | [demo-script.md](demo-script.md) |
| One-page overview | [overview.md](overview.md) |
| How it was built | [how-we-built-it.md](how-we-built-it.md) |
| Recorded on Sepolia | [Stories D and E against OnChainTrust's live vLEI bridge](https://finos-hack.github.io/fall-hackathon-2026-beta/?recording=sepolia), every transaction linked on Etherscan |
| Architecture (FINOS CALM) | [architecture/README.md](../architecture/README.md) |
| Limits, said plainly | [limits.md](limits.md) |

**Track:** Track 3, "Add a new feature to a FINOS Project". The FINOS standard turned into working software is the Common Domain Model (CDM). The kit's own architecture is also modelled in FINOS CALM.

## Against the judging rubric

| Criterion | What we show | Evidence |
|---|---|---|
| **1. Ecosystem integration** | **FINOS CDM 7.10.0:** a CDM `TransferInstruction` drives delivery versus payment between two institutions' tokens on Ethereum, and comes back marked Settled. Every token movement is also exported as CDM and validated with FINOS's `finos-cdm` package in CI.<br><br>**FINOS CALM 1.3:** the architecture, its flows and its controls as code, validated in strict mode in CI.<br><br>**Also connected:** EEA Shibui (investor eligibility), the Ethereum Attestation Service (credentials), OnChainTrust's GLEIF vLEI bridge (bank identity), ERC-20 with ERC-7943 (the token interface) and OpenZeppelin | [cdm-mapping.md](cdm-mapping.md), [architecture/](../architecture/README.md), demo stories D and F |
| **2. Technical execution** | **A working demo, not slides:** every step on the demo page is played back from a recording of the real contracts, and CI fails if any outcome changes.<br><br>**Run it yourself:** one command (`npm start`) runs the console; `npm run scenario` checks the definition of done and prints 8 of 8.<br><br>**Tests:** unit, fuzz, invariant and integration tests against the real Shibui and EAS; Node and browser tests.<br><br>**Conformance suites:** anyone can run them against their own token or eligibility check | [README](../README.md), [spec.md](spec.md), CI on `main` |
| **3. Business value** | **Three regulated products from fictional institutions:** a tokenized deposit, a money market fund share and a private credit note.<br><br>**Controls regulators expect:** freeze, forced transfer, pause, and redemption for a lapsed investor.<br><br>**Instruments working together:** settlement between institutions, and banks recognised by their vLEI.<br><br>**What still needs agreement:** an honest "not solved yet" list, leading with coordination between institutions: KYC reliance, the trust framework, legal finality, the cash leg, ISO 20022 and core banking | Demo: stories A to F and "What's not solved yet" |
| **Bonus: build velocity** | **About 35 hours** from the written plan to the merged reference implementation.<br><br>**How:** specifications written as GitHub issues, implemented by Claude Code agents, several of them in parallel. Their tests caught real defects before `main`, and CI enforces the rules.<br><br>**Findings for upstream projects:** Shibui and the vLEI bridge disagree on credential freshness ([#12](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/12), [#13](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/13)) | [how-we-built-it.md](how-we-built-it.md) |

## What is not done

- **Sepolia:** stories D and E are recorded on Sepolia against OnChainTrust's live vLEI bridge, main lines only, because a public chain cannot rewind for the branches. The full eight-check scenario is not complete there yet: its first run on 18 Nov deployed the three tokens and passed checks 1 to 4 (deploy, issuance and redemption, one credential across products, and revocation with reasons by topic), then stopped at check 5 when a wallet ran out of test ETH and hit the 60-minute job limit. The limit is now 180 minutes, and the deployment record is kept even when a check fails. A complete run is tracked in [#8](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/8).
- **Dry run by a newcomer:** nobody who hasn't seen the repository has yet followed the README alone. CI does follow it on a fresh runner.
- **Not yet tested:** Besu, a real HSM or MPC signer, and real KYC providers.
- **Not audited.** Testnet only.

These are tracked for after the hackathon in [#8](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/8), and in the upstream feedback issues [#12](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/12) and [#13](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/13).

## Run it

```bash
git clone https://github.com/finos-hack/fall-hackathon-2026-beta.git
cd fall-hackathon-2026-beta
git submodule update --init
npm install
npm start
```

Then open http://localhost:3000. The first start compiles the contracts, which takes a few minutes; after that, `npm start` is ready in seconds.
