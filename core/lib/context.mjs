// The context every core action takes: clients, the cast (addresses in enumerable fields only), ABIs and the
// deployment record. The core holds no keys and reads no environment: the caller passes the cast and one viem
// Account per cast member (a local key, a remote signer such as an HSM or MPC service wrapped with viem's toAccount,
// or a JSON-RPC account). Check C3: the chain id is read BEFORE anything else, and chain id 1 is refused.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { validateCast } from './config.mjs';
import { loadAbis, combinedErrorAbi, combinedEventAbi } from './artifacts.mjs';
import { OUT_DIR } from './paths.mjs';
import { readChainId, assertChainAllowed, NetworkError, SEPOLIA_CHAIN_ID } from './chain.mjs';

const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/** Every cast id, in a stable order: roles, attesters, investors, institutions. */
export function castMemberIds(cast) {
  return [
    ...Object.keys(cast.roles),
    ...cast.attesters.map((a) => a.id),
    ...cast.investors.map((i) => i.id),
    ...(cast.institutions ?? []).map((i) => i.id),
  ];
}

/**
 * @param {object} o
 * @param {string} o.rpcUrl                       an Ethereum JSON-RPC endpoint
 * @param {object} o.cast                         the cast (see schemas/kit-config.schema.json); validated here
 * @param {Record<string, import('viem').Account> | ((id: string) => import('viem').Account)} o.signers
 *                                                one viem Account per cast id
 * @param {object} [o.deployment]                 a deployment record (see deploy())
 * @param {string|null} [o.deploymentFile]        where deploy() writes the record by default (null: nowhere)
 * @param {string} [o.network]                    a label for messages and records ("local", "sepolia", ...)
 * @param {number|null} [o.expectedChainId]       refuse any other chain id
 * @param {{eas: string, schemaRegistry: string}|null} [o.publicEas]  reuse an existing EAS instead of deploying one
 * @param {string[]|null} [o.templateDirs]        default template directories for deploy()
 * @param {(ctx, actor) => Promise<void>} [o.topUp]  called before each send, e.g. to fund an actor with test ether
 * @param {'execute'|'prepare'} [o.mode]          'prepare': single-transaction actions return unsigned transactions
 */
export async function createContext({
  rpcUrl,
  cast,
  signers,
  deployment,
  deploymentFile = null,
  network = 'custom',
  expectedChainId = null,
  publicEas = null,
  templateDirs = null,
  topUp = null,
  mode = 'execute',
  outDir = OUT_DIR,
  log = () => {},
} = {}) {
  if (!rpcUrl) throw new NetworkError('no RPC endpoint: pass rpcUrl (an Ethereum JSON-RPC URL)');
  const castOk = validateCast(cast, 'cast');
  if (!signers) throw new NetworkError('no signers: pass one viem Account per cast id (signers: {id: account} or a function)');

  // C3: read the chain id before anything else and refuse mainnet.
  const chainId = await readChainId(rpcUrl);
  assertChainAllowed(chainId, { network, expectedChainId, rpcUrl });

  const isLocal = LOCAL_CHAIN_IDS.has(chainId);
  const chain =
    chainId === SEPOLIA_CHAIN_ID
      ? { ...sepolia, rpcUrls: { default: { http: [rpcUrl] } } }
      : defineChain({
          id: chainId,
          name: isLocal ? 'Local Ethereum node' : network,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
        });
  const pollingInterval = isLocal ? 100 : 2_000;
  const publicClient = createPublicClient({
    chain,
    pollingInterval,
    transport: http(rpcUrl, { batch: { batchSize: isLocal ? 200 : 20, wait: 0 }, retryCount: 3, timeout: 60_000 }),
  });

  const signerFor = typeof signers === 'function' ? signers : (id) => signers[id];
  const actors = {};
  const byAddress = new Map();
  const missing = [];
  const add = (id, name, kind) => {
    const account = signerFor(id);
    if (!account || !isAddress(account.address ?? '', { strict: false })) {
      missing.push(id);
      return;
    }
    const actor = { id, name, kind, address: getAddress(account.address) };
    // Signing material stays out of every enumerable field, so JSON.stringify(actor) can never include it.
    let wallet;
    Object.defineProperty(actor, 'account', { value: account, enumerable: false });
    Object.defineProperty(actor, 'wallet', {
      enumerable: false,
      get() {
        wallet ??= createWalletClient({ account, chain, pollingInterval, transport: http(rpcUrl, { retryCount: 2, timeout: 60_000 }) });
        return wallet;
      },
    });
    actors[id] = actor;
    byAddress.set(actor.address.toLowerCase(), actor);
  };
  for (const r of Object.values(castOk.roles)) add(r.id, r.name, 'role');
  for (const a of castOk.attesters) add(a.id, a.name, 'attester');
  for (const i of castOk.investors) add(i.id, i.name, 'investor');
  for (const i of castOk.institutions) add(i.id, i.name, 'institution');
  if (missing.length) throw new NetworkError(`no signer (viem Account) for cast member(s): ${missing.join(', ')}`);

  const abis = loadAbis(outDir);
  const ctx = {
    network,
    chainId,
    rpcUrl,
    explorer: chainId === SEPOLIA_CHAIN_ID ? 'https://sepolia.etherscan.io' : null,
    publicEas,
    chain,
    publicClient,
    kit: castOk,
    actors,
    actorByAddress: byAddress,
    abis,
    errorAbi: combinedErrorAbi(abis),
    eventAbi: combinedEventAbi(abis),
    deploymentFile,
    templateDirs,
    topUp,
    mode,
    deployment: null,
    log,
    _lock: Promise.resolve(),
    _audit: null,
  };
  if (deployment) setDeployment(ctx, deployment);
  return ctx;
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
        'Redeploy or point the RPC URL at the right chain.',
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

/** A shallow copy of ctx in another mode: 'prepare' makes single-transaction actions return unsigned transactions. */
export function withMode(ctx, mode) {
  if (mode !== 'execute' && mode !== 'prepare') throw new InputError(`mode must be "execute" or "prepare", not ${JSON.stringify(mode)}`);
  return { ...ctx, mode };
}

export function requireDeployment(ctx) {
  if (!ctx.deployment) {
    throw new NetworkError(`no deployment loaded: deploy first${ctx.deploymentFile ? ` (expected ${ctx.deploymentFile})` : ''}`);
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
