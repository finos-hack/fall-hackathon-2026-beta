// The context every action takes: clients, actors (addresses only in enumerable fields), ABIs and the
// deployment record. Check C3: the chain id is read BEFORE anything else, and chain id 1 is refused.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { loadKitConfig, DEFAULT_KIT_CONFIG } from './config.mjs';
import { loadAbis, combinedErrorAbi, combinedEventAbi } from './artifacts.mjs';
import { DEPLOYMENTS_DIR, OUT_DIR } from './paths.mjs';
import {
  loadEnv,
  resolveNetwork,
  MainnetRefusedError,
  NetworkError,
  MAINNET_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  redactUrl,
} from './network.mjs';

/** Reads eth_chainId with a throwaway client. Nothing is signed or sent. */
export async function readChainId(rpcUrl) {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
  try {
    return await client.getChainId();
  } catch (e) {
    throw new NetworkError(`cannot reach the RPC endpoint ${redactUrl(rpcUrl)}: ${e.shortMessage ?? e.message}`);
  }
}

/** Throws unless the chain id is safe for this network. */
export function assertChainAllowed(chainId, { network, expectedChainId, rpcUrl }) {
  if (Number(chainId) === MAINNET_CHAIN_ID) throw new MainnetRefusedError(rpcUrl);
  if (expectedChainId && Number(chainId) !== expectedChainId) {
    throw new NetworkError(
      `NETWORK=${network} expects chain id ${expectedChainId}, but ${redactUrl(rpcUrl)} reports ${chainId}. Check RPC_URL.`,
    );
  }
}

/**
 * @param {object} o
 * @param {Record<string,string>} [o.env]       environment (defaults to process.env over .env)
 * @param {string} [o.rpcUrl]                   overrides the URL from env (e.g. a freshly started anvil)
 * @param {object} [o.kit]                      parsed kit.config.json (defaults to loading it)
 * @param {object} [o.deployment]               deployment record; defaults to reading o.deploymentFile if present
 * @param {string} [o.deploymentFile]           defaults to deployments/<network>.json
 * @param {boolean} [o.loadDeployment]          false: ignore an existing record (a fresh deploy follows)
 */
export async function createContext({
  env = loadEnv(),
  rpcUrl,
  kit,
  kitConfigPath = DEFAULT_KIT_CONFIG,
  deployment,
  deploymentFile,
  loadDeployment = true,
  outDir = OUT_DIR,
  log = () => {},
} = {}) {
  const cast = kit ?? loadKitConfig(kitConfigPath);
  const settings = resolveNetwork({ env, kit: cast });
  const url = rpcUrl ?? settings.rpcUrl;
  if (!url) throw new NetworkError('no RPC endpoint: start a local chain or set RPC_URL');

  // C3: read the chain id before anything else and refuse mainnet.
  const chainId = await readChainId(url);
  assertChainAllowed(chainId, { network: settings.network, expectedChainId: settings.expectedChainId, rpcUrl: url });

  const isLocal = settings.network === 'local';
  const chain =
    chainId === SEPOLIA_CHAIN_ID
      ? { ...sepolia, rpcUrls: { default: { http: [url] } } }
      : defineChain({
          id: chainId,
          name: isLocal ? 'Local chain' : settings.network,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [url] } },
        });
  const pollingInterval = isLocal ? 100 : 2_000;
  const publicClient = createPublicClient({
    chain,
    pollingInterval,
    transport: http(url, { batch: { batchSize: isLocal ? 200 : 20, wait: 0 }, retryCount: 3, timeout: 60_000 }),
  });

  const actors = {};
  const byAddress = new Map();
  const add = (id, name, kind, account) => {
    const actor = { id, name, kind, address: account.address };
    // Keys stay out of every enumerable field, so JSON.stringify(actor) can never include them.
    let wallet;
    Object.defineProperty(actor, 'account', { value: account, enumerable: false });
    Object.defineProperty(actor, 'wallet', {
      enumerable: false,
      get() {
        wallet ??= createWalletClient({ account, chain, pollingInterval, transport: http(url, { retryCount: 2, timeout: 60_000 }) });
        return wallet;
      },
    });
    actors[id] = actor;
    byAddress.set(account.address.toLowerCase(), actor);
  };
  for (const r of Object.values(cast.roles)) add(r.id, r.name, 'role', settings.accounts[r.id]);
  for (const a of cast.attesters) add(a.id, a.name, 'attester', settings.accounts[a.id]);
  for (const i of cast.investors) add(i.id, i.name, 'investor', settings.accounts[i.id]);
  for (const i of cast.institutions ?? []) add(i.id, i.name, 'institution', settings.accounts[i.id]);

  const abis = loadAbis(outDir);
  const ctx = {
    network: settings.network,
    chainId,
    rpcUrl: url,
    explorer: chainId === SEPOLIA_CHAIN_ID ? 'https://sepolia.etherscan.io' : null,
    publicEas: settings.eas,
    chain,
    publicClient,
    kit: cast,
    actors,
    actorByAddress: byAddress,
    abis,
    errorAbi: combinedErrorAbi(abis),
    eventAbi: combinedEventAbi(abis),
    deploymentFile: deploymentFile ?? path.join(DEPLOYMENTS_DIR, `${settings.network}.json`),
    deployment: null,
    log,
    _lock: Promise.resolve(),
    _audit: null,
  };
  if (deployment) setDeployment(ctx, deployment);
  else if (loadDeployment && existsSync(ctx.deploymentFile)) setDeployment(ctx, readDeployment(ctx.deploymentFile));
  return ctx;
}

