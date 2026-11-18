// S3 and S4 (issue #5): the core is usable on its own. A custom cast, no kit.config.json, no kit keys: every signer is
// an external one (here a simulated remote signing service, the way an HSM or MPC service would be wrapped with viem's
// toAccount). Prepare mode returns unsigned transactions that sign and send elsewhere with the same effect.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { toAccount, generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { createWalletClient, http, toHex } from 'viem';
import * as core from '../../core/index.mjs';
import { startAnvil, ANVIL_PUBLIC_TEST_MNEMONIC } from '../../examples/lib/network.mjs';
import { ROOT, tmpDir, rm, writeJson, readJson, TEMPLATES, requireArtifacts } from './helpers/kit.mjs';

/** A stand-in for an HSM or MPC service: it holds the keys; callers only ever see addresses and signatures. */
function remoteSigningService() {
  const keys = new Map();
  const calls = [];
  return {
    calls,
    newKey(label) {
      const acct = privateKeyToAccount(generatePrivateKey());
      keys.set(acct.address.toLowerCase(), acct);
      return { label, address: acct.address };
    },
    async sign(address, kind, payload) {
      calls.push({ address, kind });
      const acct = keys.get(address.toLowerCase());
      if (kind === 'transaction') return acct.signTransaction(payload);
      if (kind === 'message') return acct.signMessage(payload);
      return acct.signTypedData(payload);
    },
  };
}

/** A viem Account whose signatures come from the service. No key material on this side. */
function remoteAccount(service, address) {
  return toAccount({
    address,
    signTransaction: (tx) => service.sign(address, 'transaction', tx),
    signMessage: (m) => service.sign(address, 'message', m),
    signTypedData: (td) => service.sign(address, 'typed', td),
  });
}

const CAST = {
  roles: {
    operator: { name: 'Platform operator' },
    issuer: { name: 'Treasury desk' },
    compliance: { name: 'Compliance desk' },
  },
  attesters: [{ id: 'idp', name: 'Example identity provider', authorizedTopics: ['KYC', 'SANCTIONS'] }],
  investors: [
    { id: 'x', name: 'Investor X', credential: { kycStatus: 1, amlStatus: 0, sanctionsStatus: 0, sourceOfFundsStatus: 1, countryCode: 250 } },
    { id: 'y', name: 'Investor Y', credential: { kycStatus: 1, amlStatus: 0, sanctionsStatus: 0, sourceOfFundsStatus: 1, countryCode: 276 } },
  ],
};

let anvil;
let service;
let signers;
let ctx;
let tpl;

before(async () => {
  requireArtifacts();
  anvil = await startAnvil({ accounts: 10 });
  service = remoteSigningService();
  signers = {};
  const ids = ['operator', 'issuer', 'compliance', 'idp', 'x', 'y'];
  for (const id of ids) {
    const { address } = service.newKey(id);
    signers[id] = remoteAccount(service, address);
    // Gas for a fresh address on the local node.
    await fetch(anvil.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [address, toHex(10n ** 20n)] }) });
  }
  tpl = tmpDir('interlock-core-tpl-');
  // One product, defined by the caller: the shipped deposit template under another id and symbol.
  const t = readJson(path.join(TEMPLATES, 'tokenized-deposit.json'));
  writeJson(path.join(tpl, 'cash.json'), { ...t, id: 'example-cash', symbol: 'xCASH', name: 'Example Cash Token', trustedAttesters: ['idp'] });
  ctx = await core.createContext({ rpcUrl: anvil.url, cast: CAST, signers, network: 'local' });
});

after(async () => {
  await anvil?.stop();
  if (tpl) rm(tpl);
});

