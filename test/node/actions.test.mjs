// The shared action library: refusals come back as data with reasons by topic (never thrown), nothing is sent
// for a refused action (simulate first), and getState has the documented shape and never carries key material.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../../app/actions/index.mjs';
import { sendTx } from '../../app/lib/tx.mjs';
import { openDeployment } from '../../app/lib/context.mjs';
import { chainAndContext, assertNoKeyMaterial, CAST_TABLE } from './helpers/kit.mjs';

let env;
let ctx;
const nonceOf = (id) => ctx.publicClient.getTransactionCount({ address: ctx.actors[id].address });

before(async () => {
  env = await chainAndContext();
  ctx = env.ctx;
  await kit.deploy(ctx, {});
  await kit.seedDemo(ctx);
});
after(async () => {
  await env?.stop();
});

test('X1/I2 issuing the credit note to Alice is refused with the accreditation reason, decoded by name', async () => {
  const before = await nonceOf('issuer');
  const r = await kit.issue(ctx, { token: 'dPCN', to: 'alice', amount: '10' });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'issue');
  assert.equal(r.error, 'ERC7943CannotReceive');
  assert.equal(r.account, ctx.actors.alice.address);
  assert.equal(r.accountId, 'alice');
  assert.deepEqual(r.reasons, [{ topic: 'ACCREDITATION', topicId: 7, status: 'POLICY_REJECTED', text: 'accreditation: policy rejected' }]);
  assert.match(r.message, /Alice may not receive dPCN \(accreditation: policy rejected\)/);
  assert.equal(await nonceOf('issuer'), before, 'a refused action must not send a transaction');
});

test('I1 Carol, with no credential, is refused for KYC on every token', async () => {
  for (const sym of ['dDEP', 'dMMF', 'dPCN']) {
    const r = await kit.issue(ctx, { token: sym, to: 'carol', amount: '1' });
    assert.equal(r.error, 'ERC7943CannotReceive', sym);
    assert.ok(r.reasons.some((x) => x.topic === 'KYC' && x.status === 'NOT_REGISTERED' && x.text === 'KYC: no credential'), sym);
  }
});

test('U2/U3/U5 sender-side and control refusals decode: unfrozen balance, pause, missing role', async () => {
  assert.equal((await kit.freeze(ctx, { token: 'dDEP', account: 'bob', amount: '995' })).ok, true);
  const f = await kit.transfer(ctx, { actor: 'bob', token: 'dDEP', to: 'alice', amount: '10' });
  assert.equal(f.error, 'ERC7943InsufficientUnfrozenBalance');
  assert.equal(f.args.unfrozen, '5000000');
  assert.match(f.message, /Bob has only 5 dDEP unfrozen, 10 dDEP needed/);
  assert.equal((await kit.freeze(ctx, { token: 'dDEP', account: 'bob', amount: '0' })).ok, true);

  const role = await kit.pause(ctx, { actor: 'issuer', token: 'dDEP' });
  assert.equal(role.error, 'AccessControlUnauthorizedAccount');
  assert.equal(role.role, 'COMPLIANCE_ROLE');
  assert.equal(role.accountId, 'issuer');

  assert.equal((await kit.pause(ctx, { token: 'dDEP' })).ok, true);
  const p = await kit.transfer(ctx, { actor: 'alice', token: 'dDEP', to: 'bob', amount: '1' });
  assert.equal(p.error, 'EnforcedPause');
  assert.match(p.message, /dDEP is paused/);
  assert.equal((await kit.unpause(ctx, { token: 'dDEP' })).ok, true);
  assert.equal((await kit.transfer(ctx, { actor: 'alice', token: 'dDEP', to: 'bob', amount: '1' })).ok, true);
});

