// S6 (issue #5, decisions D-A and D-B): delivery versus payment between two instruments of different issuers,
// driven by a CDM TransferInstruction and answered with the same instruction marked Settled.
// CDM validation with CDM's own tooling runs when CDM_PYTHON points at a Python with finos-cdm installed
// (pip install -r tools/cdm/requirements.txt); CI sets it. Without it, those checks are skipped and say so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as kit from '../../core/actions/index.mjs';
import { withMode } from '../../core/lib/context.mjs';
import { transferInstruction, cdmReference, parseTransferInstruction, CDM_VERSION, movementInstruction } from '../../core/lib/cdm.mjs';
import { chainAndContext, ROOT, tmpDir, rm, writeJson, readJson } from './helpers/kit.mjs';

const CDM_PYTHON = process.env.CDM_PYTHON || null;
let env;
let ctx;
let out;
const written = [];

const tok = (sym) => ctx.deployment.tokens.find((t) => t.symbol === sym);
const addr = (id) => ctx.actors[id].address;
const bal = async (id, sym) => (await kit.getState(ctx, { audit: false })).balances[id][sym].balance;
const instruct = (seller, buyer, shares, price) =>
  transferInstruction(
    ctx,
    [
      { token: tok('dMMF'), from: addr(seller), to: addr(buyer), amountRaw: BigInt(shares) * 10n ** 6n },
      { token: tok('dDEP'), from: addr(buyer), to: addr(seller), amountRaw: BigInt(price) * 10n ** 6n },
    ],
    { date: '2026-11-18', status: 'Instructed' },
  );

function save(name, obj) {
  const f = path.join(out, `${name}.json`);
  writeJson(f, obj);
  written.push(f);
  return f;
}

before(async () => {
  env = await chainAndContext();
  ctx = env.ctx;
  out = tmpDir('interlock-cdm-');
  await kit.deploy(ctx, { outFile: false });
  await kit.authorizeProvider(ctx, { provider: 'kyc-provider-a' });
  for (const i of ['alice', 'bob', 'dave']) await kit.onboardInvestor(ctx, { actor: 'kyc-provider-a', investor: i });
  await kit.issue(ctx, { token: 'dMMF', to: 'bob', amount: '500' });
  await kit.issue(ctx, { token: 'dDEP', to: 'alice', amount: '1000' });
  await kit.issue(ctx, { token: 'dDEP', to: 'dave', amount: '1000' });
});
after(async () => {
  await env?.stop();
  if (out) rm(out);
});

test('DvP from a CDM instruction: both legs settle in one transaction; the CDM answer says Settled', async () => {
  const instructed = instruct('bob', 'alice', 100, 100);
  save('dvp-instructed', instructed);
  const r = await kit.settle(ctx, { instruction: instructed });
  assert.ok(r.ok, r.message);
  assert.equal(r.ref, cdmReference(instructed), 'the on-chain ref is the hash of the CDM instruction');
  const onChain = await ctx.publicClient.readContract({ address: ctx.deployment.shared.dvp, abi: ctx.abis.DvPSettlement, functionName: 'trade', args: [r.tradeId] });
  assert.equal(onChain.ref, r.ref);
  assert.equal(onChain.state, 2, 'Settled');
  assert.deepEqual(r.steps.map((s) => s.ok), [true, true, true, true]);
  assert.equal(await bal('alice', 'dMMF'), '100');
  assert.equal(await bal('bob', 'dDEP'), '100');
  assert.equal(await bal('alice', 'dDEP'), '900');
  // The CDM answer: same legs, Settled, carrying the settling transaction.
  assert.equal(r.cdm.settled['@version'], CDM_VERSION);
  for (const s of r.cdm.settled.transferState) {
    assert.equal(s.transferStatus, 'Settled');
    assert.equal(s.transfer.UnscheduledTransfer.identifier[0].assignedIdentifier[0].identifier['@data'], r.txHash);
  }
  save('dvp-settled', r.cdm.settled);
  // DvPSettlement never holds a balance.
  for (const sym of ['dMMF', 'dDEP']) {
    const b = await ctx.publicClient.readContract({ address: tok(sym).address, abi: ctx.abis.RegulatedToken, functionName: 'balanceOf', args: [ctx.deployment.shared.dvp] });
    assert.equal(b, 0n);
  }
  // The audit trail shows the trade, with its CDM reference.
  const trail = (await kit.getState(ctx)).auditTrail;
  assert.ok(trail.some((e) => e.action === 'Trade proposed' && e.detail.includes(r.ref)));
  assert.ok(trail.some((e) => e.action === 'Trade settled' && e.actorId === 'alice'));
});

