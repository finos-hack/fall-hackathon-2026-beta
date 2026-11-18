// S8 (issue #5): the manual Sepolia recording. Without its inputs it stops before any network call, and it can never
// write a real institution's name or LEI. The real run needs repository secrets and is started by the maintainer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sepoliaRequirements, sepoliaStories, mainLineOf, redactAndCheck, recordSepolia } from '../../examples/record-sepolia.mjs';
import { STORIES, RecordingError } from '../../examples/record.mjs';
import { runNode } from './helpers/kit.mjs';

const UID = (n) => `0x${String(n).repeat(64)}`;

test('dry run: no inputs, a clear message, and nothing sent (no RPC call is even attempted)', async () => {
  assert.deepEqual(sepoliaRequirements({}).missing, ['RPC_URL', 'DEPLOYER_KEY', 'VLEI_HOLDER_KEYS', 'VLEI_HOLDER_UIDS']);
  // An RPC URL that would hang if it were ever called: the check must stop first.
  await assert.rejects(() => recordSepolia({ env: { RPC_URL: 'http://10.255.255.1:9', DEPLOYER_KEY: '0x01' }, log: () => {} }), (e) => e instanceof RecordingError && /needs VLEI_HOLDER_KEYS; VLEI_HOLDER_UIDS\. Nothing was sent/.test(e.message));
  const bad = sepoliaRequirements({ RPC_URL: 'x', DEPLOYER_KEY: 'y', VLEI_HOLDER_KEYS: 'a', VLEI_HOLDER_UIDS: '0x12' });
  assert.deepEqual(bad.problems, ['VLEI_HOLDER_KEYS must hold exactly two keys', 'VLEI_HOLDER_UIDS must hold exactly two 32-byte attestation UIDs']);
});

test('dry run from the command line exits 1 with the message, as the workflow does without secrets', async () => {
  const env = { RPC_URL: '', DEPLOYER_KEY: '', VLEI_HOLDER_KEYS: '', VLEI_HOLDER_UIDS: '' };
  const r = await runNode(['examples/record-sepolia.mjs'], { env, timeout: 60_000 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /npm run record:sepolia stopped: the Sepolia recording needs RPC_URL; DEPLOYER_KEY; VLEI_HOLDER_KEYS; VLEI_HOLDER_UIDS\. Nothing was sent/);
});

test('Sepolia stories: the main lines of D and E, no forks, and E registers the real attestations instead of issuing', () => {
  const [d, e] = sepoliaStories([UID(1), UID(2)]);
  assert.deepEqual([d.id, e.id], ['dvp', 'vlei']);
  for (const s of [d, e]) assert.ok(s.steps.every((x) => !x.fork), 'no fork: public networks cannot rewind');
  assert.deepEqual(d.steps.map((x) => x.id), mainLineOf(STORIES.find((x) => x.id === 'dvp').steps).map((x) => x.id));
  const reg = e.steps.filter((x) => x.action === 'registerEntityCredential');
  assert.deepEqual(reg.map((x) => x.params.uid), [UID(1), UID(2)]);
  assert.ok(!e.steps.some((x) => x.action === 'onboardEntity' || x.action === 'revokeEntity'), 'Interlock never issues or revokes on the real bridge');
});

test('redaction: real names and LEIs are replaced, and any leftover (any case) stops the write', () => {
  const secrets = ['Real Example Bank AG', '529900EXAMPLE0000001'];
  const json = JSON.stringify({ a: 'paid Real Example Bank AG', b: ['LEI 529900EXAMPLE0000001'] });
  const out = redactAndCheck(json, secrets);
  assert.ok(!out.includes('Real Example Bank AG') && !out.includes('529900EXAMPLE0000001'));
  assert.match(out, /\[withheld\]/);
  assert.throws(() => redactAndCheck(JSON.stringify({ a: 'REAL EXAMPLE BANK AG' }), secrets), /still in the Sepolia recording; nothing was written/);
});
