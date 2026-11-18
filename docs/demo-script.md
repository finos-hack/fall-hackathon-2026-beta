# Demo script

A talk track of about 6 minutes (5 if you skip the Meet and Today tabs of stories B and C) that follows the demo page (`web/index.html`, published to GitHub Pages from `main`). Press **Next** (or the right arrow) at each ▶. Times are a guide for pacing, not measurements.

Everything on the page is played back from a recording of the real contracts (`npm run record`). Say so once at the start, and point at the provenance line under the menu: it names the commit and the date.

## Overview (0:00 to 0:30)

"This is Interlock, a reference implementation for interoperable regulated tokens on Ethereum. Not a standard: one tested way to connect existing ones. A bank, a fund manager and a private credit firm each run a live token. One credential is checked the same way by all of them, and each still applies its own rules. Then two instruments settle against each other from a CDM trade, and two banks pay each other on their vLEI identity. All the institutions are fictional. Every result you will see was recorded from the contracts at the commit shown here, with its transaction hash. Nothing is simulated."

▶ **Start the tour**

## Story A: Northvale Bank, tokenized deposit (0:30 to 1:30)

- **Meet.** "Northvale is the issuer and the compliance officer. Its whole product is this JSON file: KYC and sanctions. No product-specific code." ▶
- **Today vs on-chain.** "Illustrative: today a weekend payment waits for Monday and each bank reconciles its own ledger. On-chain there is one shared record, and the deposit is still the bank's liability." ▶
- **Play.** Point at the diagram once: "Every step walks the same path: who signs, the token, the eligibility check, Shibui, EAS, the result."
  - A1: "Orchard Logistics deposits cash; Northvale issues 1,000 dDEP to Alice." ▶
  - A2: "Saturday, 22:00 on the block clock. Alice pays Bob. Settled at once: both are verified." ▶
  - A3: "Alice tries to pay Carol. **Refused.** The page says why, by topic: KYC, no credential. The EAS box lights up: there is no credential to find." ▶
  - Fork: optionally click **What if IdentiQ onboards Carol first?** to show the payment going through, then **Next** to come back. "Both branches were recorded: the recorder snapshots the chain, plays one, and rewinds." ▶
  - A4 and A5: "A sanctions hit. IdentiQ revokes Dave's credential, and his next transfer is refused: KYC revoked." ▶ ▶
  - A6: "Withdrawal: Northvale burns 200." ▶ **What this proves** ▶

## Story B: Quillon Asset Management, money market fund (1:30 to 2:15)

Skip **Meet** and **Today** with two presses if short on time.

- B1: "Alice subscribes **with the credential she already has**. No second onboarding." ▶
- B2: "Dave subscribes. **Refused: country.** He may hold the deposit, but the fund has its own country list." ▶
- B3: "Alice posts 200 shares to Bob as collateral. Both are eligible, so it moves." ▶
- Fork: "An incident. Pause everything, or freeze one account?" Next takes the pause:
  - B4 to B7: "Paused: Bob's transfer is refused. A forced transfer still works. Unpause." ▶ ▶ ▶ ▶
- B8: "Bob redeems." ▶ **What this proves** ▶

## Story C: Saltmarsh Credit Partners, private credit note (2:15 to 3:00)

- C1 and C2: "Closing: 250 notes to Bob, who is accredited. Bob sells 50 to Alice. **Refused: accreditation, policy rejected.**" ▶ ▶
- Fork: Next takes **What if Alice gets accredited?** "IdentiQ issues an updated credential, and the sale goes through." ▶ ▶ ▶
- C3 to C5: "A court order. Compliance freezes 100 of Bob's notes; selling more than the unfrozen balance is refused; the judgment is executed with a forced transfer." ▶ ▶ ▶
- C6: "Vendor change: Tallyway replaces IdentiQ on this note. The table shows holders dropping out, then returning once re-attested. The audit trail shows who authorized whom." ▶
- C7: "Repayment." ▶ **What this proves** ▶

## Story D: delivery versus payment, from a CDM trade (3:00 to 4:00)

- **Meet.** "Two instruments, two issuers: Quillon's fund share and Northvale's deposit token. The settlement contract is generic and never holds tokens." ▶ ▶
- D1, D2: "Bob holds fund shares, Alice holds deposit tokens." ▶ ▶
- D3: "The trade arrives as a FINOS CDM TransferInstruction. Interlock settles both legs in one transaction: four steps, and the last one moves both." Open **CDM view**: "The instruction in, Instructed; the same instruction out, Settled, with the transaction hash. Both validated with CDM's own tooling." ▶
- Fork: click **What if Dave tries the same trade?** "The fund refuses Dave by country, so the whole trade reverts: his deposit never moves." **Next** back to the fork, **Next** again. ▶
- D4: "The reverse trade settles the same way." ▶ **What this proves** ▶

## Story E: banks recognised by vLEI (4:00 to 4:45)

- **Meet.** "An interbank deposit token. Same token contract, but its door is OnChainTrust's vLEI slot, not Shibui. The banks are fictional, with test LEIs; OnChainTrust's real test credentials name real banks, so we never show them." ▶ ▶
- E1 to E4: "The bridge attests each bank's wallet; Northvale pays Larkmoor at once." ▶ ▶ ▶ ▶
- E5: "Larkmoor tries to pay a corporate client: refused, vLEI legal entity, no credential." ▶
- Fork (optional): **What if Larkmoor's vLEI credential is revoked?** "The next payment is refused: revoked." ▶ ▶ **What this proves** ▶

## One interface (4:45 to 5:00)

"A third-party app that only knows ERC-7943 asks the same three questions of all four tokens, Shibui-checked or vLEI-checked, and gets consistent answers." ▶

## What it connects (5:00 to 5:20)

"Every block and its state: the token, the slot, Shibui, EAS, OnChainTrust, FINOS CDM, the settlement contract, and a core you can drive with your own signer. On Ethereum; mainnet is refused." ▶

## Limits and what's not solved yet (5:20 to 6:00)

"This is the most important page. First the limits: not a standard, not production, not legal settlement, not private. Then what is missing. The technology works today. What is missing is mostly coordination: rules for relying on someone else's KYC, a trust framework for attesters, a shared meaning of credentials, legal finality, and the choice of network. Then the cash leg and privacy, which are both. The technical work, ISO 20022 messaging, custody and reporting, is known work." Read the closing line: "Adoption depends mostly on agreements between institutions." ▶

## Build on it (6:00 to 6:15)

"Every piece of the demo maps to what you would replace: your Ethereum network, your signer, real attesters, your product files, your backend, your post-trade systems through CDM. And you can test your own token or eligibility check with our conformance suites: `npm run conformance`."

## If something goes wrong

- The page opens but says "No recording yet": run `npm run record` and reload.
- Live questions about a step: each step shows its transaction hash and the state after it; the audit trail at the bottom is rebuilt from on-chain events.
- Do not claim timings or costs: the today-vs-on-chain lanes are labelled illustrative and carry no numbers.
