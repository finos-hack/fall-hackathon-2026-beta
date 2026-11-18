# EEA Tokenization Starter Kit

**Hackathon Track:** Track 3, "Add a new feature to a FINOS Project". The FINOS project is the [Common Domain Model (CDM)](https://github.com/finos/common-domain-model), a FINOS standard: the kit implements it for tokenized instruments, with settlement instructions in and lifecycle events out as CDM objects (in progress in [#6](https://github.com/finos-hack/fall-hackathon-2026-beta/pull/6)).

**Status:** built and tested locally, version 0.1 in review ([build plan](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/1)). Testnet only, not audited. Sepolia has not been run yet.

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

Each check is proven by automated tests, and `npm run scenario` prints one pass or fail line per check.

- [x] One command starts a local chain with the three tokens, Shibui and a small web console. One setting switches it to Sepolia. *The switch is implemented and checked without sending transactions; a Sepolia run has not been done.*
- [x] Issuance and redemption work for all three tokens.
- [x] An investor with a single KYC attestation can hold the deposit and the fund, and is refused the credit note until they have accreditation.
- [x] Revoking a credential blocks the investor's next transfer, with the reason shown by topic.
- [x] A trusted attester can be replaced, leaving an audit trail.
- [x] Issuer controls work: pause, freeze, forced transfer.
- [x] Adding a fourth product takes a new config file and no new code.
- [ ] A newcomer can follow this README from a clean checkout. *CI follows it on a fresh runner; the dry run by a person who has not seen the repository is still to do.*

## What it connects

| Piece | Role |
|---|---|
| [Shibui](https://github.com/EntEthAlliance/rnd-rwa-erc3643-eas) (EEA) | Eligibility policies: KYC, AML, sanctions, country, accreditation |
| [Ethereum Attestation Service](https://attest.org) | Where KYC providers publish and revoke credentials |
| ERC-20 and [ERC-7943](https://eips.ethereum.org/EIPS/eip-7943) | The token and its standard control interface |
| [OnChainTrust](https://onchaintrust.org/) and GLEIF vLEI | An open slot for the authorization check. Shibui answers it today. OnChainTrust's [`VleiEligibility`](https://github.com/OnChainTrust/vlei-eas-contracts) implements the same slot; the kit has not integrated it yet |
| Networks | Local, Sepolia, or a private Besu network |

## Out of scope

NAV and yield, interest, cash settlement, lock-ups, holder caps and legal treatment. A tokenized deposit is a bank liability, not a security; the kit shows the mechanics only. Shibui is a research model and this kit is a hackathon build: testnet only, not audited, not for production use.

## Installation

You need Node 20 or later and git. Nothing else: Foundry comes from npm.

```bash
git clone https://github.com/finos-hack/fall-hackathon-2026-beta.git
cd fall-hackathon-2026-beta
git submodule update --init
npm install
npm start
```

Then open http://localhost:3000.

The first `npm start` compiles the contracts, which took 141 seconds on the build machine. After that, `npm start` is ready in about 2 seconds: it starts a local chain, deploys EAS, Shibui and one token per file in `templates/`, onboards the demo cast and serves the console. Stop it with Ctrl+C.

Use `git submodule update --init` without `--recursive`. The kit pins Shibui's dependencies at the top level and does not need Shibui's own submodules.

## Usage example

**Console.** The page shows the tokens, a "who may hold what" table and an audit trail read from the chain. The "Act as" switch picks a cast member: operator, issuer, compliance officer, KYC provider A or B, or the investors Alice, Bob, Carol and Dave. The guided story walks through issuance, a transfer, a refused transfer, a revocation, an attester rotation, the issuer controls and adding a product. Keys stay in the server; the browser never sees them.

**Scenario.** One command runs every workflow on a fresh local chain and checks the definition of done, in about 4 seconds:

```bash
npm run scenario
```

```text
PASS 1 One command starts everything locally; one setting switches to Sepolia - ...
PASS 3 One credential lets an investor hold the deposit and the fund; the credit note is refused until accreditation is added - ... dPCN refused ("accreditation: policy rejected") until an updated credential, then issued
PASS 4 Revoking a credential blocks the next transfer, with the reason shown by topic - ... dDEP (KYC: revoked, sanctions: revoked)
...
8 of 8
```

**Command line.** While `npm start` runs, in a second terminal:

```bash
npm run cli -- state
```

```bash
npm run cli -- issue dPCN alice 10
```

The second command is refused: "accreditation: policy rejected". Then give Alice accreditation and try again:

```bash
npm run cli -- onboard alice --accreditation 2
```

```bash
npm run cli -- issue dPCN alice 10
```

`npm run cli -- --help` lists every command: issue, transfer, redeem, freeze, force, pause, unpause, onboard, revoke, authorize and rotate.

**Add a product.** Drop a JSON file in `templates/` and restart. See [docs/add-a-product.md](docs/add-a-product.md).

**Demo page.** A visual walk-through of the three products, for people who do not want to install anything. Three fictional institutions (Northvale Bank, Quillon Asset Management, Saltmarsh Credit Partners) run real operations step by step; some succeed, some are refused, and the page shows why. It also covers interoperability, what is not solved yet, and how to build on the kit.

```bash
npm run record
```

This starts a fresh local chain, deploys the three templates, runs stories A, B and C through the action library and writes `web/data/demo.json` (and `demo.js`). It took about 4 seconds on the build machine. Then open `web/index.html` in a browser; it needs no server. The page only plays the recording back, and shows the commit it was recorded from. The recorder checks every expected outcome, so a contract change that breaks a story makes `npm run record` fail. On every push to `main`, `.github/workflows/pages.yml` records again and publishes `web/` to GitHub Pages. The talk track is in [docs/demo-script.md](docs/demo-script.md).

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `NETWORK` | `local` | `local` or `sepolia`: the one setting |
| `RPC_URL`, `DEPLOYER_KEY` | none | Sepolia only, read from the environment or `.env`. One funded key is enough; the other actors are derived from it and sent a little test ether |
| `PORT` | `3000` | Console port |
| `REDEPLOY` | unset | Sepolia only: `1` deploys again instead of reusing `deployments/sepolia.json` |

Locally, the kit uses the public test keys of the local chain. They are published in Foundry's documentation and must never hold real value. The deployer refuses Ethereum mainnet (chain id 1).

## Development setup

```bash
npm run build
```

```bash
npm test
```

```bash
npm run test:node
```

- `npm run build` compiles the contracts with Foundry from npm.
- `npm test` runs the Solidity unit, fuzz, invariant and integration tests, with integration against the real EAS and the unmodified Shibui.
- `npm run test:node` runs the Node tests: template validation, deployment, the action library, the CLI, the server, the scenario and the demo recorder. Each test starts its own local chain.
- `npm run test:browser` runs the headless-browser tests of the console and of the demo page. It needs Playwright with Chromium installed (`require('playwright')`).

| Path | Contents |
|---|---|
| `templates/` | One JSON file per product: the only thing most users edit |
| `kit.config.json` | The fictional demo cast and what `npm start` seeds |
| `contracts/` | `RegulatedToken`, `IEligibility`, `ShibuiEligibility`, `IERC7943Fungible` |
| `app/` | `actions/` (the shared library), `cli.mjs`, `scenario.mjs`, `server.mjs`, `start.mjs`, `record.mjs` (the demo recorder) |
| `web/` | The demo page: `index.html`, `app.js`, `style.css`. `web/data/` is written by `npm run record` and not committed |
| `test/` | `unit/`, `invariant/`, `integration/` (Solidity), `node/` (Node), `browser/` (headless browser), `fixtures/` |
| `lib/` | Pinned: Shibui `4414538`, EAS 1.9.0, OpenZeppelin 5.6.1, forge-std 1.15.0 |
| `docs/` | [architecture](docs/architecture.md), [add a product](docs/add-a-product.md), [limits](docs/limits.md), [demo script](docs/demo-script.md) |

Read [docs/limits.md](docs/limits.md) before relying on anything here.

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
