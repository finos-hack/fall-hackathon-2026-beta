// The CLI runs in a separate process from whoever deployed: it reads the deployment record, looks credential
// UIDs up on chain, and calls the same action library.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../../app/actions/index.mjs';
import { parseArgs, toAction } from '../../app/cli.mjs';
import { chainAndContext, runNode, assertNoKeyMaterial } from './helpers/kit.mjs';

let env;
const cli = (...args) => runNode(['app/cli.mjs', ...args, '--deployment', env.ctx.deploymentFile], { env: { NETWORK: 'local', RPC_URL: '' } });

before(async () => {
  env = await chainAndContext();
  await kit.deploy(env.ctx, {}); // writes the record (with the local RPC URL) to a temp file
  await kit.seedDemo(env.ctx);
});
after(async () => {
  await env?.stop();
});

test('CLI argument mapping', () => {
  const p = parseArgs(['transfer', 'dDEP', 'alice', 'bob', '5', '--json']);
  assert.deepEqual(toAction(p.command, p.args, p.flags), { action: 'transfer', actor: 'alice', params: { token: 'dDEP', from: 'alice', to: 'bob', amount: '5' } });
  const o = parseArgs(['onboard', 'carol', '--country', '826', '--accreditation=3', '--provider', 'kyc-provider-a']);
  assert.deepEqual(toAction(o.command, o.args, o.flags), {
    action: 'onboardInvestor',
    actor: 'kyc-provider-a',
    params: { investor: 'carol', credential: { countryCode: 826, accreditationType: 3 } },
  });
  assert.throws(() => toAction('issue', ['dDEP'], {}), /usage: issue/);
  assert.throws(() => toAction('teleport', [], {}), /unknown command/);
});

test('CLI --help exits 0 and lists every command', async () => {
  const r = await runNode(['app/cli.mjs', '--help']);
  assert.equal(r.code, 0);
  for (const c of ['state', 'issue', 'transfer', 'redeem', 'freeze', 'force', 'pause', 'unpause', 'onboard', 'revoke', 'authorize', 'rotate']) {
    assert.match(r.stdout, new RegExp(`\\n  ${c}\\b`), c);
  }
});

test('CLI state --json matches the in-process state and holds no keys', async () => {
  const r = await cli('state', '--json');
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  const mine = await kit.getState(env.ctx);
  assert.deepEqual(s.matrix, mine.matrix);
  assert.deepEqual(s.auditTrail, mine.auditTrail);
  assertNoKeyMaterial(assert, r.stdout, 'cli state');
});

test('CLI refusal prints the reason and exits 1', async () => {
  const r = await cli('issue', 'dPCN', 'alice', '3');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /REFUSED issue/);
  assert.match(r.stdout, /accreditation: policy rejected/);
});

test('CLI revoke finds the UID on chain from another process; the next transfer is refused', async () => {
  const r = await cli('revoke', 'alice');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK revokeCredential/);
  const t = await cli('transfer', 'dDEP', 'alice', 'bob', '1');
  assert.equal(t.code, 1);
  assert.match(t.stdout, /KYC: revoked/);
  const s = await kit.getState(env.ctx);
  assert.equal(s.matrix.alice.dDEP.eligible, false);
});

test('CLI rotate replaces the provider; the readable state shows the new attester', async () => {
  const r = await cli('rotate', 'kyc-provider-a', 'kyc-provider-b', '--json');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(res.reattested.map((x) => x.investor).sort(), ['bob', 'dave']);
  const st = await cli('state');
  assert.match(st.stdout, /KYC Provider B/);
  assert.match(st.stdout, /Attester removed/);
});
