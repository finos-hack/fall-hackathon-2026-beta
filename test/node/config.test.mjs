// C1: a bad template stops the deployment with a clear message naming the file and the field,
// BEFORE any transaction. Each case runs through deploy() against this file's own anvil, and the test then
// proves nothing was sent (operator nonce 0, chain still at block 0, no deployment record written).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { deploy } from '../../app/actions/deploy.mjs';
import { ConfigError, loadTemplates, loadKitConfig, listTemplateFiles } from '../../app/lib/config.mjs';
import { chainAndContext, copyTemplates, readJson, writeJson, rm, tmpDir, runNode, TEMPLATES, FIXTURES, ROOT } from './helpers/kit.mjs';

let env;
const kit = loadKitConfig();

before(async () => {
  env = await chainAndContext();
});
after(async () => {
  await env?.stop();
});

/** Builds a temp template dir from the shipped templates, lets `mutate(dir)` break it, and expects deploy to refuse. */
async function expectRefused({ mutate, file, field, match }) {
  const dir = copyTemplates();
  try {
    mutate(dir);
    const record = env.ctx.deploymentFile;
    await assert.rejects(
      () => deploy(env.ctx, { templateDirs: [dir] }),
      (e) => {
        assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e.name}: ${e.message}`);
        assert.equal(path.basename(e.file), file, `message should name the file: ${e.message}`);
        assert.equal(e.field, field, `message should name the field: ${e.message}`);
        assert.ok(e.message.includes(file) && e.message.includes(field), `message must contain file and field: ${e.message}`);
        if (match) assert.match(e.message, match);
        return true;
      },
    );
    // Nothing was sent: the operator never signed, no block was mined, no record was written.
    const operator = env.ctx.actors.operator.address;
    assert.equal(await env.ctx.publicClient.getTransactionCount({ address: operator }), 0, 'a transaction was sent');
    assert.equal(await env.ctx.publicClient.getBlockNumber({ cacheTime: 0 }), 0n, 'a block was mined');
    assert.ok(!existsSync(record), 'a deployment record was written');
  } finally {
    rm(dir);
  }
}

const edit = (name, fn) => (dir) => {
  const f = path.join(dir, name);
  const t = readJson(f);
  fn(t);
  writeJson(f, t);
};

test('C1 shipped templates and the fixture are valid and load in file-name order', () => {
  const t = loadTemplates([TEMPLATES], kit);
  assert.deepEqual(
    t.map((x) => x.symbol),
    ['dMMF', 'dPCN', 'dDEP'],
  );
  assert.deepEqual(t.find((x) => x.symbol === 'dPCN').accreditation.allowedTypes, [2, 3, 4]);
  assert.deepEqual(t.find((x) => x.symbol === 'dMMF').country, { mode: 'allow', codes: [840, 826, 250] });
  const f = loadTemplates([FIXTURES], kit);
  assert.equal(f.length, 1);
});

test('C1 unknown topic name stops the deployment', () =>
  expectRefused({
    mutate: edit('tokenized-deposit.json', (t) => (t.requiredTopics = ['KYC', 'KYCC'])),
    file: 'tokenized-deposit.json',
    field: 'requiredTopics[1]',
    match: /unknown topic "KYCC"/,
  }));

test('C1 unknown attester id stops the deployment', () =>
  expectRefused({
    mutate: edit('money-market-fund.json', (t) => (t.trustedAttesters = ['kyc-provider-z'])),
    file: 'money-market-fund.json',
    field: 'trustedAttesters[0]',
    match: /unknown attester "kyc-provider-z"/,
  }));

test('C1 empty symbol stops the deployment', () =>
  expectRefused({ mutate: edit('private-credit-note.json', (t) => (t.symbol = '  ')), file: 'private-credit-note.json', field: 'symbol' }));

test('C1 missing symbol stops the deployment', () =>
  expectRefused({ mutate: edit('private-credit-note.json', (t) => delete t.symbol), file: 'private-credit-note.json', field: 'symbol', match: /missing/ }));

test('C1 duplicate id stops the deployment', () =>
  expectRefused({
    // zz- sorts after the shipped files, so the copy is the second file with that id.
    mutate: (dir) => writeJson(path.join(dir, 'zz-copy.json'), { ...readJson(path.join(TEMPLATES, 'tokenized-deposit.json')), symbol: 'dDEP2' }),
    file: 'zz-copy.json',
    field: 'id',
    match: /duplicate id "tokenized-deposit"/,
  }));

test('C1 duplicate symbol stops the deployment (case-insensitive)', () =>
  expectRefused({
    mutate: (dir) => writeJson(path.join(dir, 'zz-copy.json'), { ...readJson(path.join(TEMPLATES, 'tokenized-deposit.json')), id: 'another-deposit', symbol: 'ddep' }),
    file: 'zz-copy.json',
    field: 'symbol',
    match: /duplicate symbol/,
  }));

test('C1 COUNTRY without a country setting stops the deployment', () =>
  expectRefused({ mutate: edit('money-market-fund.json', (t) => delete t.country), file: 'money-market-fund.json', field: 'country', match: /COUNTRY/ }));

test('C1 COUNTRY with no country codes stops the deployment', () =>
  expectRefused({ mutate: edit('money-market-fund.json', (t) => (t.country.codes = [])), file: 'money-market-fund.json', field: 'country.codes' }));

test('C1 ACCREDITATION without accreditation.allowedTypes stops the deployment', () =>
  expectRefused({
    mutate: edit('private-credit-note.json', (t) => (t.accreditation = {})),
    file: 'private-credit-note.json',
    field: 'accreditation.allowedTypes',
    match: /ACCREDITATION/,
  }));

test('C1 ACCREDITATION with no accreditation block stops the deployment', () =>
  expectRefused({ mutate: edit('private-credit-note.json', (t) => delete t.accreditation), file: 'private-credit-note.json', field: 'accreditation' }));

test('C1 decimals above 18 stops the deployment', () =>
  expectRefused({ mutate: edit('tokenized-deposit.json', (t) => (t.decimals = 19)), file: 'tokenized-deposit.json', field: 'decimals', match: /out of range/ }));

test('C1 negative or fractional decimals stop the deployment', async () => {
  await expectRefused({ mutate: edit('tokenized-deposit.json', (t) => (t.decimals = -1)), file: 'tokenized-deposit.json', field: 'decimals', match: /out of range/ });
  await expectRefused({ mutate: edit('tokenized-deposit.json', (t) => (t.decimals = 1.5)), file: 'tokenized-deposit.json', field: 'decimals', match: /out of range/ });
});

test('C1 a file that is not valid JSON names the file', () =>
  expectRefused({ mutate: (dir) => writeFileSync(path.join(dir, 'broken.json'), '{ "id": "x", '), file: 'broken.json', field: '(file)', match: /not valid JSON/ }));

test('C1 a template without an id names the field', () =>
  expectRefused({ mutate: (dir) => writeJson(path.join(dir, 'no-id.json'), { name: 'x', symbol: 'X', decimals: 6 }), file: 'no-id.json', field: 'id', match: /missing/ }));

test('C1 kit.config.json: unknown topic and duplicate cast id are refused with file and field', () => {
  const dir = tmpDir();
  try {
    const base = readJson(path.join(ROOT, 'kit.config.json'));
    const bad1 = structuredClone(base);
    bad1.attesters[1].authorizedTopics.push('NOPE');
    writeJson(path.join(dir, 'a.json'), bad1);
    assert.throws(() => loadKitConfig(path.join(dir, 'a.json')), (e) => e instanceof ConfigError && e.field === 'attesters[1].authorizedTopics[8]' && /unknown topic "NOPE"/.test(e.message));
    const bad2 = structuredClone(base);
    bad2.investors[3].id = 'alice';
    writeJson(path.join(dir, 'b.json'), bad2);
    assert.throws(() => loadKitConfig(path.join(dir, 'b.json')), (e) => e instanceof ConfigError && e.field === 'investors[3].id' && /duplicate cast id/.test(e.message));
  } finally {
    rm(dir);
  }
});

test('C1 npm start stops on a bad template before starting a chain', async () => {
  const dir = copyTemplates();
  try {
    edit('tokenized-deposit.json', (t) => (t.requiredTopics = ['KYC', 'KYCC']))(dir);
    // RPC_URL points at this file's chain so that, were validation skipped, start would try to use it.
    const r = await runNode(['app/start.mjs'], { env: { TEMPLATE_DIRS: dir, RPC_URL: env.anvil.url, NETWORK: 'local', PORT: '0' } });
    assert.equal(r.code, 1, `start should exit 1\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /tokenized-deposit\.json: field "requiredTopics\[1\]": unknown topic "KYCC"/);
    assert.doesNotMatch(r.stdout, /Local chain|Console listening|Deploying/);
    assert.equal(await env.ctx.publicClient.getTransactionCount({ address: env.ctx.actors.operator.address }), 0);
  } finally {
    rm(dir);
  }
});

test('C1 the shipped templates/ folder holds exactly the three demo products', () => {
  const files = listTemplateFiles([TEMPLATES]).map((f) => path.basename(f));
  assert.deepEqual(files, ['money-market-fund.json', 'private-credit-note.json', 'tokenized-deposit.json']);
  assert.ok(readdirSync(FIXTURES).includes('fourth-product.json'));
});
