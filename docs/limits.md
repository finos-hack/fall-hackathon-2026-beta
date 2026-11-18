# Limits and unverified claims

This is a hackathon build of a reference implementation, on research code. It is not a standard. Read this page before relying on anything in the kit.

- Testnet only. Not audited. Not for production use. The deployer refuses chain id 1.
- No legal or regulatory treatment. A tokenized deposit is a bank liability, not a security; the kit shows the mechanics only.
- Out of scope: net asset value, yield, interest, cash settlement, lock-ups, holder caps and transfer fees.
- Shibui is a research model (version 0.4.0, commit `4414538`). The kit pins it and does not modify it. Upgrading is a deliberate change.
- OnChainTrust and GLEIF vLEI: `VleiEligibility` from [vlei-eas-contracts](https://github.com/OnChainTrust/vlei-eas-contracts) is integrated, pinned and unmodified, and tested against a local test bridge. It has not been run against OnChainTrust's live bridge from this repository yet (see the Sepolia recording).
- The demo page (`web/`) plays back a recording made on a local chain by `npm run record`. The Sepolia recording (`npm run record:sepolia`, played at `?recording=sepolia`) records only the main lines of stories D and E, because public networks cannot rewind. OnChainTrust's live test credentials on Sepolia are ECR (engagement context role) credentials, not LE (legal entity), so on Sepolia the dIBD slot accepts both; the local demo accepts LE only.
- Delivery versus payment (`DvPSettlement`) proves atomic exchange of two tokens. It is not legal settlement finality, and the cash leg in the demo is a fictional bank's deposit token, not central bank money or a payment system.
- FINOS CDM coverage is a subset: `TransferInstruction` for settlement and movements (docs/cdm-mapping.md). No `BusinessEvent` or trade lifecycle, no products. Validation uses `finos-cdm` 7.10.0, with workarounds for two package defects.
- vLEI: the public demo uses a local test bridge under OnChainTrust's schema, with fictional banks and test LEIs that are not checksum-valid and belong to no real entity. OnChainTrust's real Sepolia credentials name real institutions and are only ever shown as labelled links.
- The core takes any viem Account as a signer; only a simulated remote signer is tested, not a real HSM, MPC service or custodian.
- The name: an unrelated web3 project called "Interlock Network" exists; a trademark check is needed before any logo or package name.
- Private Besu networks were not tested. The contracts target the Cancun EVM. Any Cancun-enabled network should work, but this has not been shown.
- The demo cast is fictional. Credentials carry statuses, codes and a hash, never personal data.
- Keys: locally, the kit uses the public test keys of the local chain (anvil's well-known test mnemonic). They are public and must never hold real value. On Sepolia, one funded key from `.env` is used and the other actors are derived from it.
- `explain` is a read-only view for people. Enforcement is Shibui's `isVerified` alone (decision D2). If the two ever disagreed, enforcement would win; test I9 checks that they agree in every state the tests use.
- After an attester is removed, `explain` can only report "attester not trusted" for attesters it was told to watch (`ShibuiEligibility.watchAttester`). The deployer watches every attester it authorizes.
- Coverage numbers come from `forge coverage --ir-minimum`; Shibui's sources do not compile for coverage without via-IR. Its source maps report inline assembly and some internal calls, such as `_pause` and `_requireNotPaused`, as missed, although every transfer and pause test runs them. So the CI gate holds functions to 100%, branches to 95% and lines to 90%. Measured at the time of writing: `RegulatedToken` 91.2% lines, 100% branches, 100% functions; `ShibuiEligibility` 96.2% lines, 96.4% branches, 100% functions.
