// M5: the console server and page (build plan 3.7), against a real local chain (own anvil, random port).
//   X1  routes: state shape, every action through POST /api/actions, refusals by topic (ACCREDITATION), bad input.
//   X3  no response body ever carries a private key or the mnemonic.
//   The guided story runs through the SAME code the page runs (app/public/app.js exports it), so "as expected"
//   in these tests means "as expected" in the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import * as kit from '../../app/actions/index.mjs';
import { startServer, MAX_BODY } from '../../app/server.mjs';
import { PUBLIC_DIR } from '../../app/lib/paths.mjs';
import {
  STORY,
  runStep,
  storySummary,
  createApi,
  cellSummary,
  txUrl,
  collectTxHashes,
  describeResult,
  formParams,
  ACTION_FORMS,
} from '../../app/public/app.js';
import { chainAndContext, localKeyMaterial, tmpDir, rm, ROOT, FIXTURES, CAST_TABLE, copyTemplates } from './helpers/kit.mjs';

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

let env;
let srv; // the console, on the seeded deployment: X1 routes and actions
let bare; // same deployment, empty public dir: the text fallback
let storyEnv; // a second, freshly seeded deployment on the same chain: the guided story
let storySrv;
const extraServers = [];
const tempDirs = [];
let seeded; // GET /api/state right after the seed
const bodies = []; // every response body of this file, for X3
const actionsSeen = new Set();

/** Records every body so X3 can scan them all. */
async function recordingFetch(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  bodies.push(text);
  return new Response(text, { status: r.status, headers: r.headers });
}

async function call(server, method, p, body, headers = {}) {
  const r = await recordingFetch(server.url + p, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, text, json, type: r.headers.get('content-type'), headers: r.headers };
}

/** POST an action to the main console and remember which action names went through. */
async function act(action, actor, params) {
  const r = await call(srv, 'POST', '/api/actions', { action, actor, params });
  if (r.json?.ok) actionsSeen.add(r.json.action);
  return r;
}

