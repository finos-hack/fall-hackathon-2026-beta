// Shared helpers for the Node tests. Every test file starts its OWN anvil on a random free port and stops it.
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { startAnvil, castIds, ANVIL_PUBLIC_TEST_MNEMONIC } from '../../../examples/lib/network.mjs';
import { loadKitConfig } from '../../../examples/lib/config.mjs';
import { createContext } from '../../../examples/lib/context.mjs';
import { artifactsPresent } from '../../../core/lib/artifacts.mjs';
import { ROOT } from '../../../core/lib/paths.mjs';

export { ROOT };
export const TEMPLATES = path.join(ROOT, 'templates');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'templates');

export function requireArtifacts() {
  if (!artifactsPresent()) throw new Error('contract artifacts missing: run `npm run build` before `npm run test:node`');
}

export function tmpDir(prefix = 'eea-kit-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rm(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Copies every template from the given dirs into a fresh temp dir. */
export function copyTemplates(dirs = [TEMPLATES]) {
  const dir = tmpDir('eea-kit-templates-');
  for (const d of dirs) for (const f of readdirSync(d)) if (f.endsWith('.json')) copyFileSync(path.join(d, f), path.join(dir, f));
  return dir;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** Starts anvil (random port) and a context on it. deploymentFile defaults to a temp file, never deployments/. */
export async function chainAndContext({ chainId = 31337, deploymentFile } = {}) {
  requireArtifacts();
  const anvil = await startAnvil({ chainId, accounts: castIds(loadKitConfig()).length });
  const dir = tmpDir();
  const ctx = await createContext({ env: {}, rpcUrl: anvil.url, deploymentFile: deploymentFile ?? path.join(dir, 'local.json'), loadDeployment: false });
  return {
    anvil,
    ctx,
    dir,
    async stop() {
      await anvil.stop();
      rm(dir);
    },
  };
}

/** All key material of the local cast: the PUBLIC anvil test keys (indexes 0..19) and the mnemonic. */
export function localKeyMaterial() {
  const keys = [];
  for (let i = 0; i < 20; i++) {
    const pk = toHex(mnemonicToAccount(ANVIL_PUBLIC_TEST_MNEMONIC, { addressIndex: i }).getHdKey().privateKey);
    keys.push(pk.toLowerCase(), pk.slice(2).toLowerCase());
  }
  return { keys, mnemonic: ANVIL_PUBLIC_TEST_MNEMONIC };
}

/** Asserts that `text` contains no private key and no mnemonic words. */
export function assertNoKeyMaterial(assert, text, what) {
  const lower = text.toLowerCase();
  const { keys, mnemonic } = localKeyMaterial();
  for (const k of keys) assert.ok(!lower.includes(k), `${what} contains a private key`);
  assert.ok(!lower.includes(mnemonic), `${what} contains the mnemonic`);
  assert.ok(!lower.includes('test test test'), `${what} contains mnemonic words`);
  assert.ok(!/privatekey|private_key|mnemonic/i.test(text), `${what} mentions key fields`);
}

/** Runs a node script, resolves {code, stdout, stderr}. */
export function runNode(args, { env = {}, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout running node ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeout);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The demo cast table from the build plan (section 4), as failing topics per investor and token. */
export const CAST_TABLE = Object.freeze({
  alice: { dDEP: [], dMMF: [], dPCN: ['ACCREDITATION'] },
  bob: { dDEP: [], dMMF: [], dPCN: [] },
  carol: { dDEP: ['KYC', 'SANCTIONS'], dMMF: ['KYC', 'AML', 'COUNTRY'], dPCN: ['KYC', 'ACCREDITATION', 'COUNTRY'] },
  dave: { dDEP: [], dMMF: ['COUNTRY'], dPCN: ['ACCREDITATION', 'COUNTRY'] },
});