test('DvP refused on one leg: neither leg moves, and the reason names the token and the topic', async () => {
  const before = [await bal('dave', 'dDEP'), await bal('bob', 'dMMF')];
  const r = await kit.settle(ctx, { instruction: instruct('bob', 'dave', 50, 50) });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'affirm');
  assert.equal(r.error, 'ERC7943CannotReceive');
  assert.equal(r.token, 'dMMF');
  assert.deepEqual(r.reasons.map((x) => x.text), ['country: policy rejected']);
  assert.match(r.message, /Dave may not receive dMMF \(country: policy rejected\), so neither leg moved/);
  assert.deepEqual([await bal('dave', 'dDEP'), await bal('bob', 'dMMF')], before);
});

test('CDM in: the instruction is read back into the same legs; bad instructions are refused with the path', () => {
  const legs = parseTransferInstruction(ctx, instruct('bob', 'alice', 7, 8));
  assert.deepEqual(legs.map((l) => [l.token.symbol, l.from.id, l.to.id, l.amountRaw]), [
    ['dMMF', 'bob', 'alice', 7_000_000n],
    ['dDEP', 'alice', 'bob', 8_000_000n],
  ]);
  const wrongChain = JSON.parse(JSON.stringify(instruct('bob', 'alice', 1, 1)).replaceAll('eip155:31337/', 'eip155:1/'));
  assert.throws(() => parseTransferInstruction(ctx, wrongChain), /transferState\[0\]: the asset is on chain 1/);
  const noLegs = { '@type': 'cdm.event.common.TransferInstruction', transferState: [] };
  assert.throws(() => parseTransferInstruction(ctx, noLegs), /must list the legs/);
});

test('settle refuses an instruction that is not a mirrored two-leg exchange, before sending anything', async () => {
  const three = instruct('bob', 'alice', 1, 1);
  three.transferState.push(three.transferState[0]);
  assert.match((await kit.settle(ctx, { instruction: three })).message, /exactly two legs/);
  const skew = instruct('bob', 'alice', 1, 1);
  skew.transferState[1] = instruct('bob', 'dave', 1, 1).transferState[1];
  assert.match((await kit.settle(ctx, { instruction: skew })).message, /must mirror/);
});

test('prepare mode: each DvP step can be prepared for an institution\'s own signer; settle itself cannot', async () => {
  const p = withMode(ctx, 'prepare');
  const a = await kit.approveLeg(p, { actor: 'bob', token: 'dMMF', amount: '1' });
  assert.ok(a.ok && a.prepared && a.prepared.to === tok('dMMF').address);
  const pr = await kit.proposeTrade(p, {
    actor: 'bob',
    delivery: { token: 'dMMF', from: 'bob', to: 'alice', amount: '1' },
    payment: { token: 'dDEP', from: 'alice', to: 'bob', amount: '1' },
    ref: cdmReference(instruct('bob', 'alice', 1, 1)),
  });
  assert.ok(pr.ok && pr.prepared && pr.prepared.to === ctx.deployment.shared.dvp);
  assert.equal((await kit.settle(p, { instruction: instruct('bob', 'alice', 1, 1) })).error, 'PrepareNotSupported');
});

test('CDM out for a single movement, and the shape matches the reference fixture', () => {
  const t = tok('dDEP');
  const m = movementInstruction(ctx, { token: t, from: addr('alice'), to: addr('bob'), amountRaw: 1_500_000n, txHash: `0x${'ab'.repeat(32)}`, date: '2026-11-18' });
  assert.equal(m.transferState.length, 1);
  assert.equal(m.transferState[0].transfer.UnscheduledTransfer.quantity.value, '1.5');
  save('movement-transfer', m);
  // Placeholders for addresses, hashes and dates: the structure is what the fixture pins.
  const shape = JSON.parse(JSON.stringify(readJson(path.join(out, 'dvp-settled.json'))).replace(/0x[0-9a-fA-F]{64}/g, '<hash>').replace(/0x[0-9a-fA-F]{40}/g, '<address>').replace(/\d{4}-\d{2}-\d{2}/g, '<date>'));
  const fixture = path.join(ROOT, 'test', 'fixtures', 'cdm', 'dvp-settled.shape.json');
  if (process.env.UPDATE_FIXTURES === '1') writeJson(fixture, shape); // regenerate deliberately, then review the diff
  assert.deepEqual(shape, readJson(fixture));
});

test('every CDM object validates with CDM\'s own tooling (finos-cdm); a broken one does not', { skip: CDM_PYTHON ? false : 'set CDM_PYTHON to a Python with finos-cdm (tools/cdm/requirements.txt)' }, () => {
  const ok = spawnSync(CDM_PYTHON, ['-I', path.join(ROOT, 'tools', 'cdm', 'validate.py'), ...written], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, new RegExp(`${written.length} of ${written.length} CDM objects valid`));
  const broken = readJson(written[0]);
  broken.transferState[0].transferStatus = 'Maybe';
  const bad = save('broken', broken);
  const r = spawnSync(CDM_PYTHON, ['-I', path.join(ROOT, 'tools', 'cdm', 'validate.py'), bad], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'an invalid CDM object must fail');
  assert.match(r.stdout, /ERR broken\.json/);
  assert.ok(readFileSync(bad, 'utf8').includes('Maybe'));
});