test('core: a custom cast and external signers run the whole flow, with no kit.config.json and no kit key', async () => {
  const d = await core.deploy(ctx, { templateDirs: [tpl], outFile: false });
  assert.deepEqual(d.tokens.map((x) => x.symbol), ['xCASH']);
  assert.ok((await core.authorizeProvider(ctx, { provider: 'idp' })).ok);
  assert.ok((await core.onboardInvestor(ctx, { actor: 'idp', investor: 'x' })).ok);
  assert.ok((await core.onboardInvestor(ctx, { actor: 'idp', investor: 'y' })).ok);
  assert.ok((await core.issue(ctx, { token: 'xCASH', to: 'x', amount: '100' })).ok);
  const t = await core.transfer(ctx, { actor: 'x', token: 'xCASH', to: 'y', amount: '40' });
  assert.ok(t.ok, t.message);
  const s = await core.getState(ctx);
  assert.equal(s.balances.x.xCASH.balance, '60');
  assert.equal(s.balances.y.xCASH.balance, '40');

  // Every signature came from the remote service, for every actor that sent something.
  const signedBy = new Set(service.calls.map((c) => c.address.toLowerCase()));
  for (const id of ['operator', 'issuer', 'idp', 'x']) assert.ok(signedBy.has(signers[id].address.toLowerCase()), `${id} did not sign remotely`);
  // None of the kit's quickstart keys (anvil's public test accounts) is a cast member.
  const anvilAddrs = new Set(Array.from({ length: 20 }, (_, i) => mnemonicToAccount(ANVIL_PUBLIC_TEST_MNEMONIC, { addressIndex: i }).address.toLowerCase()));
  for (const a of Object.values(ctx.actors)) assert.ok(!anvilAddrs.has(a.address.toLowerCase()), `${a.id} uses a kit key`);
});

test('core: prepare mode returns the unsigned transaction; signed and sent elsewhere, it has the same effect', async () => {
  const p = core.withMode(ctx, 'prepare');
  const prepared = await core.transfer(p, { actor: 'x', token: 'xCASH', to: 'y', amount: '10' });
  assert.ok(prepared.ok);
  assert.equal(prepared.txHash, undefined, 'nothing was sent');
  assert.equal(prepared.prepared.from, signers.x.address);
  assert.match(prepared.prepared.data, /^0x[0-9a-f]+$/);
  assert.equal((await core.getState(ctx)).balances.y.xCASH.balance, '40', 'balance unchanged until it is sent');

  // The holder's own system signs and sends it.
  const wallet = createWalletClient({ account: signers.x, chain: ctx.chain, transport: http(anvil.url) });
  const hash = await wallet.sendTransaction({ to: prepared.prepared.to, data: prepared.prepared.data });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  assert.equal((await core.getState(ctx)).balances.y.xCASH.balance, '50');

  // A refusal is still decoded in prepare mode, and nothing is prepared.
  const refused = await core.issue(p, { token: 'xCASH', to: signers.compliance.address, amount: '1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'ERC7943CannotReceive');
  // Multi-transaction actions say so instead of half-preparing.
  const multi = await core.onboardInvestor(p, { actor: 'idp', investor: 'x' });
  assert.equal(multi.error, 'PrepareNotSupported');
});

test('core: refuses a cast member without a signer, and an invalid cast, before touching the chain', async () => {
  await assert.rejects(() => core.createContext({ rpcUrl: anvil.url, cast: CAST, signers: { ...signers, y: undefined } }), /no signer .* y/);
  await assert.rejects(() => core.createContext({ rpcUrl: anvil.url, cast: { ...CAST, roles: {} }, signers }), (e) => e instanceof core.ConfigError);
});

test('core: imports nothing from examples/, and holds no keys or demo cast', () => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.mjs')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'core'));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /from '[^']*examples\//, `${path.relative(ROOT, f)} imports from examples/`);
    assert.doesNotMatch(text, /path\.(join|resolve)\([^)]*'kit\.config\.json'/, `${path.relative(ROOT, f)} reads the demo cast`);
    assert.doesNotMatch(text, /test test test|mnemonicToAccount|privateKeyToAccount/, `${path.relative(ROOT, f)} handles keys`);
  }
});

test('core: public API surface', async () => {
  const api = Object.keys(await import('../../core/index.mjs')).sort();
  for (const name of ['createContext', 'withMode', 'deploy', 'getState', 'runAction', 'issue', 'transfer', 'redeem', 'freeze', 'forcedTransfer', 'pause', 'unpause', 'onboardInvestor', 'revokeCredential', 'replaceAttester', 'authorizeProvider', 'validateCast', 'validateTemplate', 'ConfigError', 'MainnetRefusedError']) {
    assert.ok(api.includes(name), `core/index.mjs does not export ${name}`);
  }
});