/** Raw HTTP, so paths reach the server exactly as written (fetch would normalize "..") and bodies can stream. */
function raw(server, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(server.url);
    let answered = false;
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        answered = true;
        bodies.push(text);
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
    });
    req.on('error', (e) => {
      if (!answered) reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function state(server = srv) {
  const r = await call(server, 'GET', '/api/state');
  assert.equal(r.status, 200, r.text);
  return r.json;
}

const tokenSymbols = (s) => s.tokens.map((t) => t.symbol).sort();

before(async () => {
  env = await chainAndContext();
  await kit.deploy(env.ctx, {});
  await kit.seedDemo(env.ctx);
  srv = await startServer({ ctx: env.ctx, port: 0, publicDir: PUBLIC_DIR });
  const emptyPublic = tmpDir();
  tempDirs.push(emptyPublic);
  bare = await startServer({ ctx: env.ctx, port: 0, publicDir: emptyPublic });

  // The story needs the state right after `npm start`, so it gets its own deployment (same chain, fresh contracts).
  const ctx2 = kit.withDeployment(env.ctx, null);
  await kit.deploy(ctx2, { outFile: false });
  await kit.seedDemo(ctx2);
  storyEnv = { ctx: ctx2 };
  storySrv = await startServer({ ctx: ctx2, port: 0 });
});

after(async () => {
  for (const s of [srv, bare, storySrv, ...extraServers]) await s?.close();
  await env?.stop();
  for (const d of tempDirs) rm(d);
});

// ============ X1: state ============

test('X1 GET /api/state has the documented shape, read from the chain', async () => {
  const r = await call(srv, 'GET', '/api/state');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const s = r.json;
  seeded = s;

  assert.equal(s.kit, 'eea-tokenization-starter-kit');
  assert.equal(s.network, 'local');
  assert.equal(s.chainId, 31337);
  assert.equal(s.explorer, null, 'the local chain has no block explorer');
  assert.ok(Number.isInteger(s.blockNumber) && s.blockNumber > s.deployBlock);
  assert.ok(!Number.isNaN(Date.parse(s.blockTime)) && !Number.isNaN(Date.parse(s.deployedAt)));
  for (const k of ['eas', 'schemaRegistry', 'trustedIssuerResolver', 'identityProxy']) assert.match(s.contracts[k], ADDRESS, k);
  assert.match(s.schemas.investorEligibility, HASH);
  assert.match(s.schemas.issuerAuthorization, HASH);

  // The "Act as" list: the whole cast, addresses only.
  assert.deepEqual(
    s.actors.map((a) => [a.id, a.name, a.kind]),
    [
      ['operator', 'Operator', 'role'],
      ['issuer', 'Issuer', 'role'],
      ['compliance', 'Compliance officer', 'role'],
      ['kyc-provider-a', 'KYC Provider A', 'attester'],
      ['kyc-provider-b', 'KYC Provider B', 'attester'],
      ['alice', 'Alice', 'investor'],
      ['bob', 'Bob', 'investor'],
      ['carol', 'Carol', 'investor'],
      ['dave', 'Dave', 'investor'],
      ['northvale-issuer', 'Northvale Bank, issuer', 'institution'],
      ['northvale-compliance', 'Northvale Bank, compliance', 'institution'],
      ['quillon-issuer', 'Quillon Asset Management, issuer', 'institution'],
      ['quillon-compliance', 'Quillon Asset Management, compliance', 'institution'],
      ['saltmarsh-issuer', 'Saltmarsh Credit Partners, issuer', 'institution'],
      ['saltmarsh-compliance', 'Saltmarsh Credit Partners, compliance', 'institution'],
    ],
  );
  for (const a of s.actors) {
    assert.deepEqual(Object.keys(a).sort(), ['address', 'id', 'kind', 'name'], `actor ${a.id} must carry no key field`);
    assert.match(a.address, ADDRESS);
  }
  assert.deepEqual(s.investors.map((i) => i.id), ['alice', 'bob', 'carol', 'dave']);
  for (const i of s.investors) assert.ok(i.summary && i.address);

  // Tokens panel: symbol, name, supply, paused flag, required topics, live trusted attesters.
  assert.deepEqual(tokenSymbols(s), ['dDEP', 'dMMF', 'dPCN']);
  const byS = Object.fromEntries(s.tokens.map((t) => [t.symbol, t]));
  assert.deepEqual(byS.dDEP.requiredTopics, ['KYC', 'SANCTIONS']);
  assert.deepEqual(byS.dMMF.requiredTopics, ['KYC', 'AML', 'COUNTRY']);
  assert.deepEqual(byS.dPCN.requiredTopics, ['KYC', 'ACCREDITATION', 'COUNTRY']);
  assert.deepEqual(byS.dPCN.accreditation, { allowedTypes: [2, 3, 4] });
  assert.deepEqual(byS.dMMF.country, { mode: 'allow', codes: [840, 826, 250] });
  assert.equal(byS.dDEP.totalSupply, '2000'); // seed W3: 1000 to Alice + 1000 to Bob
  assert.equal(byS.dMMF.totalSupply, '1000');
  assert.equal(byS.dPCN.totalSupply, '0');
  assert.deepEqual(byS.dMMF.labels, { issue: 'Subscription', redeem: 'Redemption' });
  for (const t of s.tokens) {
    assert.equal(t.paused, false);
    assert.equal(t.decimals, 6);
    for (const k of ['address', 'eligibility', 'verifier', 'adapter', 'registry']) assert.match(t[k], ADDRESS, `${t.symbol}.${k}`);
    assert.deepEqual(t.trustedAttesters.map((a) => a.id), ['kyc-provider-a']);
    assert.deepEqual([...t.trustedAttesters[0].topics].sort(), [...t.requiredTopics].sort());
  }

  // Who may hold what: the cast table of the build plan, with the failing topics.
  for (const [inv, row] of Object.entries(CAST_TABLE)) {
    for (const [sym, topics] of Object.entries(row)) {
      const c = s.matrix[inv][sym];
      assert.equal(c.eligible, topics.length === 0, `${inv} on ${sym}`);
      assert.deepEqual(c.reasons.map((x) => x.topic).sort(), [...topics].sort(), `${inv} on ${sym} reasons`);
      assert.equal(c.topics.length, byS[sym].requiredTopics.length, `${inv} on ${sym}: every topic is explained`);
    }
  }

  assert.deepEqual(s.balances.alice.dDEP, { balance: '1000', frozen: '0', unfrozen: '1000', balanceRaw: '1000000000', frozenRaw: '0' });
  assert.equal(s.balances.bob.dMMF.balance, '500');
  assert.equal(s.balances.carol.dDEP.balance, '0');

  // Audit trail: oldest first, every seed step attributed.
  const trail = s.auditTrail;
  for (let i = 1; i < trail.length; i++) assert.ok(trail[i].block >= trail[i - 1].block, 'audit trail is oldest first');
  const count = (a) => trail.filter((e) => e.action === a).length;
  assert.equal(count('Provider authorized'), 1);
  assert.equal(count('Attester trusted'), 3);
  assert.equal(count('Credential issued'), 3);
  assert.equal(count('Issued'), 4);
  for (const e of trail) {
    for (const k of ['block', 'time', 'actor', 'actorId', 'action', 'token', 'detail', 'txHash', 'logIndex']) assert.ok(k in e, `audit entry lacks ${k}`);
    assert.match(e.txHash, HASH);
  }
  assert.ok(trail.some((e) => e.action === 'Issued' && e.detail === 'Subscription: 500 dMMF to Bob' && e.actorId === 'issuer'));
});

test('the console words the matrix as the plan asks: "yes" or "no: <topic>", never colour alone', () => {
  assert.ok(seeded, 'needs the seeded state from the previous test');
  const cell = (inv, sym) => cellSummary(seeded.matrix[inv][sym]);
  assert.deepEqual(cell('alice', 'dPCN'), { eligible: false, text: 'no: accreditation', detail: 'accreditation: policy rejected' });
  assert.deepEqual(cell('bob', 'dPCN'), { eligible: true, text: 'yes', detail: '' });
  assert.equal(cell('alice', 'dDEP').text, 'yes');
  assert.equal(cell('carol', 'dDEP').text, 'no: KYC, sanctions');
  assert.equal(cell('carol', 'dDEP').detail, 'KYC: no credential; sanctions: no credential');
  assert.equal(cell('dave', 'dMMF').text, 'no: country');
  assert.equal(cell('dave', 'dPCN').text, 'no: accreditation, country');

  // On Sepolia every transaction hash links to Etherscan; locally there is nothing to link to.
  const h = `0x${'ab'.repeat(32)}`;
  assert.equal(txUrl('https://sepolia.etherscan.io', h), `https://sepolia.etherscan.io/tx/${h}`);
  assert.equal(txUrl(null, h), null);
  assert.equal(txUrl('https://sepolia.etherscan.io', 'not-a-hash'), null);
});

// ============ X1: actions ============

test('X1 a refused action returns HTTP 200 with the reasons by topic, including ACCREDITATION', async () => {
  // Alice holds one credential without accreditation: the credit note refuses her (I2).
  const r = await act('issue', 'issuer', { token: 'dPCN', to: 'alice', amount: '50' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'ERC7943CannotReceive');
  assert.deepEqual(r.json.reasons, [{ topic: 'ACCREDITATION', topicId: 7, status: 'POLICY_REJECTED', text: 'accreditation: policy rejected' }]);
  assert.equal(r.json.accountId, 'alice');
  assert.equal(r.json.txHash, undefined, 'a refusal sends no transaction');
  const d = describeResult(r.json);
  assert.equal(d.kind, 'refused');
  assert.equal(d.text, 'Alice may not receive dPCN (accreditation: policy rejected)');

  const country = await act('issue', 'issuer', { token: 'dMMF', to: 'dave', amount: '1' });
  assert.equal(country.status, 200);
  assert.deepEqual(country.json.reasons, [{ topic: 'COUNTRY', topicId: 3, status: 'POLICY_REJECTED', text: 'country: policy rejected' }]);

  const carol = await act('issue', 'issuer', { token: 'dDEP', to: 'carol', amount: '1' });
  assert.deepEqual(
    carol.json.reasons.map((x) => `${x.topic}:${x.status}`),
    ['KYC:NOT_REGISTERED', 'SANCTIONS:NOT_REGISTERED'],
  );
});

test('X1 refusals that are not about eligibility still say why, with HTTP 200', async () => {
  const p = await act('pause', 'issuer', { token: 'dDEP' });
  assert.equal(p.status, 200);
  assert.equal(p.json.error, 'AccessControlUnauthorizedAccount');
  assert.equal(p.json.role, 'COMPLIANCE_ROLE');
  assert.deepEqual(p.json.reasons, []);
  assert.match(describeResult(p.json, (id) => (id === 'issuer' ? 'Issuer' : id)).text, /Issuer does not hold COMPLIANCE_ROLE on dDEP/);

  const self = await act('authorizeProvider', 'kyc-provider-b', { provider: 'kyc-provider-b' });
  assert.equal(self.status, 200);
  assert.equal(self.json.error, 'InvalidAttestation', 'I6: a provider cannot authorize itself');

  const investor = await act('onboardInvestor', 'alice', { investor: 'carol', credential: { countryCode: 840 } });
  assert.equal(investor.status, 200);
  assert.equal(investor.json.error, 'AttesterNotTrusted', 'an investor is never a trusted attester');
});

test('X1 every token action works through POST /api/actions', async () => {
  const ok = (r, what) => {
    assert.equal(r.status, 200, `${what}: ${r.text}`);
    assert.equal(r.json.ok, true, `${what}: ${r.json.message}`);
    assert.match(r.json.txHash, HASH, what);
    return r.json;
  };
  const s0 = await state();

  ok(await act('issue', 'issuer', { token: 'dMMF', to: 'bob', amount: '2' }), 'issue');
  ok(await act('transfer', 'alice', { token: 'dDEP', to: 'bob', amount: '10' }), 'transfer');
  ok(await act('redeem', 'issuer', { token: 'dDEP', from: 'bob', amount: '5' }), 'redeem');
  // Alice now holds 990 dDEP; freezing 980 leaves 10 unfrozen, so the forced transfer of 50 must release 40.
  const f = ok(await act('freeze', 'compliance', { token: 'dDEP', account: 'alice', amount: '980' }), 'freeze');
  assert.equal(f.frozen, '980');
  ok(await act('forcedTransfer', 'compliance', { token: 'dDEP', from: 'alice', to: 'bob', amount: '50' }), 'forcedTransfer');
  ok(await act('pause', 'compliance', { token: 'dMMF' }), 'pause');
  const paused = await state();
  assert.equal(paused.tokens.find((t) => t.symbol === 'dMMF').paused, true);
  const refused = await act('transfer', 'bob', { token: 'dMMF', to: 'alice', amount: '1' });
  assert.equal(refused.json.error, 'EnforcedPause');
  assert.equal(describeResult(refused.json).text, 'dMMF is paused');
  ok(await act('unpause', 'compliance', { token: 'dMMF' }), 'unpause');
  // The aliases the CLI accepts work here too.
  const alias = ok(await act('forced', 'compliance', { token: 'dDEP', from: 'bob', to: 'alice', amount: '1' }), 'forced (alias)');
  assert.equal(alias.action, 'forcedTransfer');

  const s1 = await state();
  const b = (s, inv, sym) => Number(s.balances[inv][sym].balance);
  assert.equal(b(s1, 'bob', 'dMMF'), b(s0, 'bob', 'dMMF') + 2);
  assert.equal(b(s1, 'alice', 'dDEP'), b(s0, 'alice', 'dDEP') - 10 - 50 + 1);
  assert.equal(b(s1, 'bob', 'dDEP'), b(s0, 'bob', 'dDEP') + 10 - 5 + 50 - 1);
  assert.equal(s1.balances.alice.dDEP.frozen, '940', 'a forced transfer releases the frozen units it moves');
  assert.equal(s1.tokens.find((t) => t.symbol === 'dMMF').paused, false);
  const newest = s1.auditTrail.slice(-3).map((e) => e.action);
  assert.deepEqual(newest, ['Paused', 'Unpaused', 'Forced transfer']);
});

test('X1 every attester and credential action works through POST /api/actions', async () => {
  const ok = (r, what) => {
    assert.equal(r.status, 200, `${what}: ${r.text}`);
    assert.equal(r.json.ok, true, `${what}: ${r.json.message}`);
    return r.json;
  };
  // W1: the operator authorizes KYC Provider B on the three tokens.
  const auth = ok(await act('authorizeProvider', 'operator', { provider: 'kyc-provider-b', tokens: ['dDEP', 'dMMF', 'dPCN'] }), 'authorizeProvider');
  assert.match(auth.authUID, HASH);
  assert.deepEqual(auth.trusted.map((t) => t.token).sort(), ['dDEP', 'dMMF', 'dPCN']);

  // W2: B onboards Carol with credential fields from the form (she has none in kit.config.json).
  const params = formParams('onboardInvestor', { investor: 'carol', countryCode: '840', accreditationType: '2', kycStatus: '', amlStatus: '', sanctionsStatus: '', expiresInDays: '' });
  assert.deepEqual(params, { investor: 'carol', credential: { countryCode: 840, accreditationType: 2 } });
  const on = ok(await act('onboardInvestor', 'kyc-provider-b', params), 'onboardInvestor');
  assert.equal(on.investor, 'carol');
  assert.ok(on.registrations.length >= 8, `one registration per token and topic, got ${on.registrations.length}`);
  let s = await state();
  for (const t of s.tokens) assert.equal(s.matrix.carol[t.symbol].eligible, true, `Carol on ${t.symbol} after onboarding`);

  // W6: B revokes it; Carol is out everywhere, for KYC: revoked.
  const rv = ok(await act('revokeCredential', 'kyc-provider-b', { investor: 'carol' }), 'revokeCredential');
  assert.equal(rv.revoked[0].attester, 'kyc-provider-b');
  s = await state();
  for (const t of s.tokens) {
    assert.equal(s.matrix.carol[t.symbol].eligible, false);
    assert.ok(s.matrix.carol[t.symbol].reasons.some((x) => x.topic === 'KYC' && x.status === 'REVOKED'));
  }

  // W7: the operator replaces A by B; every transaction of the result is listed for the console.
  const rep = ok(await act('replaceAttester', 'operator', { from: 'kyc-provider-a', to: 'kyc-provider-b' }), 'replaceAttester');
  assert.deepEqual(rep.reattested.map((x) => x.investor).sort(), ['alice', 'bob', 'dave']);
  const listed = new Set(collectTxHashes(rep).map((x) => x.hash));
  for (const h of [rep.txHash, ...rep.removed.map((x) => x.txHash), ...rep.reattested.map((x) => x.txHash)]) assert.ok(listed.has(h), `console lists ${h}`);
  s = await state();
  for (const t of s.tokens) assert.deepEqual(t.trustedAttesters.map((a) => a.id), ['kyc-provider-b']);
  assert.equal(s.matrix.bob.dPCN.eligible, true, 'Bob is back through B');

  for (const name of Object.keys(kit.ACTIONS)) assert.ok(actionsSeen.has(name), `${name} went through POST /api/actions`);
  assert.deepEqual(ACTION_FORMS.map((f) => f.action).sort(), Object.keys(kit.ACTIONS).sort(), 'the console has a form for every action');
});

test('X1 bad input gets 400, unknown routes 404, wrong methods 405, wrong media type 415', async () => {
  const bad = async (body, error = 'BadRequest') => {
    const r = await call(srv, 'POST', '/api/actions', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, error);
  };
  await bad('not json');
  await bad({ params: {} });
  await bad([1, 2]);
  await bad({ action: 'mint', params: {} }, 'UnknownAction');
  await bad({ action: 'issue', params: { token: 'dDEP', to: 'bob', amount: 'lots' } });
  await bad({ action: 'issue', params: [] });
  await bad({ action: 'issue', actor: 7, params: {} });
  await bad({ action: 'issue', actor: 'mallory', params: { token: 'dDEP', to: 'bob', amount: '1' } });
  await bad({ action: 'issue', params: { token: 'dXYZ', to: 'bob', amount: '1' } });

  // A plain cross-site form cannot send application/json, so it cannot trigger an action.
  const form = await call(srv, 'POST', '/api/actions', JSON.stringify({ action: 'pause', actor: 'compliance', params: { token: 'dDEP' } }), {
    'content-type': 'text/plain',
  });
  assert.equal(form.status, 415);
  assert.equal((await state()).tokens.find((t) => t.symbol === 'dDEP').paused, false, 'nothing was sent');

  assert.equal((await call(srv, 'GET', '/api/nothing')).status, 404);
  const m1 = await call(srv, 'POST', '/api/state', {});
  assert.equal(m1.status, 405);
  assert.equal(m1.headers.get('allow'), 'GET');
  const m2 = await call(srv, 'GET', '/api/actions');
  assert.equal(m2.status, 405);
  assert.equal(m2.headers.get('allow'), 'POST');
  assert.equal((await call(srv, 'DELETE', '/')).status, 405);
});

test('X1 the body size is limited (413), streamed or declared', async () => {
  const big = JSON.stringify({ action: 'issue', params: { pad: 'x'.repeat(MAX_BODY + 10) } });
  const declared = await raw(srv, 'POST', '/api/actions', {
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) },
    body: big,
  });
  assert.equal(declared.status, 413);
  assert.equal(JSON.parse(declared.text).error, 'PayloadTooLarge');
  const streamed = await raw(srv, 'POST', '/api/actions', { headers: { 'content-type': 'application/json' }, body: big }); // chunked
  assert.equal(streamed.status, 413);
  // Just under the limit is read and judged on its content.
  const fits = JSON.stringify({ action: 'nothing', params: { pad: 'x'.repeat(MAX_BODY - 100) } });
  const ok = await raw(srv, 'POST', '/api/actions', { headers: { 'content-type': 'application/json' }, body: fits });
  assert.equal(ok.status, 400);
  assert.equal(JSON.parse(ok.text).error, 'UnknownAction');
});

test('X1 static files never leave app/public: path traversal and hidden files get 404', async () => {
  // Raw requests: fetch would normalize "..", and an encoded slash survives the server's URL parser.
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fkit.config.json', '/..%5c..%5cpackage.json', '/%2e%2e/%2e%2e/package.json', '/.git/config', '/%2egitignore', '/app.js%00.html']) {
    const r = await raw(srv, 'GET', p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('devDependencies') && !r.text.includes('"seed"'), `${p} leaked a file`);
  }
  const page = await raw(srv, 'GET', '/');
  assert.equal(page.status, 200, 'the page itself is served');
});

