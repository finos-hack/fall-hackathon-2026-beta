// Loads and validates kit.config.json (the demo cast) and the product templates.
// Check C1: a bad template stops the deployment BEFORE any transaction, with a message naming the file and field.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { TOPIC_NAMES, isTopicName } from './topics.mjs';
import { ROOT } from './paths.mjs';

export class ConfigError extends Error {
  /** @param {string} file @param {string} field @param {string} problem */
  constructor(file, field, problem) {
    super(`${file}: field "${field}": ${problem}`);
    this.name = 'ConfigError';
    this.file = file;
    this.field = field;
    this.problem = problem;
  }
}

export const ROLE_IDS = Object.freeze(['operator', 'issuer', 'compliance']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function rel(file) {
  const r = path.relative(ROOT, file);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : file;
}

function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(rel(file), '(file)', `cannot read the file (${e.code ?? e.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(rel(file), '(file)', `not valid JSON (${e.message})`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function intIn(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

// ============ kit.config.json ============

export const DEFAULT_KIT_CONFIG = path.join(ROOT, 'kit.config.json');

/** Reads and validates the demo cast. Returns a normalized copy. */
export function loadKitConfig(file = DEFAULT_KIT_CONFIG) {
  const f = rel(file);
  const raw = readJson(file);
  if (!isPlainObject(raw)) throw new ConfigError(f, '(root)', 'must be a JSON object');
  if (!isPlainObject(raw.roles)) throw new ConfigError(f, 'roles', 'must be an object with operator, issuer and compliance');

  const seen = new Set();
  const claim = (id, field) => {
    if (seen.has(id)) throw new ConfigError(f, field, `duplicate cast id "${id}"`);
    seen.add(id);
  };

  const roles = {};
  for (const id of ROLE_IDS) {
    const r = raw.roles[id];
    if (!isPlainObject(r)) throw new ConfigError(f, `roles.${id}`, 'missing');
    if (typeof r.name !== 'string' || !r.name.trim()) throw new ConfigError(f, `roles.${id}.name`, 'must be a non-empty string');
    claim(id, `roles.${id}`);
    roles[id] = { id, name: r.name.trim(), description: typeof r.description === 'string' ? r.description : '' };
  }

  if (!Array.isArray(raw.attesters)) throw new ConfigError(f, 'attesters', 'must be an array');
  const attesters = raw.attesters.map((a, i) => {
    const at = `attesters[${i}]`;
    if (!isPlainObject(a)) throw new ConfigError(f, at, 'must be an object');
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw new ConfigError(f, `${at}.id`, 'must be lower-case letters, digits and dashes');
    claim(a.id, `${at}.id`);
    if (typeof a.name !== 'string' || !a.name.trim()) throw new ConfigError(f, `${at}.name`, 'must be a non-empty string');
    if (!Array.isArray(a.authorizedTopics) || a.authorizedTopics.length === 0) {
      throw new ConfigError(f, `${at}.authorizedTopics`, 'must be a non-empty array of topic names');
    }
    a.authorizedTopics.forEach((t, j) => {
      if (!isTopicName(t)) {
        throw new ConfigError(f, `${at}.authorizedTopics[${j}]`, `unknown topic "${t}". Supported: ${TOPIC_NAMES.join(', ')}`);
      }
    });
    return { id: a.id, name: a.name.trim(), authorizedTopics: [...new Set(a.authorizedTopics)] };
  });

  if (!Array.isArray(raw.investors)) throw new ConfigError(f, 'investors', 'must be an array');
  const investors = raw.investors.map((inv, i) => {
    const at = `investors[${i}]`;
    if (!isPlainObject(inv)) throw new ConfigError(f, at, 'must be an object');
    if (typeof inv.id !== 'string' || !ID_RE.test(inv.id)) throw new ConfigError(f, `${at}.id`, 'must be lower-case letters, digits and dashes');
    claim(inv.id, `${at}.id`);
    if (typeof inv.name !== 'string' || !inv.name.trim()) throw new ConfigError(f, `${at}.name`, 'must be a non-empty string');
    let credential = null;
    if (inv.credential !== null && inv.credential !== undefined) {
      credential = validateCredentialFields(inv.credential, f, `${at}.credential`);
    }
    return { id: inv.id, name: inv.name.trim(), summary: typeof inv.summary === 'string' ? inv.summary : '', credential };
  });

  const seed = validateSeed(raw.seed, f, { attesters, investors });
  return { file: f, roles, attesters, investors, seed };
}

const CREDENTIAL_FIELDS = {
  kycStatus: [0, 255],
  amlStatus: [0, 255],
  sanctionsStatus: [0, 255],
  sourceOfFundsStatus: [0, 255],
  accreditationType: [0, 255],
  countryCode: [0, 65535],
  verificationMethod: [0, 255],
};

/** Checks the Investor Eligibility fields a credential may carry. Unknown fields are refused. */
export function validateCredentialFields(c, file, field) {
  if (!isPlainObject(c)) throw new ConfigError(file, field, 'must be an object');
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'expirationTimestamp') {
      if (!(Number.isInteger(v) && v >= 0) && !(typeof v === 'string' && /^\d+$/.test(v))) {
        throw new ConfigError(file, `${field}.${k}`, 'must be a unix time in seconds (0 = never)');
      }
      out[k] = Number(v);
      continue;
    }
    if (k === 'evidenceHash') {
      if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ConfigError(file, `${field}.${k}`, 'must be a 32-byte hex string');
      out[k] = v;
      continue;
    }
    const range = CREDENTIAL_FIELDS[k];
    if (!range) throw new ConfigError(file, `${field}.${k}`, `unknown credential field. Known: ${[...Object.keys(CREDENTIAL_FIELDS), 'expirationTimestamp', 'evidenceHash'].join(', ')}`);
    if (!intIn(v, range[0], range[1])) throw new ConfigError(file, `${field}.${k}`, `must be an integer from ${range[0]} to ${range[1]}`);
    out[k] = v;
  }
  return out;
}

function validateSeed(seed, f, { attesters, investors }) {
  const empty = { authorize: [], onboard: [], issue: [] };
  if (seed === undefined || seed === null) return empty;
  if (!isPlainObject(seed)) throw new ConfigError(f, 'seed', 'must be an object');
  const attesterIds = new Set(attesters.map((a) => a.id));
  const investorIds = new Set(investors.map((i) => i.id));
  const authorize = seed.authorize ?? [];
  if (!Array.isArray(authorize)) throw new ConfigError(f, 'seed.authorize', 'must be an array of attester ids');
  authorize.forEach((a, i) => {
    if (!attesterIds.has(a)) throw new ConfigError(f, `seed.authorize[${i}]`, `unknown attester "${a}"`);
  });
  const onboard = seed.onboard ?? [];
  if (!Array.isArray(onboard)) throw new ConfigError(f, 'seed.onboard', 'must be an array');
  onboard.forEach((o, i) => {
    if (!investorIds.has(o?.investor)) throw new ConfigError(f, `seed.onboard[${i}].investor`, `unknown investor "${o?.investor}"`);
    if (!attesterIds.has(o?.provider)) throw new ConfigError(f, `seed.onboard[${i}].provider`, `unknown attester "${o?.provider}"`);
  });
  const issue = seed.issue ?? [];
  if (!Array.isArray(issue)) throw new ConfigError(f, 'seed.issue', 'must be an array');
  issue.forEach((s, i) => {
    if (typeof s?.token !== 'string' || !s.token) throw new ConfigError(f, `seed.issue[${i}].token`, 'must be a token symbol or id');
    if (!investorIds.has(s?.to)) throw new ConfigError(f, `seed.issue[${i}].to`, `unknown investor "${s?.to}"`);
    if (typeof s?.amount !== 'string' || !/^\d+(\.\d+)?$/.test(s.amount)) throw new ConfigError(f, `seed.issue[${i}].amount`, 'must be a decimal string such as "100"');
  });
  return { authorize: [...authorize], onboard: onboard.map((o) => ({ ...o })), issue: issue.map((s) => ({ ...s })) };
}

// ============ Templates ============

export const DEFAULT_TEMPLATE_DIR = path.join(ROOT, 'templates');

/** Every *.json file in the given directories, sorted by file name (then directory) for a stable deploy order. */
export function listTemplateFiles(templateDirs = [DEFAULT_TEMPLATE_DIR]) {
  const files = [];
  for (const dir of templateDirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new ConfigError(rel(dir), '(directory)', 'template directory not found');
    }
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.json')) files.push(path.join(dir, name));
    }
  }
  return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)) || a.localeCompare(b));
}

/**
 * Validates one parsed template. Throws ConfigError naming the file and the field.
 * @returns the normalized template
 */
export function validateTemplate(t, file, kit) {
  const f = rel(file);
  if (!isPlainObject(t)) throw new ConfigError(f, '(root)', 'must be a JSON object');

  if (typeof t.id !== 'string' || !t.id.trim()) throw new ConfigError(f, 'id', 'missing or empty');
  if (!ID_RE.test(t.id)) throw new ConfigError(f, 'id', `"${t.id}" must be lower-case letters, digits and dashes`);
  if (typeof t.name !== 'string' || !t.name.trim()) throw new ConfigError(f, 'name', 'missing or empty');
  if (t.symbol === undefined || t.symbol === null) throw new ConfigError(f, 'symbol', 'missing');
  if (typeof t.symbol !== 'string' || !t.symbol.trim()) throw new ConfigError(f, 'symbol', 'must be a non-empty string');
  if (/\s/.test(t.symbol.trim())) throw new ConfigError(f, 'symbol', `"${t.symbol}" must not contain spaces`);
  if (t.decimals === undefined) throw new ConfigError(f, 'decimals', 'missing (0 to 18)');
  if (!intIn(t.decimals, 0, 18)) throw new ConfigError(f, 'decimals', `${JSON.stringify(t.decimals)} is out of range: must be an integer from 0 to 18`);

  if (!Array.isArray(t.requiredTopics) || t.requiredTopics.length === 0) {
    throw new ConfigError(f, 'requiredTopics', `must be a non-empty array of topic names (${TOPIC_NAMES.join(', ')})`);
  }
  const topics = [];
  t.requiredTopics.forEach((name, i) => {
    if (!isTopicName(name)) {
      throw new ConfigError(f, `requiredTopics[${i}]`, `unknown topic "${name}". Supported: ${TOPIC_NAMES.join(', ')}`);
    }
    if (topics.includes(name)) throw new ConfigError(f, `requiredTopics[${i}]`, `topic "${name}" is listed twice`);
    topics.push(name);
  });

  if (!Array.isArray(t.trustedAttesters)) throw new ConfigError(f, 'trustedAttesters', 'must be an array of attester ids from kit.config.json');
  const attesterById = new Map(kit.attesters.map((a) => [a.id, a]));
  t.trustedAttesters.forEach((id, i) => {
    const a = attesterById.get(id);
    if (!a) {
      throw new ConfigError(f, `trustedAttesters[${i}]`, `unknown attester "${id}". Known in ${kit.file}: ${[...attesterById.keys()].join(', ') || '(none)'}`);
    }
    if (!a.authorizedTopics.some((x) => topics.includes(x))) {
      throw new ConfigError(f, `trustedAttesters[${i}]`, `attester "${id}" is not authorized for any of this template's topics (${topics.join(', ')})`);
    }
  });

  let country = null;
  if (topics.includes('COUNTRY')) {
    if (!isPlainObject(t.country)) throw new ConfigError(f, 'country', 'required because COUNTRY is in requiredTopics: { "mode": "allow" or "block", "codes": [ISO 3166-1 numeric] }');
    const mode = t.country.mode ?? 'allow';
    if (mode !== 'allow' && mode !== 'block') throw new ConfigError(f, 'country.mode', `must be "allow" or "block", not ${JSON.stringify(mode)}`);
    if (!Array.isArray(t.country.codes) || t.country.codes.length === 0) {
      throw new ConfigError(f, 'country.codes', 'required because COUNTRY is in requiredTopics: a non-empty array of ISO 3166-1 numeric codes');
    }
    t.country.codes.forEach((c, i) => {
      if (!intIn(c, 1, 999)) throw new ConfigError(f, `country.codes[${i}]`, `${JSON.stringify(c)} is not an ISO 3166-1 numeric code (1 to 999)`);
    });
    country = { mode, codes: [...new Set(t.country.codes)] };
  }

  let accreditation = null;
  if (topics.includes('ACCREDITATION')) {
    if (!isPlainObject(t.accreditation)) {
      throw new ConfigError(f, 'accreditation', 'required because ACCREDITATION is in requiredTopics: { "allowedTypes": [1 to 4] }');
    }
    if (!Array.isArray(t.accreditation.allowedTypes) || t.accreditation.allowedTypes.length === 0) {
      throw new ConfigError(f, 'accreditation.allowedTypes', 'required because ACCREDITATION is in requiredTopics: a non-empty array of accreditation types (1 retail qualified, 2 accredited, 3 qualified purchaser, 4 institutional)');
    }
    t.accreditation.allowedTypes.forEach((x, i) => {
      if (!intIn(x, 0, 4)) throw new ConfigError(f, `accreditation.allowedTypes[${i}]`, `${JSON.stringify(x)} is not an accreditation type (0 to 4)`);
    });
    accreditation = { allowedTypes: [...new Set(t.accreditation.allowedTypes)] };
  }

  const labels = { issue: 'Issue', redeem: 'Redeem' };
  if (t.labels !== undefined) {
    if (!isPlainObject(t.labels)) throw new ConfigError(f, 'labels', 'must be an object { "issue": ..., "redeem": ... }');
    for (const k of ['issue', 'redeem']) {
      if (t.labels[k] === undefined) continue;
      if (typeof t.labels[k] !== 'string' || !t.labels[k].trim()) throw new ConfigError(f, `labels.${k}`, 'must be a non-empty string');
      labels[k] = t.labels[k].trim();
    }
  }

  return {
    file: f,
    id: t.id,
    name: t.name.trim(),
    symbol: t.symbol.trim(),
    decimals: t.decimals,
    requiredTopics: topics,
    trustedAttesters: [...new Set(t.trustedAttesters)],
    country,
    accreditation,
    labels,
  };
}

/**
 * Reads and validates every template in `templateDirs`, including cross-file rules (duplicate id or symbol).
 * Never touches the chain, so deploy() can call it before sending anything.
 */
export function loadTemplates(templateDirs, kit) {
  const files = listTemplateFiles(templateDirs);
  if (files.length === 0) throw new ConfigError(templateDirs.map(rel).join(', '), '(directory)', 'no template files (*.json) found');
  const out = [];
  const byId = new Map();
  const bySymbol = new Map();
  for (const file of files) {
    const t = validateTemplate(readJson(file), file, kit);
    if (byId.has(t.id)) throw new ConfigError(t.file, 'id', `duplicate id "${t.id}" (also used by ${byId.get(t.id)})`);
    const sym = t.symbol.toLowerCase();
    if (bySymbol.has(sym)) throw new ConfigError(t.file, 'symbol', `duplicate symbol "${t.symbol}" (also used by ${bySymbol.get(sym)})`);
    byId.set(t.id, t.file);
    bySymbol.set(sym, t.file);
    out.push(t);
  }
  return out;
}
