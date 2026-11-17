// Network settings, actor keys and the local chain.
//
// NETWORK=local (default): the kit starts anvil, the local chain from the npm-installed Foundry, unless
//   RPC_URL points at a node that is already running. Actor keys come from anvil's well-known PUBLIC test
//   mnemonic. These keys are public, published in Foundry's documentation, and must never hold real value.
// NETWORK=sepolia: RPC_URL and DEPLOYER_KEY come from the environment or .env. The operator uses
//   DEPLOYER_KEY; every other actor key is derived from it (keccak256(DEPLOYER_KEY || actor id)) and sent
//   a little test ether when its balance runs low.
//
// Nothing in this file returns or logs a private key. Accounts are viem LocalAccount objects whose key
// stays inside viem's closures.

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { keccak256, concat, toHex, isHex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { ROOT } from './paths.mjs';
import { ROLE_IDS } from './config.mjs';

export const SEPOLIA_CHAIN_ID = 11155111;
export const MAINNET_CHAIN_ID = 1;
export const DEFAULT_LOCAL_PORT = 8545;

/**
 * PUBLIC TEST MNEMONIC of anvil (and Hardhat). Every key derived from it is public knowledge.
 * Used only on the local chain. Never send real funds to these addresses.
 */
export const ANVIL_PUBLIC_TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/** Public addresses of the EAS deployment on Sepolia (decision D5: reuse the public EAS there). */
export const SEPOLIA_EAS = Object.freeze({
  eas: '0xC2679fBD37d54388Ce493F1DB75320D236e1815e',
  schemaRegistry: '0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0',
});

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class MainnetRefusedError extends NetworkError {
  constructor(rpcUrl) {
    super(
      `Refusing to run: the RPC endpoint reports chain id 1 (Ethereum mainnet). This kit is testnet only ` +
        `and never sends a transaction to mainnet. Use NETWORK=local or NETWORK=sepolia.` +
        (rpcUrl ? ` (endpoint: ${redactUrl(rpcUrl)})` : ''),
    );
    this.name = 'MainnetRefusedError';
    this.chainId = 1;
  }
}

/** Hides credentials or API keys that providers put in RPC URLs. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    const parts = u.pathname.split('/');
    u.pathname = parts.map((p) => (p.length >= 16 ? `${p.slice(0, 4)}***` : p)).join('/');
    u.search = u.search ? '?***' : '';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

/** Minimal .env reader (KEY=VALUE lines, optional quotes, # comments). No dependency needed. */
export function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** process.env over .env (process.env wins). */
export function loadEnv({ env = process.env, dotEnvPath = path.join(ROOT, '.env') } = {}) {
  const fileVars = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {};
  return { ...fileVars, ...env };
}

/** Ordered cast ids. Local account index = position in this list, so it is stable across processes. */
export function castIds(kit) {
  return [...ROLE_IDS, ...kit.attesters.map((a) => a.id), ...kit.investors.map((i) => i.id)];
}

function normalizeKey(key) {
  const k = key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`;
  if (!isHex(k) || k.length !== 66) throw new NetworkError('DEPLOYER_KEY must be a 32-byte hex private key');
  return /** @type {`0x${string}`} */ (k.toLowerCase());
}

/** keccak256(DEPLOYER_KEY || actor id): deterministic, so the CLI and server agree on every actor. */
function deriveKey(deployerKey, id) {
  return keccak256(concat([deployerKey, toHex(`eea-tokenization-starter-kit:${id}`)]));
}

/**
 * Pure: resolves network settings and actor accounts from env, without any network I/O and without
 * sending anything. Scenario check 1 calls this for Sepolia as a dry check.
 * @returns {{network: 'local'|'sepolia', rpcUrl: string|null, expectedChainId: number|null,
 *   startLocalChain: boolean, accounts: Record<string, import('viem').LocalAccount>, eas: object|null}}
 */
export function resolveNetwork({ env = loadEnv(), kit }) {
  const network = (env.NETWORK ?? 'local').trim().toLowerCase() || 'local';
  const ids = castIds(kit);
  if (network === 'local') {
    const accounts = {};
    ids.forEach((id, i) => {
      // PUBLIC TEST KEYS (anvil mnemonic, index i). Local chain only.
      accounts[id] = mnemonicToAccount(ANVIL_PUBLIC_TEST_MNEMONIC, { addressIndex: i });
    });
    const rpcUrl = env.RPC_URL?.trim() || null;
    return { network, rpcUrl, expectedChainId: null, startLocalChain: !rpcUrl, accounts, accountCount: ids.length, eas: null };
  }
  if (network === 'sepolia') {
    const rpcUrl = env.RPC_URL?.trim();
    const key = env.DEPLOYER_KEY?.trim();
    const missing = [!rpcUrl && 'RPC_URL', !key && 'DEPLOYER_KEY'].filter(Boolean);
    if (missing.length) {
      throw new NetworkError(
        `NETWORK=sepolia needs ${missing.join(' and ')} in the environment or in .env ` +
          `(RPC_URL: a Sepolia endpoint; DEPLOYER_KEY: one funded Sepolia test key).`,
      );
    }
    const deployerKey = normalizeKey(key);
    const accounts = {};
    for (const id of ids) {
      accounts[id] = privateKeyToAccount(id === 'operator' ? deployerKey : deriveKey(deployerKey, id));
    }
    return {
      network,
      rpcUrl,
      expectedChainId: SEPOLIA_CHAIN_ID,
      startLocalChain: false,
      accounts,
      accountCount: ids.length,
      eas: { ...SEPOLIA_EAS },
    };
  }
  throw new NetworkError(`NETWORK must be "local" or "sepolia", not "${env.NETWORK}"`);
}

// ============ Local chain ============

/** A port the OS says is free right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Path to the anvil binary from the npm package, falling back to its node wrapper. */
function anvilCommand() {
  const require = createRequire(import.meta.url);
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  if (arch) {
    try {
      const bin = require.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/bin/${exe}`);
      if (existsSync(bin)) return { cmd: bin, pre: [] };
    } catch {
      // fall through to the wrapper
    }
  }
  return { cmd: process.execPath, pre: [require.resolve('@foundry-rs/anvil/bin.mjs')] };
}