test('X1 503 while no deployment is loaded', async () => {
  const empty = await startServer({ ctx: kit.withDeployment(env.ctx, null), port: 0 });
  extraServers.push(empty);
  const s = await call(empty, 'GET', '/api/state');
  assert.equal(s.status, 503);
  assert.equal(s.json.error, 'NotDeployed');
  const a = await call(empty, 'POST', '/api/actions', { action: 'issue', params: {} });
  assert.equal(a.status, 503);
  const t = await call(empty, 'GET', '/api/templates');
  assert.equal(t.status, 200, 'the template folder can be checked before anything is deployed');
  assert.ok(t.json.files.every((f) => f.valid && !f.deployed));
});

// ============ The page ============

test('GET / falls back to a short text page while app/public/index.html is missing', async () => {
  const r = await call(bare, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/plain/);
  assert.match(r.text, /\/api\/state/);
});

test('GET / serves the console: one static page, no CDN, every panel present and every control labelled', async () => {
  const r = await call(srv, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const html = r.text;

  // No framework, no build step, no external CDN: every src/href is local (or an in-page anchor / data URL).
  for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) assert.ok(!/^(https?:)?\/\//i.test(url), `external resource ${url}`);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);

  // Header: kit name, network, "Act as" with the whole cast.
  assert.match(html, /<h1>EEA Tokenization Starter Kit<\/h1>/);
  assert.match(html, /id="network"/);
  assert.match(html, /<label for="act-as">Act as<\/label>/);
  for (const name of ['Operator', 'Issuer', 'Compliance officer', 'KYC Provider A', 'KYC Provider B', 'Alice', 'Bob', 'Carol', 'Dave']) {
    assert.match(html, new RegExp(`<option value="[a-z-]+"( selected)?>${name}</option>`), `Act as ${name}`);
  }
  for (const h2 of ['Tokens', 'Who may hold what', 'Guided story', 'Actions', 'Audit trail']) assert.match(html, new RegExp(`<h2 id="[a-z-]+">${h2}</h2>`), h2);
  for (const th of ['Time', 'Who', 'Action', 'Token', 'Result', 'Transaction']) assert.match(html, new RegExp(`<th scope="col">${th}</th>`), `audit column ${th}`);
  assert.match(html, /id="story-summary"/);

  // Every select and input in the page has a <label for>.
  for (const [, id] of html.matchAll(/<(?:select|input)[^>]*\bid="([^"]+)"/g)) assert.match(html, new RegExp(`<label for="${id}">`), `control #${id} has a label`);

  const js = await call(srv, 'GET', '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.type, /text\/javascript/);
  assert.ok(!/\binnerHTML\b|insertAdjacentHTML|document\.write/.test(js.text), 'the page inserts server data as text only');
  const css = await call(srv, 'GET', '/style.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /text\/css/);
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(css.text), 'no external stylesheet or font');
});

// ============ The guided story (same code as the page) ============

test('guided story: all seven steps are "as expected" on a freshly seeded kit, ending on the summary', async () => {
  const api = createApi({ base: storySrv.url, fetchImpl: recordingFetch });
  assert.equal(STORY.length, 7);
  assert.deepEqual(
    STORY.map((s) => s.title),
    ['Issue', 'Transfer', 'Refused', 'Revoke', 'Rotate attester', 'Freeze, force, pause', 'New file'],
  );
  const outcomes = [];
  for (const step of STORY) {
    assert.ok(step.expected && step.text && step.who, `step ${step.n} says who acts and what to expect`);
    const out = await runStep(step, api);
    outcomes.push(out);
    const failed = out.checks.filter((c) => !c.ok).map((c) => c.text);
    assert.equal(out.asExpected, true, `step ${step.n} ${step.title} not as expected: ${failed.join(' | ')}`);
    assert.ok(out.checks.length >= 1);
  }
  assert.equal(storySummary(outcomes), '7 of 7 steps as expected.');

  // Step 3 shows the refusal with its topic; step 4 the revocation by topic.
  const refusal = outcomes[2].actions[0].result;
  assert.equal(refusal.ok, false);
  assert.ok(refusal.reasons.some((x) => x.topic === 'ACCREDITATION'));
  assert.ok(outcomes[2].checks.some((c) => /topic ACCREDITATION: “accreditation: policy rejected”/.test(c.text)));
  assert.ok(outcomes[3].checks.some((c) => /topic KYC: “KYC: revoked”/.test(c.text)));

  // The story left the trail the plan asks for (W7 who authorized whom, W8 by the compliance officer).
  const s = await state(storySrv);
  const trail = s.auditTrail;
  assert.ok(trail.some((e) => e.action === 'Credential revoked' && e.actorId === 'kyc-provider-a'));
  assert.ok(trail.some((e) => e.action === 'Provider authorized' && e.actorId === 'operator' && /KYC Provider B/.test(e.detail)));
  for (const a of ['Frozen', 'Forced transfer', 'Paused', 'Unpaused']) assert.ok(trail.some((e) => e.action === a && e.actorId === 'compliance'), a);
});

test('guided story: a step whose outcome does not hold says "not as expected"', async () => {
  const api = createApi({ base: storySrv.url, fetchImpl: recordingFetch });
  // A is no longer trusted anywhere after step 5, so rotating A again is refused.
  const again = await runStep(STORY[4], api);
  assert.equal(again.asExpected, false);
  assert.match(again.checks[0].text, /not trusted/);
  // Alice's only credential (from A, revoked in step 4) no longer counts, so step 2's transfer is refused.
  const transfer = await runStep(STORY[1], api);
  assert.equal(transfer.asExpected, false);
  assert.match(transfer.checks[0].text, /Refused: Alice may not send dDEP \(KYC: .+\) \(expected it to be accepted\)/);
  assert.equal(storySummary([again, transfer, null, null, null, null, null]), '2 of 7 steps run so far, 0 as expected.');
});

test('step 7 (C2): a new template file shows as waiting for a restart; a broken one is named by file and field', async () => {
  const dir = copyTemplates();
  tempDirs.push(dir);
  copyFileSync(path.join(FIXTURES, 'fourth-product.json'), path.join(dir, 'fourth-product.json'));
  const ctx = kit.withDeployment(env.ctx, { ...env.ctx.deployment, templateDirs: [dir] });
  const s = await startServer({ ctx, port: 0 });
  extraServers.push(s);
  const api = createApi({ base: s.url, fetchImpl: recordingFetch });

  let r = await call(s, 'GET', '/api/templates');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.pending, ['dTCP']);
  assert.deepEqual(r.json.missing, []);
  assert.equal(r.json.files.filter((f) => f.deployed).length, 3);
  assert.equal(r.json.restart, 'npm start');
  for (const where of [dir, ROOT, os.homedir(), os.tmpdir()]) assert.ok(!r.text.includes(where), `the report must not reveal ${where}`);
  const fine = await runStep(STORY[6], api);
  assert.equal(fine.asExpected, true, fine.checks.map((c) => c.text).join(' | '));
  assert.ok(fine.checks.some((c) => /dTCP is deployed at the next restart \(npm start\)/.test(c.text)));

  const broken = JSON.parse(readFileSync(path.join(FIXTURES, 'fourth-product.json'), 'utf8'));
  delete broken.symbol;
  broken.id = 'broken-product';
  writeFileSync(path.join(dir, 'broken.json'), JSON.stringify(broken));
  r = await call(s, 'GET', '/api/templates');
  assert.equal(r.json.ok, false);
  const row = r.json.files.find((f) => f.file === 'broken.json');
  assert.deepEqual(row.problem, { field: 'symbol', problem: 'missing' });
  assert.deepEqual(r.json.error, { file: 'broken.json', field: 'symbol', problem: 'missing' });
  const stop = await runStep(STORY[6], api);
  assert.equal(stop.asExpected, false);
  assert.ok(stop.checks.some((c) => !c.ok && /broken\.json: field "symbol": missing/.test(c.text)));

  // The shipped folder, as npm start uses it.
  const shipped = await call(srv, 'GET', '/api/templates');
  assert.equal(shipped.json.ok, true);
  assert.deepEqual(shipped.json.dirs, ['templates']);
  assert.deepEqual(shipped.json.files.map((f) => `${f.file}=${f.token}`).sort(), [
    'templates/money-market-fund.json=dMMF',
    'templates/private-credit-note.json=dPCN',
    'templates/tokenized-deposit.json=dDEP',
  ]);
});

// ============ X3 ============

/**
 * The local private keys found in `text`: every 0x-prefixed 64-hex string equal to one of them, and any key
 * written without its 0x. Each key counts once. Adds 'mnemonic' if the mnemonic is present.
 */
function keyLeaks(text, { keys, mnemonic }) {
  const bare = new Set(keys.map((k) => k.replace(/^0x/, '')));
  const found = new Set();
  for (const m of text.matchAll(/0x[0-9a-fA-F]{64}/g)) if (bare.has(m[0].slice(2).toLowerCase())) found.add(m[0].slice(2).toLowerCase());
  const lower = text.toLowerCase();
  for (const k of bare) if (lower.includes(k)) found.add(k);
  const hits = [...found];
  if (lower.includes(mnemonic)) hits.push('mnemonic');
  return hits;
}

test('X3 no response from the server ever contains a private key or the mnemonic', () => {
  const material = localKeyMaterial();
  // The scanner itself must be able to fail: plant a key and the mnemonic in a fake body.
  assert.equal(keyLeaks(`{"x":"${material.keys[2]}"}`, material).length, 1);
  assert.deepEqual(keyLeaks(`seed: ${material.mnemonic}`, material), ['mnemonic']);

  assert.ok(bodies.length >= 60, `expected the whole X1 run to be recorded, got ${bodies.length} bodies`);
  assert.ok(bodies.some((b) => b.includes('"replaceAttester"')) && bodies.some((b) => b.includes('"auditTrail"')), 'the scan covers action results and state');
  for (const [i, b] of bodies.entries()) {
    assert.deepEqual(keyLeaks(b, material), [], `response ${i} contains key material`);
    assert.ok(!/privatekey|private_key|mnemonic|"account"\s*:\s*\{/i.test(b), `response ${i} mentions a key field`);
  }
});
