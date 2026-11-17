// Network settings: NETWORK=local uses anvil's PUBLIC test keys; NETWORK=sepolia needs RPC_URL + DEPLOYER_KEY and
// derives every other actor deterministically from the deployer key. All pure: no chain needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { resolveNetwork, parseDotEnv, redactUrl, NetworkError, SEPOLIA_CHAIN_ID, castIds } from '../../app/lib/network.mjs';
import { loadKitConfig } from '../../app/lib/config.mjs';
import { topicId, topicName, statusText, describeTopicStatus, TOPICS } from '../../app/lib/topics.mjs';

const kit = loadKitConfig();

test('local: actors map to the anvil public test accounts by cast order', () => {
  const s = resolveNetwork({ env: {}, kit });
  assert.equal(s.network, 'local');
  assert.equal(s.startLocalChain, true);
  assert.deepEqual(castIds(kit).slice(0, 5), ['operator', 'issuer', 'compliance', 'kyc-provider-a', 'kyc-provider-b']);
  // anvil account 0 (public, documented test address)
  assert.equal(s.accounts.operator.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(s.accounts.issuer.address, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  const withRpc = resolveNetwork({ env: { RPC_URL: 'http://127.0.0.1:9999' }, kit });
  assert.equal(withRpc.startLocalChain, false);
});

test('sepolia: needs RPC_URL and DEPLOYER_KEY, says which is missing', () => {
  assert.throws(() => resolveNetwork({ env: { NETWORK: 'sepolia' }, kit }), (e) => e instanceof NetworkError && /RPC_URL and DEPLOYER_KEY/.test(e.message));
  assert.throws(() => resolveNetwork({ env: { NETWORK: 'sepolia', RPC_URL: 'https://x' }, kit }), /needs DEPLOYER_KEY/);
  assert.throws(() => resolveNetwork({ env: { NETWORK: 'sepolia', RPC_URL: 'https://x', DEPLOYER_KEY: '0x1234' }, kit }), /32-byte/);
  assert.throws(() => resolveNetwork({ env: { NETWORK: 'mainnet' }, kit }), /must be "local" or "sepolia"/);
});

test('sepolia: operator is DEPLOYER_KEY; other actors are derived, distinct and deterministic', () => {
  const key = generatePrivateKey();
  const env = { NETWORK: 'sepolia', RPC_URL: 'https://sepolia.example/v3/abc', DEPLOYER_KEY: key };
  const a = resolveNetwork({ env, kit });
  const b = resolveNetwork({ env: { ...env, DEPLOYER_KEY: key.slice(2) }, kit });
  assert.equal(a.expectedChainId, SEPOLIA_CHAIN_ID);
  assert.equal(a.accounts.operator.address, privateKeyToAccount(key).address);
  const addrs = Object.values(a.accounts).map((x) => x.address);
  assert.equal(new Set(addrs).size, addrs.length);
  for (const id of Object.keys(a.accounts)) assert.equal(a.accounts[id].address, b.accounts[id].address, id);
  const other = resolveNetwork({ env: { ...env, DEPLOYER_KEY: generatePrivateKey() }, kit });
  assert.notEqual(other.accounts.alice.address, a.accounts.alice.address);
});

test('.env parsing and RPC URL redaction', () => {
  assert.deepEqual(parseDotEnv('# c\nNETWORK=sepolia\nexport RPC_URL="https://a/b"\nDEPLOYER_KEY=0xab # note\n'), {
    NETWORK: 'sepolia',
    RPC_URL: 'https://a/b',
    DEPLOYER_KEY: '0xab',
  });
  const r = redactUrl('https://user:pass@eth-sepolia.example.com/v2/abcdefghijklmnopqrstuvwxyz?key=secret');
  assert.ok(!r.includes('abcdefghijklmnop') && !r.includes('secret') && !r.includes('pass'), r);
});

test('topic names, ids and refusal texts', () => {
  assert.equal(topicId('ACCREDITATION'), 7);
  assert.equal(topicName(13), 'SANCTIONS');
  assert.throws(() => topicId('KYCC'), /unknown topic/);
  assert.equal(statusText(7, 'POLICY_REJECTED'), 'accreditation: policy rejected');
  assert.equal(statusText('KYC', 2), 'KYC: revoked');
  assert.deepEqual(describeTopicStatus({ topic: 3n, status: 5 }), { topic: 'COUNTRY', topicId: 3, status: 'POLICY_REJECTED', text: 'country: policy rejected' });
  assert.deepEqual(Object.values(TOPICS), [1, 2, 3, 7, 9, 10, 13, 14]);
});
