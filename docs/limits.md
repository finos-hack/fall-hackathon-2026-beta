# Limits and unverified claims

This is a hackathon build on a research model. Read this page before relying on anything in the kit.

- Testnet only. Not audited. Not for production use. The deployer refuses chain id 1.
- No legal or regulatory treatment. A tokenized deposit is a bank liability, not a security; the kit shows the mechanics only.
- Out of scope: net asset value, yield, interest, cash settlement, lock-ups, holder caps and transfer fees.
- Shibui is a research model (version 0.4.0, commit `4414538`). The kit pins it and does not modify it. Upgrading is a deliberate change.
- OnChainTrust and GLEIF vLEI: there is no working integration. The eligibility slot (`IEligibility`) is where one would plug in. No public OnChainTrust contracts were found.
- Private Besu networks were not tested. The contracts target the Cancun EVM. Any Cancun-enabled network should work, but this has not been shown.
- The demo cast is fictional. Credentials carry statuses, codes and a hash, never personal data.
- Keys: locally, the kit uses the public test keys of the local chain (anvil's well-known test mnemonic). They are public and must never hold real value. On Sepolia, one funded key from `.env` is used and the other actors are derived from it.
- `explain` is a read-only view for people. Enforcement is Shibui's `isVerified` alone (decision D2). If the two ever disagreed, enforcement would win; test I9 checks that they agree in every state the tests use.
- After an attester is removed, `explain` can only report "attester not trusted" for attesters it was told to watch (`ShibuiEligibility.watchAttester`). The deployer watches every attester it authorizes.
- Coverage numbers come from `forge coverage --ir-minimum`; Shibui's sources do not compile for coverage without via-IR. Its source maps report inline assembly and some internal calls, such as `_pause` and `_requireNotPaused`, as missed, although every transfer and pause test runs them. So the CI gate holds functions to 100%, branches to 95% and lines to 90%. Measured at the time of writing: `RegulatedToken` 91.2% lines, 100% branches, 100% functions; `ShibuiEligibility` 96.2% lines, 96.4% branches, 100% functions.
