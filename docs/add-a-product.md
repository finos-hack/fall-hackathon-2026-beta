# Add a product

A product is one JSON file in `templates/`. The deployer reads every file in that folder, so a fourth product needs no code change.

1. Copy an existing template, for example `templates/money-market-fund.json`, to `templates/<your-id>.json`.
2. Edit the fields:

| Field | Meaning |
|---|---|
| `id` | Unique, lower-case, used in file names and the console |
| `name`, `symbol` | ERC-20 name and symbol. The symbol must be unique |
| `decimals` | ERC-20 decimals (0 to 18) |
| `requiredTopics` | Who may hold it: any of `KYC`, `AML`, `COUNTRY`, `ACCREDITATION`, `PROFESSIONAL`, `INSTITUTIONAL`, `SANCTIONS`, `SOURCE_OF_FUNDS` |
| `trustedAttesters` | KYC provider ids from `kit.config.json` |
| `country` | Required if `COUNTRY` is listed: `{ "mode": "allow" or "block", "codes": [ISO 3166-1 numeric codes] }` |
| `accreditation` | Required if `ACCREDITATION` is listed: `{ "allowedTypes": [...] }`, where 1 = retail qualified, 2 = accredited, 3 = qualified purchaser and 4 = institutional |
| `labels` | Words the console uses for issue and redeem, for example "Subscription" and "Redemption" |

3. Restart: `npm start`.

The deployer checks every template before sending any transaction. It stops with a message naming the file and the field if a topic or attester is unknown, a symbol is empty or duplicated, or a country or accreditation setting is missing.

`test/fixtures/templates/fourth-product.json` is a worked example. The automated test C2 deploys it and runs it through the scenario.

Anything that needs new logic, such as yield, lock-ups or holder caps, is out of scope for a template (don't #3).
