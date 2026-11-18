// S7 (issue #5): a token whose eligibility slot is OnChainTrust's VleiEligibility (pinned, unmodified), against a
// local test bridge under the real bridge schema. Fictional banks, test LEIs. The same RegulatedToken contract as
// every other product; only the template's "eligibility" setting differs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as kit from '../../core/actions/index.mjs';
import { entityOf } from '../../core/actions/vlei.mjs';
import { schemaUid, VLEI_BRIDGE_SCHEMA } from '../../core/actions/deploy.mjs';
import { chainAndContext, ROOT, TEMPLATES } from './helpers/kit.mjs';

let env;
let ctx;
const IBD = 'dIBD';

before(async () => {
  env = await chainAndContext();
  ctx = env.ctx;
  await kit.deploy(ctx, { templateDirs: [TEMPLATES, path.join(ROOT, 'examples', 'templates')], outFile: false });
});
after(() => env?.stop());

test('vLEI: the deployer wires a local test bridge under the OnChainTrust schema, and a VleiEligibility slot', async () => {
  const d = ctx.deployment;
  assert.equal(d.vlei.local, true);
  assert.equal(d.vlei.attester, ctx.actors['vlei-bridge'].address);
  assert.equal(d.vlei.schemaUid, schemaUid(VLEI_BRIDGE_SCHEMA, d.vlei.resolver, true), 'same schema string as the live bridge, local resolver');
  const t = d.tokens.find((x) => x.symbol === IBD);
  assert.equal(t.eligibilitySource, 'vlei');
  assert.deepEqual(t.topics, ['VLEI_LEGAL_ENTITY']);
  assert.equal(t.verifier, null, 'no Shibui set for a vLEI token');
  const slot = await ctx.publicClient.readContract({ address: t.eligibility, abi: ctx.abis.VleiEligibility, functionName: 'attester' });
  assert.equal(slot, d.vlei.attester);
});

test('vLEI: an entity with a live bridge attestation is eligible; others are refused with the reason by topic', async () => {
  for (const holder of ['northvale-treasury', 'larkmoor-treasury']) {
    const r = await kit.onboardEntity(ctx, { holder });
    assert.ok(r.ok, r.message);
    assert.deepEqual(r.registrations.map((x) => x.token), [IBD]);
  }
  assert.ok((await kit.issue(ctx, { token: IBD, to: 'northvale-treasury', amount: '1000000' })).ok);
  const pay = await kit.transfer(ctx, { actor: 'northvale-treasury', token: IBD, to: 'larkmoor-treasury', amount: '250000' });
  assert.ok(pay.ok, pay.message);
  // A retail investor holds no vLEI credential: refused, with the vLEI topic as the reason.
  const retail = await kit.transfer(ctx, { actor: 'larkmoor-treasury', token: IBD, to: 'alice', amount: '1' });
  assert.equal(retail.error, 'ERC7943CannotReceive');
  assert.deepEqual(retail.reasons.map((x) => x.text), ['vLEI legal entity: no credential']);
  const t = ctx.deployment.tokens.find((x) => x.symbol === IBD);
  const who = await entityOf(ctx, t, ctx.actors['larkmoor-treasury'].address);
  assert.deepEqual([who.legalName, who.lei, who.credType], ['Larkmoor Bank', 'INTERLOCKTESTLMB0002', 'LE']);
  assert.match(who.reason, /^ok: LE credential of Larkmoor Bank/);
});

test('vLEI: revocation by the bridge blocks the next transfer, with "revoked"', async () => {
  assert.ok((await kit.revokeEntity(ctx, { holder: 'larkmoor-treasury' })).ok);
  const r = await kit.transfer(ctx, { actor: 'northvale-treasury', token: IBD, to: 'larkmoor-treasury', amount: '1' });
  assert.equal(r.error, 'ERC7943CannotReceive');
  assert.deepEqual(r.reasons.map((x) => x.text), ['vLEI legal entity: revoked']);
  const back = await kit.transfer(ctx, { actor: 'larkmoor-treasury', token: IBD, to: 'northvale-treasury', amount: '1' });
  assert.equal(back.error, 'ERC7943CannotSend', 'a revoked entity cannot send either');
});

test('vLEI: state and audit trail show the slot, the entities and the bridge', async () => {
  const s = await kit.getState(ctx);
  const t = s.tokens.find((x) => x.symbol === IBD);
  assert.deepEqual(t.trustedAttesters.map((a) => a.id), ['vlei-bridge']);
  assert.deepEqual(s.entities.map((e) => e.id), ['northvale-treasury', 'larkmoor-treasury']);
  assert.equal(s.matrix['northvale-treasury'][IBD].eligible, true);
  assert.equal(s.matrix['larkmoor-treasury'][IBD].eligible, false);
  assert.equal(s.balances['larkmoor-treasury'][IBD].balance, '250000');
  const actions = s.auditTrail.map((e) => e.action);
  for (const a of ['vLEI credential issued', 'vLEI credential registered', 'vLEI credential revoked']) assert.ok(actions.includes(a), a);
  assert.ok(s.auditTrail.some((e) => e.action === 'vLEI credential issued' && /Larkmoor Bank \(LEI INTERLOCKTESTLMB0002\)/.test(e.detail)));
  // Shibui tokens are untouched by any of this.
  assert.equal(s.matrix.alice.dDEP.eligible, false, 'no Shibui onboarding was done in this test');
});

test('vLEI: a vLEI template without any bridge is refused before anything is sent', async () => {
  const noBridge = { ...ctx, kit: { ...ctx.kit, vlei: undefined }, vleiBridge: null, chainId: ctx.chainId };
  await assert.rejects(() => kit.deploy(noBridge, { templateDirs: [path.join(ROOT, 'examples', 'templates')], outFile: false }), /needs a bridge/);
});
