# Slither triage

Slither 0.11.6 on the kit contracts (`--filter-paths "lib/|test/" --exclude-dependencies`), issue #5 round: 82 contracts analyzed with 102 detectors, **19 results**. CI runs Slither on every push (report only, does not block). Each result is listed with the decision taken.

| Detector | Where | Results | Decision |
|---|---|---|---|
| `arbitrary-send-erc20` (arbitrary `from` in `transferFrom`) | `DvPSettlement.affirm` | 2 | **False positive, by design.** `from` is a party of a trade that the counterparty affirms; the proposer must be one of the two parties and the legs must mirror each other, so a third party can neither propose for someone else's tokens alone nor affirm. Tested in `test_onlyAPartyProposes`, `test_onlyTheCounterpartyAffirms` and `test_legsMustMirrorEachOther` (`test/unit/DvPSettlement.t.sol`). |
| `calls-loop` | `ShibuiEligibility.explain` and its helpers | 9 | **Accepted.** `explain` is a read-only view for people, bounded by the token's required topics and watched attesters; enforcement never uses it. |
| `timestamp` | `DvPSettlement.propose`, `affirm`; `ShibuiEligibility` expiry checks | 4 | **Accepted.** Trade deadlines and credential expiries are calendar times; a validator's few seconds of drift do not matter. |
| `assembly` | `RegulatedToken._isEligible`, `ShibuiEligibility.isEligible` | 2 | **Accepted, deliberate.** Copies at most 32 bytes of the slot's answer, so a misbehaving slot cannot make the ERC-7943 views revert (fail closed, ADR 0003). |
| `low-level-calls` | `ShibuiEligibility._credentialStatus` (`staticcall` to a policy) | 1 | **Accepted, deliberate.** A failing policy reads as `POLICY_REJECTED` instead of reverting `explain`. |
| `cache-array-length` | `ShibuiEligibility` loop over `_watched` | 1 | **Accepted.** Gas only, in a view function. |

No result calls for a code change in this round. The upstream contracts (Shibui, OnChainTrust, EAS, OpenZeppelin) are excluded: they are used as published at pinned versions.