test('I6 EAS refusal decodes: only the operator may authorize a KYC provider', async () => {
  const r = await kit.authorizeProvider(ctx, { actor: 'issuer', provider: 'kyc-provider-b' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'InvalidAttestation');
  const s = await kit.getState(ctx, { audit: false });
  assert.ok(s.tokens.every((t) => t.trustedAttesters.every((a) => a.id !== 'kyc-provider-b')));
});

test('I7 Shibui refusal decodes: an investor cannot register their own credential', async () => {
  const d = ctx.deployment;
  const dep = d.tokens.find((t) => t.symbol === 'dDEP');
  const uid = await ctx.publicClient.readContract({
    address: dep.verifier,
    abi: ctx.abis.EASClaimVerifier,
    functionName: 'getRegisteredAttestation',
    args: [ctx.actors.alice.address, 1n, ctx.actors['kyc-provider-a'].address],
  });
  const r = await sendTx(ctx, 'alice', { address: dep.verifier, abi: ctx.abis.EASClaimVerifier, functionName: 'registerAttestation', args: [ctx.actors.alice.address, 1n, uid] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Error');
  assert.equal(r.args.reason, 'Caller not authorized');
});

test('W2 an untrusted provider is refused before any credential is written', async () => {
  const before = await nonceOf('kyc-provider-b');
  const r = await kit.onboardInvestor(ctx, { actor: 'kyc-provider-b', investor: 'carol', credential: { countryCode: 840 } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'AttesterNotTrusted');
  assert.equal(await nonceOf('kyc-provider-b'), before);
});

test('bad input never throws: unknown token, bad amount, unknown actor, unknown action', async () => {
  const a = await kit.issue(ctx, { token: 'NOPE', to: 'alice', amount: '1' });
  assert.equal(a.error, 'BadRequest');
  assert.match(a.message, /unknown token "NOPE"/);
  const b = await kit.issue(ctx, { token: 'dDEP', to: 'alice', amount: '-3' });
  assert.equal(b.error, 'BadRequest');
  const c = await kit.issue(ctx, { token: 'dDEP', to: 'alice', amount: '1.0000001' });
  assert.match(c.message, /more than 6 decimal places/);
  const d = await kit.pause(ctx, { actor: 'mallory', token: 'dDEP' });
  assert.match(d.message, /unknown actor "mallory"/);
  const e = await kit.runAction(ctx, { action: 'selfDestruct', params: {} });
  assert.equal(e.error, 'UnknownAction');
});

test('W6 revocation (UID looked up on chain) blocks the next transfer with "KYC: revoked"', async () => {
  const r = await kit.revokeCredential(ctx, { investor: 'dave' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.actor, 'kyc-provider-a', 'signed by the attester');
  const t = await kit.transfer(ctx, { actor: 'dave', token: 'dDEP', to: 'bob', amount: '1' });
  assert.equal(t.error, 'ERC7943CannotSend');
  assert.deepEqual(
    t.reasons.map((x) => x.text),
    ['KYC: revoked', 'sanctions: revoked'],
  );
  const again = await kit.revokeCredential(ctx, { investor: 'dave' });
  assert.equal(again.error, 'NoLiveCredential');
});

test('getState: documented shape, cast table, balances, on-chain audit trail', async () => {
  const s = await kit.getState(ctx);
  for (const k of ['network', 'chainId', 'blockNumber', 'deployBlock', 'contracts', 'schemas', 'actors', 'investors', 'tokens', 'matrix', 'balances', 'auditTrail']) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.network, 'local');
  assert.equal(s.tokens.length, 3);
  for (const t of s.tokens) {
    for (const k of ['id', 'name', 'symbol', 'address', 'totalSupply', 'paused', 'requiredTopics', 'trustedAttesters']) assert.ok(k in t, `token.${k}`);
    assert.deepEqual(t.trustedAttesters.map((a) => a.id), ['kyc-provider-a']);
  }
  // Dave was revoked in the previous test; everyone else matches the build plan's cast table.
  for (const [inv, row] of Object.entries(CAST_TABLE)) {
    if (inv === 'dave') continue;
    for (const [sym, topics] of Object.entries(row)) {
      const cell = s.matrix[inv][sym];
      assert.equal(cell.eligible, topics.length === 0, `${inv} ${sym}`);
      assert.deepEqual(cell.reasons.map((r) => r.topic).sort(), [...topics].sort(), `${inv} ${sym}`);
    }
  }
  assert.equal(s.balances.alice.dMMF.balance, '500');
  assert.equal(typeof s.balances.bob.dDEP.frozen, 'string');
  const actions = new Set(s.auditTrail.map((e) => e.action));
  for (const a of ['Provider authorized', 'Attester trusted', 'Credential issued', 'Issued', 'Frozen', 'Paused', 'Unpaused', 'Transfer', 'Credential revoked']) {
    assert.ok(actions.has(a), `audit trail lacks ${a}`);
  }
  for (const e of s.auditTrail) {
    for (const k of ['block', 'time', 'actor', 'action', 'token', 'detail', 'txHash']) assert.ok(k in e, `audit entry lacks ${k}`);
  }
  assert.ok(s.auditTrail.find((e) => e.action === 'Credential revoked').actor === 'KYC Provider A');

  // Rebuilt from logs: a fresh context (as the CLI would open) sees the same trail.
  const other = await openDeployment({ env: {}, rpcUrl: env.anvil.url, deploymentFile: ctx.deploymentFile });
  const s2 = await kit.getState(other);
  assert.deepEqual(s2.auditTrail, s.auditTrail);
});

test('X3 no key material in getState or in action results', async () => {
  const s = await kit.getState(ctx);
  assertNoKeyMaterial(assert, JSON.stringify(s), 'getState');
  const results = [
    await kit.issue(ctx, { token: 'dDEP', to: 'bob', amount: '1' }),
    await kit.issue(ctx, { token: 'dPCN', to: 'alice', amount: '1' }),
    await kit.onboardInvestor(ctx, { actor: 'kyc-provider-a', investor: 'alice', credential: { accreditationType: 2 } }),
  ];
  assertNoKeyMaterial(assert, JSON.stringify(results), 'action results');
  assertNoKeyMaterial(assert, JSON.stringify(ctx.actors), 'actors');
});
