// The demo recorder (issue #3): `npm run record` plays stories A, B and C through the action library on a fresh
// local chain and writes web/data/demo.json. The recorder asserts every expected outcome itself; this test checks
// the recording it writes: the refusals by topic, the forks, the provenance, the interoperability answers, the
// fictional cast, and that no key reaches the file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import * as kit from '../../core/actions/index.mjs';
import { record, allSteps, STORIES, DEMO_INSTITUTIONS, nextSaturday22, RecordingError } from '../../examples/record.mjs';
import { chainAndContext, copyTemplates, readJson, writeJson, rm, tmpDir, assertNoKeyMaterial, requireArtifacts } from './helpers/kit.mjs';

let dir;
let rec;

before(async () => {
  requireArtifacts();
  dir = tmpDir('eea-kit-record-test-');
  rec = await record({ outDir: dir, log: () => {} });
});
after(() => rm(dir));

const story = (id) => rec.stories.find((s) => s.id === id);
function stepsOf(s) {
  const out = [];
  const walk = (list) => list.forEach((x) => (x.fork ? x.fork.options.forEach((o) => walk(o.steps)) : out.push(x)));
  walk(s.steps);
  return out;
}
const step = (id) => allSteps(rec).find((s) => s.id === id);
const reasonSet = (s) => s.result.reasons.map((r) => `${r.topic}:${r.status}`).sort();

test('the recording is written as JSON and as a script with the same data', () => {
  const json = JSON.parse(readFileSync(path.join(dir, 'demo.json'), 'utf8'));
  const js = readFileSync(path.join(dir, 'demo.js'), 'utf8');
  const prefix = 'window.DEMO_RECORDING = ';
  const body = js.slice(js.indexOf(prefix) + prefix.length).trim().replace(/;$/, '');
  assert.deepEqual(JSON.parse(body), json);
  assert.deepEqual(json, JSON.parse(JSON.stringify(rec)));
});