/**
 * Connects to an existing deployment (for the CLI or a server started on its own), in a process that did not
 * deploy it. Record: deploymentFile, DEPLOYMENT_FILE, or deployments/<NETWORK>.json. RPC: rpcUrl, RPC_URL, or for
 * NETWORK=local the URL stored in the record (falling back to http://127.0.0.1:8545).
 */
export async function openDeployment({ env = loadEnv(), rpcUrl, deploymentFile, kit, log } = {}) {
  const network = (env.NETWORK ?? 'local').trim().toLowerCase() || 'local';
  const file = deploymentFile ?? env.DEPLOYMENT_FILE ?? path.join(DEPLOYMENTS_DIR, `${network}.json`);
  if (!existsSync(file)) {
    throw new NetworkError(`no deployment record at ${file}. Start the kit first (npm start), or pass --deployment <file>.`);
  }
  const deployment = readDeployment(file);
  const url = rpcUrl || env.RPC_URL || (network === 'local' ? deployment.rpcUrl || 'http://127.0.0.1:8545' : undefined);
  return createContext({ env, rpcUrl: url, kit, deployment, deploymentFile: file, log });
}

export function readDeployment(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeDeployment(file, deployment) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
}

/** Points the context at a deployment. Refuses a record made on another chain. */
export function setDeployment(ctx, deployment) {
  if (deployment && Number(deployment.chainId) !== Number(ctx.chainId)) {
    throw new NetworkError(
      `the deployment record is for chain id ${deployment.chainId}, but the RPC endpoint is chain id ${ctx.chainId}. ` +
        'Redeploy (npm start) or point RPC_URL at the right chain.',
    );
  }
  ctx.deployment = deployment;
  ctx._audit = null;
  return ctx;
}

/** A shallow copy of ctx bound to another deployment (same clients and actors). */
export function withDeployment(ctx, deployment) {
  const copy = { ...ctx, _lock: Promise.resolve(), _audit: null, _auditBusy: undefined };
  return setDeployment(copy, deployment);
}

export function requireDeployment(ctx) {
  if (!ctx.deployment) {
    throw new NetworkError(`no deployment loaded: run npm start (or deploy) first. Expected ${ctx.deploymentFile}`);
  }
  return ctx.deployment;
}

/** Serializes everything that sends transactions, so concurrent requests never race on nonces. */
export function withLock(ctx, fn) {
  const run = ctx._lock.then(fn, fn);
  ctx._lock = run.catch(() => {});
  return run;
}

// ============ Lookups ============

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

export function getActor(ctx, id) {
  const a = ctx.actors[id];
  if (!a) throw new InputError(`unknown actor "${id}". Known: ${Object.keys(ctx.actors).join(', ')}`);
  return a;
}

/** A cast id or a 0x address -> {id|null, name, address}. */
export function resolveParty(ctx, ref, field = 'account') {
  if (typeof ref !== 'string' || !ref) throw new InputError(`${field} is required (a cast id such as "alice", or an address)`);
  if (ctx.actors[ref]) {
    const a = ctx.actors[ref];
    return { id: a.id, name: a.name, address: a.address };
  }
  if (isAddress(ref, { strict: false })) {
    const address = getAddress(ref);
    const a = ctx.actorByAddress.get(address.toLowerCase());
    return a ? { id: a.id, name: a.name, address } : { id: null, name: address, address };
  }
  throw new InputError(`${field}: unknown cast id or address "${ref}"`);
}

export function nameOf(ctx, address) {
  if (!address) return null;
  const a = ctx.actorByAddress.get(String(address).toLowerCase());
  return a ? a.name : address;
}

export function idOf(ctx, address) {
  if (!address) return null;
  return ctx.actorByAddress.get(String(address).toLowerCase())?.id ?? null;
}

/** A token by symbol or template id (case-insensitive). */
export function getToken(ctx, ref) {
  const d = requireDeployment(ctx);
  if (typeof ref !== 'string' || !ref) throw new InputError('token is required (a symbol such as dDEP, or a template id)');
  const r = ref.toLowerCase();
  const t = d.tokens.find((x) => x.symbol.toLowerCase() === r || x.id.toLowerCase() === r || x.address.toLowerCase() === r);
  if (!t) throw new InputError(`unknown token "${ref}". Known: ${d.tokens.map((x) => x.symbol).join(', ')}`);
  return t;
}

export function tokenByAddress(ctx, address) {
  const a = String(address).toLowerCase();
  return ctx.deployment?.tokens.find((t) => t.address.toLowerCase() === a) ?? null;
}