async function rpcReady(url) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const j = await r.json();
    return typeof j.result === 'string';
  } catch {
    return false;
  }
}

/**
 * Starts anvil with the public test mnemonic. Resolves once it answers eth_chainId.
 * @returns {Promise<{url: string, port: number, chainId: number, stop: () => Promise<void>}>}
 */
export async function startAnvil({ port, chainId = 31337, accounts = 10, log = () => {} } = {}) {
  const p = port ?? (await freePort());
  const { cmd, pre } = anvilCommand();
  const args = [
    ...pre,
    '--host', '127.0.0.1',
    '--port', String(p),
    '--chain-id', String(chainId),
    '--accounts', String(Math.max(10, accounts)),
    '--mnemonic', ANVIL_PUBLIC_TEST_MNEMONIC, // public test mnemonic, local chain only
    '--silent',
  ];
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  const killOnExit = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  };
  process.on('exit', killOnExit);

  const url = `http://127.0.0.1:${p}`;
  const deadline = Date.now() + 30_000;
  while (!(await rpcReady(url))) {
    if (exited) {
      process.off('exit', killOnExit);
      throw new NetworkError(`anvil exited before it was ready (code ${exited.code}): ${stderr.trim() || 'no output'}`);
    }
    if (Date.now() > deadline) {
      killOnExit();
      process.off('exit', killOnExit);
      throw new NetworkError(`anvil did not answer on ${url} within 30 s: ${stderr.trim()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  log(`Local chain (anvil) started at ${url}, chain id ${chainId}`);

  const stop = () =>
    new Promise((resolve) => {
      process.off('exit', killOnExit);
      if (exited) return resolve();
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  return { url, port: p, chainId, stop, pid: child.pid };
}
