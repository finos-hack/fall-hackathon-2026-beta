// Loads contract ABIs and bytecode from Foundry's build output (out/<File>.sol/<Contract>.json).
// When several compiler versions emit the same contract, Foundry writes either nested paths
// (out/contracts/RegulatedToken.sol/...) or versioned names (<Contract>.0.8.24.json); both are handled.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { toFunctionSelector, toEventSelector } from 'viem';
import { OUT_DIR, ROOT } from './paths.mjs';

/** Contracts the deployer needs, as [file, contract]. */
export const KIT_CONTRACTS = Object.freeze({
  SchemaRegistry: 'SchemaRegistry.sol',
  EAS: 'EAS.sol',
  TrustedIssuerResolver: 'TrustedIssuerResolver.sol',
  EASIdentityProxy: 'EASIdentityProxy.sol',
  ClaimTopicsRegistry: 'ClaimTopicsRegistry.sol',
  EASTrustedIssuersAdapter: 'EASTrustedIssuersAdapter.sol',
  EASClaimVerifier: 'EASClaimVerifier.sol',
  KYCStatusPolicy: 'KYCStatusPolicy.sol',
  AMLPolicy: 'AMLPolicy.sol',
  SanctionsPolicy: 'SanctionsPolicy.sol',
  SourceOfFundsPolicy: 'SourceOfFundsPolicy.sol',
  ProfessionalInvestorPolicy: 'ProfessionalInvestorPolicy.sol',
  InstitutionalInvestorPolicy: 'InstitutionalInvestorPolicy.sol',
  CountryAllowListPolicy: 'CountryAllowListPolicy.sol',
  AccreditationPolicy: 'AccreditationPolicy.sol',
  ShibuiEligibility: 'ShibuiEligibility.sol',
  RegulatedToken: 'RegulatedToken.sol',
  DvPSettlement: 'DvPSettlement.sol',
  VleiEligibility: 'VleiEligibility.sol',
  AttesterResolver: 'AttesterResolver.sol',
});

export class ArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactError';
  }
}

function versionKey(v) {
  return (v ?? '0.0.0').split(/[.+]/).slice(0, 3).map((x) => Number(x) || 0);
}

function compareVersions(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** All directories named `fileName` under outDir (depth-limited walk). */
function findFileDirs(outDir, fileName, depth = 4) {
  const found = [];
  const walk = (dir, d) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'build-info') continue;
      const p = path.join(dir, e.name);
      if (e.name === fileName) found.push(p);
      else if (d > 0 && !e.name.endsWith('.sol')) walk(p, d - 1);
    }
  };
  walk(outDir, depth);
  return found;
}

const cache = new Map();

/**
 * @returns {{name: string, abi: any[], bytecode: `0x${string}`, compiler: string, path: string}}
 */
export function loadArtifact(contract, { outDir = OUT_DIR, file = KIT_CONTRACTS[contract] } = {}) {
  if (!file) throw new ArtifactError(`no source file known for contract ${contract}`);
  const key = `${outDir}:${file}:${contract}`;
  if (cache.has(key)) return cache.get(key);

  const nameRe = new RegExp(`^${contract}(?:\\.(\\d+\\.\\d+\\.\\d+))?\\.json$`);
  const candidates = [];
  for (const dir of findFileDirs(outDir, file)) {
    for (const f of readdirSync(dir)) {
      const m = nameRe.exec(f);
      if (!m) continue;
      const p = path.join(dir, f);
      const json = JSON.parse(readFileSync(p, 'utf8'));
      const compiler = json.metadata?.compiler?.version ?? m[1] ?? '0.0.0';
      candidates.push({ p, json, compiler });
    }
  }
  if (candidates.length === 0) {
    throw new ArtifactError(`artifact ${file}:${contract} not found in ${path.relative(ROOT, outDir) || outDir}/. Run: npm run build`);
  }
  // Deterministic choice: highest compiler version, then shortest path.
  candidates.sort((a, b) => compareVersions(b.compiler, a.compiler) || a.p.length - b.p.length);
  const { p, json, compiler } = candidates[0];
  const bytecode = json.bytecode?.object ?? json.bytecode;
  if (typeof bytecode !== 'string' || bytecode.length < 4) throw new ArtifactError(`artifact ${p} has no bytecode`);
  const art = {
    name: contract,
    abi: json.abi,
    bytecode: bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`,
    compiler,
    path: p,
  };
  cache.set(key, art);
  return art;
}

/** True when every artifact the kit needs is present. */
export function artifactsPresent(outDir = OUT_DIR) {
  try {
    for (const c of Object.keys(KIT_CONTRACTS)) loadArtifact(c, { outDir });
    return true;
  } catch (e) {
    if (e instanceof ArtifactError) return false;
    throw e;
  }
}

/** Runs `forge build` through the npm-installed Foundry (decision D8: no global Foundry). */
export function buildContracts({ stdio = 'inherit' } = {}) {
  const require = createRequire(import.meta.url);
  const forge = require.resolve('@foundry-rs/forge/bin.mjs');
  const r = spawnSync(process.execPath, [forge, 'build'], { cwd: ROOT, stdio });
  if (r.status !== 0) throw new ArtifactError(`forge build failed (exit ${r.status})`);
  cache.clear();
}

/** Builds when out/ lacks any artifact the kit needs. Returns true if it built. */
export function ensureBuilt({ log = () => {}, outDir = OUT_DIR } = {}) {
  if (existsSync(outDir) && statSync(outDir).isDirectory() && artifactsPresent(outDir)) return false;
  log('Contracts not built yet: running forge build (first run takes a few minutes)...');
  buildContracts();
  if (!artifactsPresent(outDir)) throw new ArtifactError('forge build finished but kit artifacts are still missing');
  return true;
}

/** All ABIs keyed by contract name. */
export function loadAbis(outDir = OUT_DIR) {
  const abis = {};
  for (const c of Object.keys(KIT_CONTRACTS)) abis[c] = loadArtifact(c, { outDir }).abi;
  return abis;
}

/** One ABI holding every custom error any kit contract can raise, deduplicated by selector. */
export function combinedErrorAbi(abis) {
  const bySelector = new Map();
  for (const abi of Object.values(abis)) {
    for (const item of abi) {
      if (item.type !== 'error') continue;
      const sel = toFunctionSelector(`${item.name}(${item.inputs.map((i) => formatType(i)).join(',')})`);
      if (!bySelector.has(sel)) bySelector.set(sel, item);
    }
  }
  return [...bySelector.values()];
}

/** One ABI holding every event of the kit contracts, deduplicated by topic0. */
export function combinedEventAbi(abis) {
  const byTopic = new Map();
  for (const abi of Object.values(abis)) {
    for (const item of abi) {
      if (item.type !== 'event') continue;
      const sig = `${item.name}(${item.inputs.map((i) => formatType(i)).join(',')})`;
      const t = toEventSelector(sig);
      if (!byTopic.has(t)) byTopic.set(t, item);
    }
  }
  return [...byTopic.values()];
}

function formatType(input) {
  if (!input.type.startsWith('tuple')) return input.type;
  const inner = `(${input.components.map(formatType).join(',')})`;
  return inner + input.type.slice('tuple'.length);
}
