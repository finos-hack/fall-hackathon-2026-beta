// S5 (issue #5): the conformance suites pass on Interlock's own contracts (four tokens, the Shibui slot and
// OnChainTrust's vLEI slot) and FAIL on purpose-built broken contracts. They are read-only: only an RPC URL and an
// address are needed, so anyone can run them against their own token or eligibility slot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as kit from '../../core/actions/index.mjs';
import { erc7943, eligibility, interfaceIdOf, ERC7943_FUNCTIONS, ERC7943_INTERFACE_ID } from '../../core/conformance.mjs';
import { main } from '../../core/conformance-cli.mjs';
import { loadArtifact } from '../../core/lib/artifacts.mjs';
import { deployContract } from '../../core/lib/tx.mjs';
import { chainAndContext, ROOT, TEMPLATES, tmpDir, rm, writeJson } from './helpers/kit.mjs';

let env;
let ctx;
let dir;
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);
const mock = async (contract, file, args = []) => (await deployContract(ctx, 'operator', loadArtifact(contract, { file }), args)).address;

before(async () => {
  env = await chainAndContext();
  ctx = env.ctx;
  dir = tmpDir('interlock-conformance-');
  await kit.deploy(ctx, { templateDirs: [TEMPLATES, path.join(ROOT, 'examples', 'templates')], outFile: path.join(dir, 'deployment.json') });
  await kit.authorizeProvider(ctx, { provider: 'kyc-provider-a' });
  await kit.onboardInvestor(ctx, { actor: 'kyc-provider-a', investor: 'alice' });
  await kit.onboardEntity(ctx, { holder: 'larkmoor-treasury' });
});
after(async () => {
  await env?.stop();
  if (dir) rm(dir);
});

test('the ERC-7943 interface id is recomputed from the six selectors, not trusted', () => {
  assert.equal(interfaceIdOf(ERC7943_FUNCTIONS), ERC7943_INTERFACE_ID);
});

test('ERC-7943 suite passes on every Interlock token', async () => {
  for (const t of ctx.deployment.tokens) {
    const r = await erc7943(ctx.publicClient, t.address);
    assert.equal(r.passed, r.total, `${t.symbol}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
  }
});

test('eligibility suite passes on the Shibui slot and on OnChainTrust\'s vLEI slot, with expectations', async () => {
  const dep = ctx.deployment.tokens.find((t) => t.symbol === 'dDEP');
  const ibd = ctx.deployment.tokens.find((t) => t.symbol === 'dIBD');
  const a = ctx.actors;
  const shibui = await eligibility(ctx.publicClient, dep.eligibility, { [a.alice.address]: true, [a.carol.address]: false });
  assert.equal(shibui.passed, shibui.total, JSON.stringify(shibui.checks));
  assert.equal(shibui.total, 5);
  const vlei = await eligibility(ctx.publicClient, ibd.eligibility, { [a['larkmoor-treasury'].address]: true, [a.alice.address]: false });
  assert.equal(vlei.passed, vlei.total, JSON.stringify(vlei.checks));
});

test('ERC-7943 suite fails on a token whose views revert, and on a contract that is not ERC-7943', async () => {
  const broken = await mock('RevertingViewsToken', 'BrokenContracts.sol');
  assert.deepEqual(failed(await erc7943(ctx.publicClient, broken)), ['T5', 'T6', 'T8']);
  const slotOnly = await mock('MockEligibility', 'MockEligibility.sol');
  const r = await erc7943(ctx.publicClient, slotOnly);
  assert.ok(failed(r).includes('T2'), 'a contract without supportsInterface fails T2');
});

test('eligibility suite fails on a slot that reverts, one that fails open, and one whose explain disagrees', async () => {
  const reverting = await mock('MockEligibility', 'MockEligibility.sol');
  await ctx.actors.operator.wallet.writeContract({ address: reverting, abi: loadArtifact('MockEligibility', { file: 'MockEligibility.sol' }).abi, functionName: 'setMode', args: [1] });
  assert.ok(failed(await eligibility(ctx.publicClient, reverting)).includes('E1'));
  const open = await mock('FailOpenEligibility', 'BrokenContracts.sol');
  assert.deepEqual(failed(await eligibility(ctx.publicClient, open)), ['E2', 'E4']);
  const disagree = await mock('DisagreeingEligibility', 'BrokenContracts.sol');
  assert.deepEqual(failed(await eligibility(ctx.publicClient, disagree)), ['E4']);
});

test('CLI: npm run conformance -- deployment checks every token and slot of a deployment record', async () => {
  const lines = [];
  assert.equal(await main(['deployment', '--rpc', ctx.rpcUrl, '--deployment', path.join(dir, 'deployment.json')], (l) => lines.push(l)), 0, lines.join('\n'));
  assert.equal(lines.filter((l) => /: \d+ of \d+$/.test(l)).length, 8, 'four tokens and four slots');
  assert.ok(!lines.some((l) => l.startsWith('FAIL')));
  const expect = path.join(dir, 'expect.json');
  writeJson(expect, { [ctx.actors.carol.address]: true });
  const dep = ctx.deployment.tokens.find((t) => t.symbol === 'dDEP');
  assert.equal(await main(['eligibility', '--rpc', ctx.rpcUrl, '--slot', dep.eligibility, '--expect', expect], () => {}), 1, 'a wrong expectation fails');
  assert.equal(await main(['nope', '--rpc', ctx.rpcUrl], () => {}), 2);
});