test('provenance: commit, recording date and network', () => {
  assert.match(rec.commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(rec.commit.short, rec.commit.sha.slice(0, 7));
  assert.equal(typeof rec.commit.dirty, 'boolean');
  assert.ok(!Number.isNaN(Date.parse(rec.recordedAt)));
  assert.equal(rec.network, 'local');
  assert.equal(rec.chainId, 31337);
  assert.equal(rec.explorer, null);
});

test('every step carries who, what, expected and actual result, transactions and the state after', () => {
  const steps = allSteps(rec);
  assert.ok(steps.length >= 30, `only ${steps.length} steps`);
  for (const s of steps) {
    assert.ok(s.actor && s.action && s.title, s.id);
    assert.equal(s.asExpected, true, s.id);
    assert.equal(s.expected, s.result.ok ? 'accepted' : 'refused', s.id);
    assert.ok(!Number.isNaN(Date.parse(s.time)), s.id);
    if (s.result.ok) assert.ok(s.txs.length > 0 && s.txs.every((h) => /^0x[0-9a-f]{64}$/.test(h)), `${s.id} has no transaction hash`);
    else assert.equal(s.txs.length, 0, `${s.id}: a refused call must send nothing`);
    for (const inv of ['alice', 'bob', 'carol', 'dave']) {
      for (const sym of ['dDEP', 'dMMF', 'dPCN']) {
        assert.equal(typeof s.state.matrix[inv][sym].eligible, 'boolean');
        assert.match(s.state.balances[inv][sym].balance, /^\d+(\.\d+)?$/);
      }
    }
    if (s.result.ok && s.kind !== 'credential') assert.ok(s.audit.length > 0, `${s.id} left no audit-trail row`);
  }
});

test('each story has 4 to 8 main steps, at least one refusal with a reason by topic, and a fork with a side branch', () => {
  assert.deepEqual(rec.stories.map((s) => [s.letter, s.token, s.institution]), [
    ['A', 'dDEP', 'Northvale Bank'],
    ['B', 'dMMF', 'Quillon Asset Management'],
    ['C', 'dPCN', 'Saltmarsh Credit Partners'],
  ]);
  for (const s of rec.stories) {
    const main = s.steps.filter((x) => !x.fork).length;
    assert.ok(main >= 4 && main <= 8, `story ${s.letter}: ${main} main steps`);
    assert.ok(stepsOf(s).some((x) => !x.result.ok && x.result.reasons.length > 0), `story ${s.letter}: no refusal by topic`);
    const forks = s.steps.filter((x) => x.fork);
    assert.ok(forks.length >= 1, `story ${s.letter}: no fork`);
    for (const f of forks) {
      assert.equal(f.fork.options.filter((o) => o.continues).length, 1);
      assert.ok(f.fork.options.some((o) => !o.continues && o.steps.length > 0), `${f.fork.id}: no side branch`);
    }
  }
});

test('story A: Saturday payment, refusals for no credential and revocation, redemption', () => {
  const a2 = step('A2');
  assert.equal(a2.time, new Date(nextSaturday22(Date.parse(a2.time) / 1000 - 1) * 1000).toISOString());
  assert.equal(new Date(a2.time).getUTCDay(), 6);
  assert.equal(new Date(a2.time).getUTCHours(), 22);
  assert.equal(step('A3').result.error, 'ERC7943CannotReceive');
  assert.deepEqual(reasonSet(step('A3')), ['KYC:NOT_REGISTERED', 'SANCTIONS:NOT_REGISTERED']);
  assert.ok(step('A3b2').result.ok, 'after onboarding Carol the payment goes through');
  assert.equal(step('A5').result.error, 'ERC7943CannotSend');
  assert.deepEqual(reasonSet(step('A5')), ['KYC:REVOKED', 'SANCTIONS:REVOKED']);
  assert.equal(step('A6').state.balances.alice.dDEP.balance, '700');
  // A side branch is rewound: the next main step does not see Carol's 50 dDEP.
  assert.equal(step('A4').state.balances.carol.dDEP.balance, '0');
});

test('story B: same credential, country refusal, pause vs freeze, forced transfer while paused', () => {
  assert.ok(step('B1').result.ok);
  assert.deepEqual(reasonSet(step('B2')), ['COUNTRY:POLICY_REJECTED']);
  assert.equal(step('B5').result.error, 'EnforcedPause');
  assert.equal(step('B4').state.tokens.dMMF.paused, true);
  assert.ok(step('B6').result.ok, 'a forced transfer works while paused');
  assert.equal(step('B4b2').result.error, 'ERC7943InsufficientUnfrozenBalance');
  assert.ok(step('B4b3').result.ok, 'others keep trading while one account is frozen');
  assert.equal(step('B8').state.balances.bob.dMMF.balance, '0');
});

test('story C: accreditation refusal, court order, attester replacement with an audit trail, repayment', () => {
  assert.deepEqual(reasonSet(step('C2')), ['ACCREDITATION:POLICY_REJECTED']);
  assert.deepEqual(reasonSet(step('C2c1')), ['ACCREDITATION:POLICY_REJECTED', 'COUNTRY:POLICY_REJECTED']);
  assert.ok(step('C2b2').result.ok, 'the sale goes through after accreditation');
  assert.equal(step('C4').result.error, 'ERC7943InsufficientUnfrozenBalance');
  assert.equal(step('C5').state.balances.bob.dPCN.frozen, '0', 'the forced transfer released what it moved');
  const c6 = step('C6');
  assert.deepEqual(c6.result.removedFrom, ['dPCN']);
  assert.equal(c6.result.eligibility.afterRemoval.alice.dPCN, false, 'holders drop out');
  assert.equal(c6.result.eligibility.after.alice.dPCN, true, 'and return once re-attested');
  assert.equal(c6.result.eligibility.after.alice.dDEP, true, 'the other tokens are untouched');
  assert.deepEqual(c6.state.tokens.dPCN.trustedAttesters, ['kyc-provider-b']);
  assert.deepEqual(c6.state.tokens.dDEP.trustedAttesters, ['kyc-provider-a']);
  assert.ok(c6.audit.some((e) => e.action === 'Provider authorized' && e.actorId === 'operator' && /Tallyway Verification/.test(e.detail)), 'who authorized whom');
  assert.ok(c6.audit.some((e) => e.action === 'Attester removed' && /IdentiQ Services/.test(e.detail)));
  assert.equal(step('C7').state.tokens.dPCN.totalSupply, '0');
});

test('each institution signs its own operations', () => {
  const signerOf = Object.fromEntries(Object.values(DEMO_INSTITUTIONS).flatMap((i) => Object.values(i.roles).map((id) => [id, i.institution])));
  for (const s of allSteps(rec)) {
    if (['issue', 'redeem'].includes(s.action) || ['freeze', 'forcedTransfer', 'pause', 'unpause'].includes(s.action)) {
      const t = rec.tokens.find((x) => x.symbol === s.params.token);
      assert.equal(signerOf[s.actor], t.institution, `${s.id} signed by ${s.actor}`);
    }
  }
  for (const t of rec.tokens) assert.deepEqual(t.roles, DEMO_INSTITUTIONS[t.id].roles);
});

test('interoperability: the same ERC-7943 calls answer for all three issuers, consistently with the eligibility matrix', () => {
  assert.equal(rec.interop.interfaceId, '0x3edbb4c4');
  assert.deepEqual(rec.interop.tokens.map((t) => t.symbol).sort(), ['dDEP', 'dMMF', 'dPCN']);
  for (const t of rec.interop.tokens) {
    assert.equal(t.supportsErc7943, true, t.symbol);
    for (const inv of ['alice', 'bob', 'carol', 'dave']) {
      const eligible = rec.baseline.state.matrix[inv][t.symbol].eligible;
      assert.equal(t.parties[inv].canSend, eligible, `${t.symbol} canSend ${inv}`);
      assert.equal(t.parties[inv].canReceive, eligible, `${t.symbol} canReceive ${inv}`);
      if (inv !== 'bob') assert.equal(t.transfers[`bob->${inv}`], eligible, `${t.symbol} canTransfer bob->${inv}`);
    }
  }
});

test('only fictional names; no key in the data file', () => {
  const text = readFileSync(path.join(dir, 'demo.json'), 'utf8');
  assertNoKeyMaterial(assert, text, 'demo.json');
  assert.deepEqual(rec.cast.institutions.map((i) => [i.name, i.monogram]), [
    ['Northvale Bank', 'NB'],
    ['Quillon Asset Management', 'QAM'],
    ['Saltmarsh Credit Partners', 'SCP'],
  ]);
  assert.deepEqual(rec.cast.providers.map((p) => p.name), ['IdentiQ Services', 'Tallyway Verification']);
  assert.deepEqual(rec.cast.investors.map((i) => i.name), ['Alice', 'Bob', 'Carol', 'Dave']);
  const allowed = new Set([...Object.values(rec.cast.names), 'IdentiQ Services', 'Tallyway Verification']);
  for (const s of allSteps(rec)) for (const e of s.audit) if (e.actor) assert.ok(allowed.has(e.actor), `unknown actor name ${e.actor}`);
});

test('the stories the recorder plays are the ones the page shows', () => {
  assert.deepEqual(rec.stories.map((s) => s.id), STORIES.map((s) => s.id));
});

test('template roles: the institution holds the role, the generic issuer does not, and actions default to the role holder', async () => {
  const env = await chainAndContext();
  const tpl = copyTemplates();
  try {
    const f = path.join(tpl, 'tokenized-deposit.json');
    const t = readJson(f);
    t.roles = { issuer: 'northvale-issuer', compliance: 'northvale-compliance' };
    writeJson(f, t);
    await kit.deploy(env.ctx, { templateDirs: [tpl], outFile: false });
    await kit.authorizeProvider(env.ctx, { provider: 'kyc-provider-a' });
    await kit.onboardInvestor(env.ctx, { actor: 'kyc-provider-a', investor: 'alice' });
    const generic = await kit.issue(env.ctx, { actor: 'issuer', token: 'dDEP', to: 'alice', amount: '1' });
    assert.equal(generic.error, 'AccessControlUnauthorizedAccount');
    assert.equal(generic.role, 'ISSUER_ROLE');
    const byDefault = await kit.issue(env.ctx, { token: 'dDEP', to: 'alice', amount: '1' });
    assert.ok(byDefault.ok, byDefault.message);
    assert.equal(byDefault.actor, 'northvale-issuer');
    const pause = await kit.pause(env.ctx, { token: 'dDEP' });
    assert.equal(pause.actor, 'northvale-compliance');
    // Tokens without "roles" keep the default signers.
    assert.ok((await kit.issue(env.ctx, { actor: 'issuer', token: 'dMMF', to: 'alice', amount: '1' })).ok);
    const s = await kit.getState(env.ctx, { audit: false });
    assert.deepEqual(s.tokens.find((x) => x.symbol === 'dDEP').roles, t.roles);
  } finally {
    rm(tpl);
    await env.stop();
  }
});

test('a story whose real outcome changes stops the recording, naming the step', async () => {
  const a = structuredClone(STORIES[0]);
  a.steps = a.steps.slice(0, 3);
  a.steps[2].expect = { ok: true }; // A3 is really refused: Carol has no credential
  await assert.rejects(() => record({ outDir: false, log: () => {}, stories: [a] }), (e) => e instanceof RecordingError && /story A A3 .*expected success, got ERC7943CannotReceive/.test(e.message));
  const b = structuredClone(STORIES[0]);
  b.steps = b.steps.slice(0, 3);
  b.steps[2].expect.reasons = [['KYC', 'REVOKED']];
  await assert.rejects(() => record({ outDir: false, log: () => {}, stories: [b] }), (e) => e instanceof RecordingError && /expected reason KYC REVOKED/.test(e.message));
});
