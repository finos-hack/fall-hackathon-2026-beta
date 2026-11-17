// Minimal server routes (the console milestone extends them): state, actions, refusal reasons by topic,
// bad requests, static fallback, and no key material in any response.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../../app/actions/index.mjs';
import { startServer } from '../../app/server.mjs';
import { chainAndContext, assertNoKeyMaterial, tmpDir, rm } from './helpers/kit.mjs';

let env;
let srv;
let publicDir;
const bodies = [];

async function call(method, path, body) {
  const r = await fetch(srv.url + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  bodies.push(text);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, text, json, type: r.headers.get('content-type') };
}

before(async () => {
  env = await chainAndContext();
  await kit.deploy(env.ctx, {});
  await kit.seedDemo(env.ctx);
  publicDir = tmpDir(); // empty: no console page yet
  srv = await startServer({ ctx: env.ctx, port: 0, publicDir });
});
after(async () => {
  await srv?.close();
  await env?.stop();
  if (publicDir) rm(publicDir);
});

test('GET /api/state returns the state', async () => {
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.equal(r.json.tokens.length, 3);
  assert.equal(r.json.matrix.bob.dPCN.eligible, true);
});

test('POST /api/actions runs an action through the library', async () => {
  const r = await call('POST', '/api/actions', { action: 'issue', actor: 'issuer', params: { token: 'dMMF', to: 'bob', amount: '2' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.txHash, /^0x[0-9a-f]{64}$/);
  const s = await call('GET', '/api/state');
  assert.equal(s.json.balances.bob.dMMF.balance, '502');
});

test('X1 a refused action returns reasons by topic', async () => {
  const r = await call('POST', '/api/actions', { action: 'issue', actor: 'issuer', params: { token: 'dMMF', to: 'dave', amount: '1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'ERC7943CannotReceive');
  assert.deepEqual(r.json.reasons, [{ topic: 'COUNTRY', topicId: 3, status: 'POLICY_REJECTED', text: 'country: policy rejected' }]);
});

test('bad requests get 400; unknown routes 404; wrong methods 405', async () => {
  assert.equal((await call('POST', '/api/actions', 'not json')).status, 400);
  assert.equal((await call('POST', '/api/actions', { params: {} })).status, 400);
  const u = await call('POST', '/api/actions', { action: 'mint', params: {} });
  assert.equal(u.status, 400);
  assert.equal(u.json.error, 'UnknownAction');
  const b = await call('POST', '/api/actions', { action: 'issue', params: { token: 'dDEP', to: 'bob', amount: 'lots' } });
  assert.equal(b.status, 400);
  assert.equal(b.json.error, 'BadRequest');
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  assert.equal((await call('POST', '/api/state', {})).status, 405);
  assert.equal((await call('GET', '/../package.json')).status, 404);
});

test('GET / falls back to a short text page until the console exists', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /\/api\/state/);
});

test('X3 no response ever contains key material', () => {
  assert.ok(bodies.length >= 8);
  for (const b of bodies) assertNoKeyMaterial(assert, b, 'server response');
});
