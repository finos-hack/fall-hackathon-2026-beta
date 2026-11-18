# How we built it

Interlock went from a written plan to a merged reference implementation in about 35 hours. One human contributor directed [Claude Code](https://claude.com/claude-code), Anthropic's AI coding agent. Every piece started as a written specification in a GitHub issue. AI agents implemented it, tested it and opened pull requests, and the contributor made the decisions and merged. CI checked every rule.

## The loop

1. **Specification first.** Each stage began as an issue covering scope, design decisions, definition of done, don'ts and named tests: [#1](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/1) for the kit, [#3](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/3) for the demo site and [#5](https://github.com/finos-hack/fall-hackathon-2026-beta/issues/5) for Interlock. The contributor reviewed and directed every specification; #1 and #3 were drafted with Claude Code.
2. **Agents build against the specification, in parallel.** Each independent part had its own agent, its own files and its own build directory:
   - unit and fuzz tests for the token;
   - integration tests against the real Shibui and EAS contracts;
   - the Node deployer and action library;
   - the web console.

   Later stages ran in separate Claude Code sessions, one per issue, with no overlap.
3. **Tests are written to fail.** Agents were told never to weaken a test to get green. A test that exposed a defect stayed red, and the defect was reported and fixed. Agents also checked their tests by breaking the code on purpose (mutation checks): 7 of 7 finished mutants caught for the token, 9 of 9 for the integration suite, and 7 deliberate breakages for the Node core.
4. **A human decides.** The contributor chose:
   - the hackathon track;
   - the fictional cast (no real bank names);
   - the scope cuts and the order of work;
   - the working name;
   - every merge.

   The coordination with OnChainTrust was done by people.
5. **CI is the referee.** Every pull request runs:
   - the build, contract sizes and formatting;
   - the Solidity, Node and browser tests;
   - a coverage gate;
   - a clean-checkout run of the whole kit;
   - the demo recorder, which asserts every story outcome;
   - CDM validation with `finos-cdm`;
   - the FINOS CALM model check;
   - Slither (reported, not blocking);
   - DCO sign-off;
   - a check that no AI session link enters the history.

## Timeline (UTC)

| When | What |
|---|---|
| 17 Nov 08:04 | Build plan posted as issue #1 |
| 17 Nov 13:55 | First commit: proof that Shibui (Solidity 0.8.24) and the real EAS contracts (0.8.28) build together |
| 17 Nov 16:45 | Kit merged ([#2](https://github.com/finos-hack/fall-hackathon-2026-beta/pull/2)): token, eligibility slot, Shibui and EAS wiring, deployer, action library, CLI, console, scenario 8 of 8 |
| 17 Nov 23:09 | Demo site specification posted (#3) |
| 18 Nov 09:31 | Demo site merged ([#4](https://github.com/finos-hack/fall-hackathon-2026-beta/pull/4)) and live on GitHub Pages |
| 18 Nov 17:09 | Interlock specification posted (#5) |
| 18 Nov 19:05 | Interlock merged ([#6](https://github.com/finos-hack/fall-hackathon-2026-beta/pull/6)): reusable core, delivery versus payment driven by FINOS CDM, OnChainTrust vLEI slot, conformance suites |

## What the tests caught before it reached `main`

The agents' tests failed against the first versions of the code. These were fixed:

- **`forcedTransfer` could mint and burn.** A forced transfer from or to the zero address created or destroyed supply without the issuer role, because ERC-20's internal `_update` has no zero-address checks.
- **A misbehaving eligibility check could make the ERC-7943 views revert,** by returning a huge answer. The standard says those views must not revert. The token now reads at most 32 bytes of the answer.
- **The explanation view reverted** when the verifier had no code. It now reports "misconfigured".
- **After a KYC provider was replaced, a revoked credential read "attester not trusted"**, suggesting that re-trusting the provider would help. It now reads "revoked".
- **A test overwrote the local deployment record** that a running `npm start` uses.
- **Two compiler copies of the same contract halved the measured coverage.** The kit contracts are now pinned to one compiler version.

Building on other projects also surfaced findings for their maintainers. These are coordination problems more than bugs:

- **Shibui and the OnChainTrust bridge disagree on what makes a vLEI credential fresh.** Shibui's vLEI policy rejects a credential whose `verifiedAt` is older than six hours; the bridge does not refresh that field.
- **Two defects in the `finos-cdm` 7.10.0 Python package,** each with a workaround, recorded in the [CDM mapping](cdm-mapping.md).
- **"Interlock Network", an unrelated web3 project, already exists,** so the name needs a trademark check before any logo or package.

## By the numbers

Measured on `main` at commit `50696ea`, after the Sepolia recording work merged:

| | |
|---|---|
| Solidity tests (unit, fuzz, invariant, integration against the real Shibui and EAS) | 136 passing |
| Node tests (config and schemas, core, deploy, actions, settlement and CDM, vLEI, conformance, CLI, server, recorder, scenario) | 139 passing, none skipped |
| Browser tests (console and demo site, keyboard, reduced motion, 375 px) | 20 passing |
| Lines of code, excluding JSON and media: Solidity contracts / core / examples / demo page / tests | 522 / 3,356 / 4,104 / 1,531 / 6,781 |
| Decision records | 14 ([docs/adr](adr/README.md)) |

## What this does not show

- **AI-written code is not audited code.** Tests, fuzzing, invariants, mutation checks and Slither reduce risk, but no external auditor has reviewed this. It is testnet only.
- **Speed came from specifications and checks, not from skipping them.** Every claim on the demo and in the docs is tied to a test or a recording, and [limits.md](limits.md) lists what is not solved.

## Architecture as code

The architecture is modelled in [FINOS CALM](https://calm.finos.org) and validated in CI. The model includes the building blocks, how they connect, four flows, and eight controls, each tied to its decision record and tests. The generated diagrams and tables are in [architecture/README.md](../architecture/README.md).
