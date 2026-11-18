// C3: the kit refuses chain id 1 before ANY transaction. anvil is started with --chain-id 1 to stand in for
// mainnet; afterwards the operator nonce is still 0 and no block was mined, so nothing was deployed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { startAnvil, MainnetRefusedError, resolveNetwork } from '../../examples/lib/network.mjs';
import { createContext } from '../../examples/lib/context.mjs';
import { loadKitConfig } from '../../examples/lib/config.mjs';
import * as kit from '../../core/actions/index.mjs';
import { requireArtifacts, tmpDir, rm, runNode, chainAndContext } from './helpers/kit.mjs';
import { createPublicClient, http } from 'viem';

let mainnetLike;
let dir;
const cast = loadKitConfig();
const operator = resolveNetwork({ env: {}, kit: cast }).accounts.operator.address;

before(async () => {
  requireArtifacts();
  mainnetLike = await startAnvil({ chainId: 1, accounts: 10 });
  dir = tmpDir();
});
after(async () => {
  await mainnetLike?.stop();
  if (dir) rm(dir);
});

async function untouched(url) {
  const c = createPublicClient({ transport: http(url) });
  assert.equal(await c.getChainId(), 1);
  assert.equal(await c.getTransactionCount({ address: operator }), 0, 'the operator sent a transaction');
  assert.equal(await c.getBlockNumber({ cacheTime: 0 }), 0n, 'a block was mined');
}

test('C3 createContext refuses chain id 1 with a clear message and sends nothing', async () => {
  await assert.rejects(
    () => createContext({ env: {}, rpcUrl: mainnetLike.url, deploymentFile: path.join(dir, 'x.json') }),
    (e) => e instanceof MainnetRefusedError && /chain id 1/.test(e.message) && /never sends a transaction to mainnet/.test(e.message),
  );
  await untouched(mainnetLike.url);
});

test('C3 npm start refuses chain id 1 (RPC_URL) and deploys nothing', async () => {
  const r = await runNode(['examples/start.mjs'], { env: { NETWORK: 'local', RPC_URL: mainnetLike.url, PORT: '0' } });
  assert.equal(r.code, 1, `start must fail\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /chain id 1/);
  assert.doesNotMatch(r.stdout, /Deploying|Console listening/);
  await untouched(mainnetLike.url);
});

test('C3 the CLI refuses chain id 1 too', async () => {
  // A record claiming chain id 1 must not get the CLI past the chain id check.
  const record = path.join(dir, 'mainnet-like.json');
  writeFileSync(record, JSON.stringify({ network: 'local', chainId: 1, rpcUrl: mainnetLike.url, tokens: [] }));
  const r = await runNode(['examples/cli.mjs', 'pause', 'dDEP', '--deployment', record], { env: { NETWORK: 'local', RPC_URL: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /chain id 1/);
  await untouched(mainnetLike.url);
});

test('C3 a chain that turns into chain id 1 after connecting: deploy and every action refuse, nothing is sent', async () => {
  const env = await chainAndContext();
  try {
    await kit.deploy(env.ctx, {});
    const nonce = await env.ctx.publicClient.getTransactionCount({ address: env.ctx.actors.compliance.address });
    await env.ctx.publicClient.request({ method: 'anvil_setChainId', params: [1] });
    // deploy() re-reads the chain id before its first transaction.
    const opNonce = await env.ctx.publicClient.getTransactionCount({ address: env.ctx.actors.operator.address });
    await assert.rejects(() => kit.deploy(env.ctx, { outFile: false }), MainnetRefusedError);
    assert.equal(await env.ctx.publicClient.getTransactionCount({ address: env.ctx.actors.operator.address }), opNonce);
    // Actions: the chain id is read again right before every signature. pause would succeed (its simulation
    // passes), so only the guard can stop it.
    await assert.rejects(() => kit.pause(env.ctx, { token: 'dDEP' }), MainnetRefusedError);
    assert.equal(await env.ctx.publicClient.getTransactionCount({ address: env.ctx.actors.compliance.address }), nonce, 'compliance sent a transaction');
    assert.equal(await env.ctx.publicClient.readContract({ address: env.ctx.deployment.tokens[0].address, abi: env.ctx.abis.RegulatedToken, functionName: 'paused' }), false);
    assert.ok(existsSync(env.ctx.deploymentFile));
  } finally {
    await env.stop();
  }
});
