// C2 (W9): a fourth product from test/fixtures/templates deploys next to the shipped three and works,
// with no file changed outside the templates folder (the fixture is only copied into a temp templates dir).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as kit from '../../core/actions/index.mjs';
import { chainAndContext, copyTemplates, readJson, rm, TEMPLATES, FIXTURES, ROOT } from './helpers/kit.mjs';

let env;
let dir;
const fixture = readJson(path.join(FIXTURES, 'fourth-product.json'));

function fingerprint() {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(path.join(ROOT, 'core'));
  walk(path.join(ROOT, 'examples'));
  walk(path.join(ROOT, 'contracts'));
  walk(TEMPLATES);
  return h.digest('hex');
}

let before0;
before(async () => {
  before0 = fingerprint();
  env = await chainAndContext();
  dir = copyTemplates([TEMPLATES, FIXTURES]);
});
after(async () => {
  await env?.stop();
  if (dir) rm(dir);
});

test('C2 the fixture is a new product the shipped templates do not contain', () => {
  const shipped = readdirSync(TEMPLATES).map((f) => readJson(path.join(TEMPLATES, f)));
  assert.ok(!shipped.some((t) => t.id === fixture.id || t.symbol === fixture.symbol), 'fixture must be a fourth product');
});

test('C2 four templates deploy with no code change, and the fourth token works end to end', async () => {
  const d = await kit.deploy(env.ctx, { templateDirs: [dir] });
  assert.equal(d.tokens.length, 4);
  const t = d.tokens.find((x) => x.symbol === fixture.symbol);
  assert.ok(t, 'fourth token deployed');
  assert.deepEqual(t.topics, fixture.requiredTopics);
  assert.ok((await env.ctx.publicClient.getCode({ address: t.address })).length > 2);

  // W1 + W2 on the new deployment, then issue, refuse and redeem on the fourth token.
  const auth = await kit.authorizeProvider(env.ctx, { provider: fixture.trustedAttesters[0] });
  assert.equal(auth.ok, true, auth.message);
  assert.ok(auth.trusted.some((x) => x.token === fixture.symbol), 'provider trusted on the fourth token');
  assert.equal((await kit.onboardInvestor(env.ctx, { actor: 'kyc-provider-a', investor: 'bob' })).ok, true);
  const issued = await kit.issue(env.ctx, { token: fixture.symbol, to: 'bob', amount: '25' });
  assert.equal(issued.ok, true, issued.message);
  const carol = await kit.issue(env.ctx, { token: fixture.symbol, to: 'carol', amount: '1' });
  assert.equal(carol.ok, false);
  assert.equal(carol.error, 'ERC7943CannotReceive');
  assert.deepEqual(
    carol.reasons.map((r) => r.topic).sort(),
    [...fixture.requiredTopics].sort(),
    'Carol fails every topic of the fourth product',
  );
  assert.equal((await kit.redeem(env.ctx, { token: fixture.symbol, from: 'bob', amount: '5' })).ok, true);

  const s = await kit.getState(env.ctx);
  assert.equal(s.tokens.length, 4);
  assert.equal(s.balances.bob[fixture.symbol].balance, '20');
  assert.equal(s.matrix.bob[fixture.symbol].eligible, true);
  assert.ok(s.auditTrail.some((e) => e.token === fixture.symbol && e.action === 'Issued'));

  assert.equal(fingerprint(), before0, 'core/, examples/, contracts/ or templates/ changed');
});
