// npm run record: plays the demo stories through the shared action library on a FRESH local chain and writes
// web/data/demo.json (and web/data/demo.js, the same data as a script, so the page also opens from a local file).
//
// Nothing in the recording is hand-written: every result, refusal reason, balance, "who may hold what" cell and
// audit-trail row is read from the contracts. The stories below only say who tries what, and what the recorder
// EXPECTS. A step whose real outcome differs from the expectation stops the recording with an error, so a contract
// change that breaks a story also breaks `npm run record` and CI.
//
// Branches: at a fork the recorder takes a chain snapshot (evm_snapshot), records the side branch, reverts
// (evm_revert) and records the branch the story continues with. Every story starts from the same live baseline.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAbi, formatUnits, parseUnits } from 'viem';
import { loadKitConfig, listTemplateFiles, DEFAULT_TEMPLATE_DIR } from './lib/config.mjs';
import { ensureBuilt } from '../core/lib/artifacts.mjs';
import { startAnvil, castIds } from './lib/network.mjs';
import { createContext, getToken, resolveParty } from './lib/context.mjs';
import { explainFor } from '../core/lib/tx.mjs';
import { ACCREDITATION_TYPES } from '../core/lib/topics.mjs';
import { ROOT } from '../core/lib/paths.mjs';
import { transferInstruction, movementInstruction, isoDate } from '../core/lib/cdm.mjs';
import * as kit from '../core/actions/index.mjs';

export const FORMAT = 1;
export const DEFAULT_OUT_DIR = path.join(ROOT, 'web', 'data');

/** Fictional names for the demo. KYC providers keep their kit ids; only the displayed name changes. */
export const DEMO_PROVIDERS = Object.freeze({
  'kyc-provider-a': { name: 'IdentiQ Services', note: 'KYC provider A: trusted at the start' },
  'kyc-provider-b': { name: 'Tallyway Verification', note: 'KYC provider B: replaces IdentiQ in one story' },
});

export const DEMO_INVESTORS = Object.freeze({
  alice: 'Treasurer of Orchard Logistics',
  bob: 'Bramble Family Office',
  carol: 'A new prospect',
  dave: 'Treasurer of a firm in country 156',
});

/** Which institution signs for which template. The recorder adds these as the template's "roles". */
export const DEMO_INSTITUTIONS = Object.freeze({
  'tokenized-deposit': { institution: 'Northvale Bank', monogram: 'NB', roles: { issuer: 'northvale-issuer', compliance: 'northvale-compliance' } },
  'money-market-fund': { institution: 'Quillon Asset Management', monogram: 'QAM', roles: { issuer: 'quillon-issuer', compliance: 'quillon-compliance' } },
  'private-credit-note': { institution: 'Saltmarsh Credit Partners', monogram: 'SCP', roles: { issuer: 'saltmarsh-issuer', compliance: 'saltmarsh-compliance' } },
  // examples/templates/interbank-deposit.json names its signers itself; listed here for display only.
  'interbank-deposit': { institution: 'Northvale Bank', monogram: 'NB', roles: { issuer: 'northvale-issuer', compliance: 'northvale-compliance' } },
});

/** The second bank of story E, and the banks' own wallets. All fictional; their LEIs are test values. */
export const DEMO_ENTITIES = Object.freeze({
  'northvale-treasury': { institution: 'Northvale Bank', monogram: 'NB' },
  'larkmoor-treasury': { institution: 'Larkmoor Bank', monogram: 'LB' },
});

/** Template directories the recording deploys: the shipped products (with roles added) and the vLEI example. */
export const EXAMPLE_TEMPLATES = path.join(ROOT, 'examples', 'templates');

/** The interface a third-party app needs to ask any ERC-7943 token. Nothing kit-specific. */
const ERC7943_ABI = parseAbi([
  'function canSend(address account) view returns (bool)',
  'function canReceive(address account) view returns (bool)',
  'function canTransfer(address from, address to, uint256 amount) view returns (bool)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);
const ERC7943_INTERFACE_ID = '0x3edbb4c4';

const ok = () => ({ ok: true });
const refused = (error, reasons) => ({ ok: false, error, reasons });

// ============ The stories ============
// A step: who acts, what they try, and what the recorder expects. Reasons: [topic, status] pairs that must all be
// among the refusal reasons. A fork: a question and options; the option with `continues` is the one the story goes on
// with, the others are side branches that the recorder plays and then rewinds.

export const SETUP = [
  { id: 'S1', actor: 'operator', action: 'authorizeProvider', params: { provider: 'kyc-provider-a' }, title: 'The operator authorizes IdentiQ Services as a KYC provider on the three tokens', expect: ok() },
  { id: 'S2', actor: 'kyc-provider-a', action: 'onboardInvestor', params: { investor: 'alice' }, title: 'IdentiQ verifies Alice: KYC verified, AML and sanctions clear, country 840, not accredited', expect: ok() },
  { id: 'S3', actor: 'kyc-provider-a', action: 'onboardInvestor', params: { investor: 'bob' }, title: 'IdentiQ verifies Bob: same as Alice, and accredited', expect: ok() },
  { id: 'S4', actor: 'kyc-provider-a', action: 'onboardInvestor', params: { investor: 'dave' }, title: 'IdentiQ verifies Dave: KYC verified, AML and sanctions clear, country 156', expect: ok() },
  { id: 'S5', actor: 'northvale-issuer', action: 'issue', params: { token: 'dDEP', to: 'dave', amount: '300' }, title: "Northvale Bank issues 300 dDEP to Dave's firm (an existing deposit)", expect: ok() },
];

export const STORIES = Object.freeze([
  {
    id: 'deposit',
    letter: 'A',
    token: 'dDEP',
    template: 'tokenized-deposit',
    title: 'Tokenized deposit',
    steps: [
      { id: 'A1', actor: 'northvale-issuer', action: 'issue', params: { token: 'dDEP', to: 'alice', amount: '1000' }, title: 'Orchard Logistics deposits cash; Northvale Bank issues 1,000 dDEP to Alice', expect: ok() },
      { id: 'A2', actor: 'alice', action: 'transfer', params: { token: 'dDEP', to: 'bob', amount: '100' }, title: 'Saturday 22:00: Alice pays Bob 100 dDEP', at: 'saturday-22', expect: ok() },
      { id: 'A3', actor: 'alice', action: 'transfer', params: { token: 'dDEP', to: 'carol', amount: '50' }, title: 'Alice tries to pay Carol 50 dDEP', expect: refused('ERC7943CannotReceive', [['KYC', 'NOT_REGISTERED']]) },
      {
        fork: {
          id: 'A3-fork',
          question: 'Carol has no credential. What happens next?',
          options: [
            { id: 'wait', label: 'Carol is not onboarded yet', chose: 'leave Carol without a credential', continues: true, steps: [] },
            {
              id: 'onboard-carol',
              label: 'What if IdentiQ onboards Carol first?',
              chose: 'IdentiQ onboards Carol first',
              steps: [
                { id: 'A3b1', actor: 'kyc-provider-a', action: 'onboardInvestor', params: { investor: 'carol', credential: { kycStatus: 1, amlStatus: 0, sanctionsStatus: 0, sourceOfFundsStatus: 1, accreditationType: 0, countryCode: 826 } }, title: 'IdentiQ verifies Carol: KYC verified, AML and sanctions clear, country 826', expect: ok() },
                { id: 'A3b2', actor: 'alice', action: 'transfer', params: { token: 'dDEP', to: 'carol', amount: '50' }, title: 'Alice pays Carol 50 dDEP again', expect: ok() },
              ],
            },
          ],
        },
      },
      { id: 'A4', actor: 'kyc-provider-a', action: 'revokeCredential', params: { investor: 'dave' }, title: "A sanctions hit: IdentiQ revokes Dave's credential", expect: ok() },
      { id: 'A5', actor: 'dave', action: 'transfer', params: { token: 'dDEP', to: 'alice', amount: '50' }, title: 'Dave tries to pay Alice 50 dDEP', expect: refused('ERC7943CannotSend', [['KYC', 'REVOKED']]) },
      { id: 'A6', actor: 'northvale-issuer', action: 'redeem', params: { token: 'dDEP', from: 'alice', amount: '200' }, title: 'Alice withdraws 200; Northvale Bank redeems 200 dDEP', expect: ok() },
    ],
  },
  {
    id: 'fund',
    letter: 'B',
    token: 'dMMF',
    template: 'money-market-fund',
    title: 'Money market fund share',
    steps: [
      { id: 'B1', actor: 'quillon-issuer', action: 'issue', params: { token: 'dMMF', to: 'alice', amount: '500' }, title: 'Subscription: Quillon issues 500 dMMF to Alice, with the credential she already has', expect: ok() },
      { id: 'B2', actor: 'quillon-issuer', action: 'issue', params: { token: 'dMMF', to: 'dave', amount: '100' }, title: 'Dave subscribes for 100 dMMF', expect: refused('ERC7943CannotReceive', [['COUNTRY', 'POLICY_REJECTED']]) },
      { id: 'B3', actor: 'alice', action: 'transfer', params: { token: 'dMMF', to: 'bob', amount: '200' }, title: 'Alice moves 200 dMMF to Bob as collateral', expect: ok() },
      {
        fork: {
          id: 'B4-fork',
          question: 'An operational incident hits the fund. How does Quillon respond?',
          options: [
            {
              id: 'pause',
              label: 'Pause the whole fund',
              chose: 'pause the whole fund',
              continues: true,
              steps: [
                { id: 'B4', actor: 'quillon-compliance', action: 'pause', params: { token: 'dMMF' }, title: 'Quillon compliance pauses dMMF', expect: ok() },
                { id: 'B5', actor: 'bob', action: 'transfer', params: { token: 'dMMF', to: 'alice', amount: '50' }, title: 'Bob tries to return 50 dMMF to Alice during the pause', expect: refused('EnforcedPause', []) },
                { id: 'B6', actor: 'quillon-compliance', action: 'forcedTransfer', params: { token: 'dMMF', from: 'bob', to: 'alice', amount: '50' }, title: 'Quillon compliance forces the 50 dMMF back to Alice while paused', expect: ok() },
                { id: 'B7', actor: 'quillon-compliance', action: 'unpause', params: { token: 'dMMF' }, title: 'Incident resolved: Quillon compliance unpauses dMMF', expect: ok() },
              ],
            },
            {
              id: 'freeze',
              label: 'What if Quillon freezes only Alice instead?',
              chose: "freeze only Alice's units",
              steps: [
                { id: 'B4b1', actor: 'quillon-compliance', action: 'freeze', params: { token: 'dMMF', account: 'alice', amount: '300' }, title: "Quillon compliance freezes all 300 of Alice's dMMF", expect: ok() },
                { id: 'B4b2', actor: 'alice', action: 'transfer', params: { token: 'dMMF', to: 'bob', amount: '10' }, title: 'Alice tries to move 10 dMMF to Bob', expect: refused('ERC7943InsufficientUnfrozenBalance', []) },
                { id: 'B4b3', actor: 'bob', action: 'transfer', params: { token: 'dMMF', to: 'alice', amount: '50' }, title: 'Bob returns 50 dMMF to Alice: everyone else keeps trading', expect: ok() },
              ],
            },
          ],
        },
      },
      { id: 'B8', actor: 'quillon-issuer', action: 'redeem', params: { token: 'dMMF', from: 'bob', amount: '150' }, title: 'Redemption: Bob redeems his 150 dMMF', expect: ok() },
    ],
  },
  {
    id: 'credit',
    letter: 'C',
    token: 'dPCN',
    template: 'private-credit-note',
    title: 'Private credit note',
    steps: [
      { id: 'C1', actor: 'saltmarsh-issuer', action: 'issue', params: { token: 'dPCN', to: 'bob', amount: '250' }, title: 'Closing: Saltmarsh issues 250 dPCN to Bob, who is accredited', expect: ok() },
      { id: 'C2', actor: 'bob', action: 'transfer', params: { token: 'dPCN', to: 'alice', amount: '50' }, title: 'Bob sells 50 dPCN to Alice', expect: refused('ERC7943CannotReceive', [['ACCREDITATION', 'POLICY_REJECTED']]) },
      {
        fork: {
          id: 'C2-fork',
          question: 'Alice is not accredited. What next?',
          options: [
            {
              id: 'accredit',
              label: 'What if Alice gets accredited?',
              chose: 'give Alice accreditation',
              continues: true,
              steps: [
                { id: 'C2b1', actor: 'kyc-provider-a', action: 'onboardInvestor', params: { investor: 'alice', credential: { accreditationType: 2 } }, title: 'IdentiQ issues Alice an updated credential with accreditation', expect: ok() },
                { id: 'C2b2', actor: 'bob', action: 'transfer', params: { token: 'dPCN', to: 'alice', amount: '50' }, title: 'Bob sells 50 dPCN to Alice again', expect: ok() },
              ],
            },
            {
              id: 'dave',
              label: 'What if Bob sells to Dave instead?',
              chose: 'Bob tries Dave instead',
              steps: [
                { id: 'C2c1', actor: 'bob', action: 'transfer', params: { token: 'dPCN', to: 'dave', amount: '50' }, title: 'Bob tries to sell 50 dPCN to Dave', expect: refused('ERC7943CannotReceive', [['ACCREDITATION', 'POLICY_REJECTED'], ['COUNTRY', 'POLICY_REJECTED']]) },
              ],
            },
          ],
        },
      },
      { id: 'C3', actor: 'saltmarsh-compliance', action: 'freeze', params: { token: 'dPCN', account: 'bob', amount: '100' }, title: "A court order: Saltmarsh compliance freezes 100 of Bob's 200 notes", expect: ok() },
      { id: 'C4', actor: 'bob', action: 'transfer', params: { token: 'dPCN', to: 'alice', amount: '150' }, title: 'Bob tries to sell 150 dPCN, more than his unfrozen balance', expect: refused('ERC7943InsufficientUnfrozenBalance', []) },
      { id: 'C5', actor: 'saltmarsh-compliance', action: 'forcedTransfer', params: { token: 'dPCN', from: 'bob', to: 'alice', amount: '200' }, title: "Judgment: Saltmarsh compliance moves all 200 of Bob's notes to Alice, frozen units included", expect: ok() },
      { id: 'C6', actor: 'operator', action: 'replaceAttester', params: { from: 'kyc-provider-a', to: 'kyc-provider-b', tokens: ['dPCN'] }, title: "Vendor change: the operator replaces IdentiQ with Tallyway on Saltmarsh's note", expect: ok() },
      { id: 'C7', actor: 'saltmarsh-issuer', action: 'redeem', params: { token: 'dPCN', from: 'alice', amount: '250' }, title: "Repayment: Saltmarsh redeems Alice's 250 dPCN", expect: ok() },
    ],
  },
  {
    id: 'dvp',
    letter: 'D',
    token: 'dMMF',
    tokens: ['dMMF', 'dDEP'],
    template: 'money-market-fund',
    chapter: 'together',
    title: 'Delivery versus payment',
    institution: 'Quillon Asset Management and Northvale Bank',
    steps: [
      { id: 'D1', actor: 'quillon-issuer', action: 'issue', params: { token: 'dMMF', to: 'bob', amount: '300' }, title: 'Bramble Family Office (Bob) holds 300 dMMF from an earlier subscription', expect: ok() },
      { id: 'D2', actor: 'northvale-issuer', action: 'issue', params: { token: 'dDEP', to: 'alice', amount: '1000' }, title: 'Orchard Logistics (Alice) holds 1,000 dDEP at Northvale Bank', expect: ok() },
      { id: 'D3', actor: 'alice', action: 'settle', params: (rec) => ({ instruction: rec.instruction('bob', 'alice', '100', '100') }), title: 'Bob sells Alice 100 dMMF for 100 dDEP: the trade arrives as a CDM instruction and settles on chain', expect: ok() },
      {
        fork: {
          id: 'D3-fork',
          question: 'Dave wants the same shares, paying with his own dDEP. What happens?',
          options: [
            { id: 'stop', label: 'Only Alice buys', chose: 'only Alice buys', continues: true, steps: [] },
            {
              id: 'dave',
              label: 'What if Dave tries the same trade?',
              chose: 'Dave tries the same trade',
              steps: [
                { id: 'D3b1', actor: 'dave', action: 'settle', params: (rec) => ({ instruction: rec.instruction('bob', 'dave', '100', '100') }), title: 'Bob sells Dave 100 dMMF for 100 dDEP', expect: refused('ERC7943CannotReceive', [['COUNTRY', 'POLICY_REJECTED']]) },
              ],
            },
          ],
        },
      },
      { id: 'D4', actor: 'bob', action: 'settle', params: (rec) => ({ instruction: rec.instruction('alice', 'bob', '40', '40') }), title: 'Later, Alice sells 40 dMMF back to Bob for 40 dDEP, settled the same way', expect: ok() },
    ],
  },
  {
    id: 'vlei',
    letter: 'E',
    token: 'dIBD',
    tokens: ['dIBD', 'dDEP'],
    parties: ['northvale-treasury', 'larkmoor-treasury', 'alice'],
    template: 'interbank-deposit',
    chapter: 'together',
    title: 'Banks recognised by vLEI',
    institution: 'Northvale Bank and Larkmoor Bank',
    steps: [
      { id: 'E1', actor: 'vlei-bridge', action: 'onboardEntity', params: { holder: 'northvale-treasury' }, title: "The vLEI bridge attests Northvale Bank's wallet: a legal-entity (LE) credential", expect: ok() },
      { id: 'E2', actor: 'vlei-bridge', action: 'onboardEntity', params: { holder: 'larkmoor-treasury' }, title: "The vLEI bridge attests Larkmoor Bank's wallet", expect: ok() },
      { id: 'E3', actor: 'northvale-issuer', action: 'issue', params: { token: 'dIBD', to: 'northvale-treasury', amount: '1000000' }, title: 'Northvale Bank funds its treasury with 1,000,000 dIBD (interbank deposit)', expect: ok() },
      { id: 'E4', actor: 'northvale-treasury', action: 'transfer', params: { token: 'dIBD', to: 'larkmoor-treasury', amount: '250000' }, title: 'Northvale Bank pays Larkmoor Bank 250,000 dIBD', expect: ok() },
      { id: 'E5', actor: 'larkmoor-treasury', action: 'transfer', params: { token: 'dIBD', to: 'alice', amount: '1000' }, title: 'Larkmoor Bank tries to pay 1,000 dIBD to Alice, a corporate client without a vLEI credential', expect: refused('ERC7943CannotReceive', [['VLEI_LEGAL_ENTITY', 'NOT_REGISTERED']]) },
      {
        fork: {
          id: 'E5-fork',
          question: "Larkmoor Bank's vLEI credential is live. What if it stops being valid?",
          options: [
            { id: 'live', label: 'The credential stays live', chose: 'the credential stays live', continues: true, steps: [] },
            {
              id: 'revoke',
              label: "What if Larkmoor's vLEI credential is revoked?",
              chose: "Larkmoor's credential is revoked",
              steps: [
                { id: 'E5b1', actor: 'vlei-bridge', action: 'revokeEntity', params: { holder: 'larkmoor-treasury' }, title: "The bridge revokes Larkmoor Bank's vLEI attestation (for example, its LEI lapsed)", expect: ok() },
                { id: 'E5b2', actor: 'northvale-treasury', action: 'transfer', params: { token: 'dIBD', to: 'larkmoor-treasury', amount: '10000' }, title: 'Northvale Bank tries to pay Larkmoor Bank 10,000 dIBD', expect: refused('ERC7943CannotReceive', [['VLEI_LEGAL_ENTITY', 'REVOKED']]) },
              ],
            },
          ],
        },
      },
      { id: 'E6', actor: 'larkmoor-treasury', action: 'transfer', params: { token: 'dIBD', to: 'northvale-treasury', amount: '50000' }, title: 'Larkmoor Bank returns 50,000 dIBD to Northvale Bank', expect: ok() },
    ],
  },
]);

// ============ Recording ============

export class RecordingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordingError';
  }
}

export function gitCommit() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const sha = git('rev-parse', 'HEAD');
    // Local changes outside the recording itself make the provenance line say so.
    const dirty = git('status', '--porcelain', '--untracked-files=no', '--', '.', ':!web/data').length > 0;
    return { sha, short: sha.slice(0, 7), dirty, date: git('show', '-s', '--format=%cI', 'HEAD') };
  } catch {
    return { sha: null, short: null, dirty: true, date: null };
  }
}

/** Copies the shipped templates into a temp dir, adding the demo institutions as each template's "roles". */
export function demoTemplates(dir) {
  const out = [];
  for (const file of listTemplateFiles([DEFAULT_TEMPLATE_DIR])) {
    const t = JSON.parse(readFileSync(file, 'utf8'));
    const inst = DEMO_INSTITUTIONS[t.id];
    if (inst) t.roles = { ...inst.roles };
    writeFileSync(path.join(dir, path.basename(file)), `${JSON.stringify(t, null, 2)}\n`);
    out.push({ file: path.relative(ROOT, file), template: t });
  }
  return out;
}

/** Next Saturday 22:00 UTC strictly after `ts` (unix seconds). */
export function nextSaturday22(ts) {
  const d = new Date(ts * 1000);
  d.setUTCHours(22, 0, 0, 0);
  const add = (6 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  if (d.getTime() / 1000 <= ts) d.setUTCDate(d.getUTCDate() + 7);
  return Math.floor(d.getTime() / 1000);
}

function collectTxs(r) {
  const out = [];
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/txHash$/i.test(k) && typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x)) out.push(x);
        else visit(x);
      }
    }
  };
  visit(r);
  return [...new Set(out)];
}

const TOKEN_ACTIONS = new Set(['issue', 'transfer', 'redeem', 'forcedTransfer']);
const CONTROL_ACTIONS = new Set(['freeze', 'pause', 'unpause']);
const STOPPED_AT_TOKEN = new Set([
  'EnforcedPause',
  'ExpectedPause',
  'ERC7943InsufficientUnfrozenBalance',
  'ERC20InsufficientBalance',
  'AccessControlUnauthorizedAccount',
]);

export class Recorder {
  constructor(ctx, names) {
    this.ctx = ctx;
    this.names = names;
  }

  rpc(method, params = []) {
    return this.ctx.publicClient.request({ method, params });
  }

  async snapshot() {
    return this.rpc('evm_snapshot');
  }

  async revert(id) {
    const done = await this.rpc('evm_revert', [id]);
    if (!done) throw new RecordingError(`evm_revert ${id} failed`);
    this.ctx._audit = null; // the audit cache holds blocks that no longer exist
  }

  async latest() {
    return this.ctx.publicClient.getBlock({ blockTag: 'latest' });
  }

  name(id) {
    return this.names[id] ?? id;
  }

  /** The eligibility checks a token operation runs: who is checked, and every topic's status for them. */
  async checks(spec, params) {
    if (spec.action === 'settle') {
      // Each leg's token checks its own sender and recipient.
      const out = [];
      for (const l of this.legsOf(params.instruction)) {
        const t = getToken(this.ctx, l.symbol);
        for (const [role, addr] of [[`sends ${l.symbol}`, l.from], [`receives ${l.symbol}`, l.to]]) {
          const p = resolveParty(this.ctx, addr);
          const topics = await explainFor(this.ctx, t, p.address);
          out.push({ role, party: p.id, token: l.symbol, eligible: topics.every((x) => x.status === 'OK'), topics });
        }
      }
      return out;
    }
    if (!TOKEN_ACTIONS.has(spec.action)) return [];
    const t = getToken(this.ctx, params.token);
    const parties = [];
    if (spec.action === 'transfer') parties.push(['sender', spec.actor], ['recipient', params.to]);
    if (spec.action === 'issue' || spec.action === 'forcedTransfer') parties.push(['recipient', params.to]);
    const out = [];
    for (const [role, ref] of parties) {
      const p = resolveParty(this.ctx, ref);
      const topics = await explainFor(this.ctx, t, p.address);
      out.push({ role, party: p.id, token: t.symbol, eligible: topics.every((x) => x.status === 'OK'), topics });
    }
    return out;
  }

  /** A CDM TransferInstruction (Instructed) for "seller sells `shares` dMMF to buyer for `price` dDEP". */
  instruction(seller, buyer, shares, price) {
    const { ctx } = this;
    const t = (sym) => getToken(ctx, sym);
    const a = (id) => ctx.actors[id].address;
    return transferInstruction(
      ctx,
      [
        { token: t('dMMF'), from: a(seller), to: a(buyer), amountRaw: parseUnits(shares, t('dMMF').decimals) },
        { token: t('dDEP'), from: a(buyer), to: a(seller), amountRaw: parseUnits(price, t('dDEP').decimals) },
      ],
      { date: this.today, status: 'Instructed' },
    );
  }

  legsOf(instruction) {
    return instruction.transferState.map((s) => {
      const u = s.transfer.UnscheduledTransfer;
      const sym = u.asset.DigitalAsset.identifier.find((x) => x.identifierType === 'Name').identifier['@data'];
      return { symbol: sym, from: u.payerReceiver.payerPartyReference.partyId[0].identifier['@data'], to: u.payerReceiver.receiverPartyReference.partyId[0].identifier['@data'] };
    });
  }

  /** Story F: the CDM view of a step. Settlement: the instruction in and the settled answer out; movements: one leg. */
  cdmFor(spec, params, r, block) {
    const { ctx } = this;
    if (spec.action === 'settle') return { in: params.instruction, out: r.cdm?.settled ?? null };
    if (!r.ok || !TOKEN_ACTIONS.has(spec.action)) return null;
    const t = getToken(ctx, params.token);
    const a = (ref) => resolveParty(ctx, ref).address;
    const issuer = ctx.actors[spec.actor].address;
    const ends = {
      issue: () => [issuer, a(params.to)],
      transfer: () => [ctx.actors[spec.actor].address, a(params.to)],
      redeem: () => [a(params.from), issuer],
      forcedTransfer: () => [a(params.from), a(params.to)],
    }[spec.action]();
    return {
      in: null,
      out: movementInstruction(ctx, { token: t, from: ends[0], to: ends[1], amountRaw: parseUnits(String(params.amount), t.decimals), txHash: r.txHash, date: isoDate(block.timestamp) }),
    };
  }

  /** The state the page shows after a step: tokens, who may hold what, balances. All read from the chain. */
  async state() {
    const s = await kit.getState(this.ctx, { audit: false });
    return {
      tokens: Object.fromEntries(
        s.tokens.map((t) => [
          t.symbol,
          { totalSupply: t.totalSupply, paused: t.paused, trustedAttesters: t.trustedAttesters.map((a) => a.id ?? a.address) },
        ]),
      ),
      matrix: Object.fromEntries(
        Object.entries(s.matrix).map(([inv, row]) => [
          inv,
          Object.fromEntries(Object.entries(row).map(([sym, c]) => [sym, { eligible: c.eligible, reasons: c.reasons.map((r) => ({ topic: r.topic, status: r.status, text: r.text })) }])),
        ]),
      ),
      balances: Object.fromEntries(
        Object.entries(s.balances).map(([inv, row]) => [inv, Object.fromEntries(Object.entries(row).map(([sym, b]) => [sym, { balance: b.balance, frozen: b.frozen }]))]),
      ),
    };
  }

  /** Runs one step through the action library, checks it against its expectation and records everything shown. */
  async step(spec, path) {
    const { ctx } = this;
    if (spec.at === 'saturday-22') {
      const ts = nextSaturday22(Number((await this.latest()).timestamp));
      await this.rpc('evm_setNextBlockTimestamp', [ts]);
    }
    const before = Number((await this.latest()).number);
    const params = typeof spec.params === 'function' ? spec.params(this) : spec.params;
    const r = await kit.runAction(ctx, { action: spec.action, actor: spec.actor, params });

    // The recorder is a test: the real outcome must match what the story expects.
    const where = `${path} ${spec.id} (${spec.title})`;
    if (r.ok !== spec.expect.ok) {
      throw new RecordingError(`${where}: expected ${spec.expect.ok ? 'success' : `refusal ${spec.expect.error}`}, got ${r.ok ? 'success' : `${r.error}: ${r.message}`}`);
    }
    if (!r.ok) {
      if (r.error !== spec.expect.error) throw new RecordingError(`${where}: expected ${spec.expect.error}, got ${r.error}: ${r.message}`);
      for (const [topic, status] of spec.expect.reasons) {
        if (!r.reasons.some((x) => x.topic === topic && x.status === status)) {
          throw new RecordingError(`${where}: expected reason ${topic} ${status}, got [${r.reasons.map((x) => x.text).join(', ')}]`);
        }
      }
    }

    const block = await this.latest();
    const audit = (await kit.auditTrail(ctx)).filter((e) => e.block > before);
    const result = { ok: r.ok, message: r.message ?? null };
    if (!r.ok) Object.assign(result, { error: r.error, reasons: r.reasons.map((x) => ({ topic: x.topic, status: x.status, text: x.text })), role: r.role ?? null });
    if (spec.action === 'replaceAttester' && r.ok) {
      result.eligibility = r.eligibility;
      result.reattested = r.reattested.map((x) => x.investor);
      result.removedFrom = r.removed.map((x) => x.token);
    }
    if (spec.action === 'settle') {
      result.trade = { tradeId: r.tradeId ?? null, ref: r.ref ?? null, stage: r.stage ?? null, steps: r.steps ?? [], refusedOn: r.token ?? null };
    }
    if (spec.action === 'onboardEntity' && r.ok) {
      result.entity = { legalName: r.credential.legalName, lei: r.credential.lei, credType: r.credential.credType, expiresAt: r.credential.expiresAt };
      result.registrations = r.registrations.map((x) => x.token);
    }
    if (spec.action === 'onboardInvestor' && r.ok) {
      const c = r.credential;
      result.credential = {
        kycStatus: c.kycStatus,
        amlStatus: c.amlStatus,
        sanctionsStatus: c.sanctionsStatus,
        countryCode: c.countryCode,
        accreditation: ACCREDITATION_TYPES[c.accreditationType] ?? String(c.accreditationType),
      };
      result.registrations = r.registrations.map((x) => `${x.token}:${x.topic}`);
    }

    const kind =
      spec.action === 'settle' ? 'settlement' : TOKEN_ACTIONS.has(spec.action) ? 'token' : CONTROL_ACTIONS.has(spec.action) ? 'control' : 'credential';
    let stoppedAt = null;
    if (!r.ok) stoppedAt = r.reasons.length ? 'eligibility' : STOPPED_AT_TOKEN.has(r.error) ? 'token' : 'actor';
    return {
      id: spec.id,
      actor: spec.actor,
      action: spec.action,
      params,
      title: spec.title,
      kind,
      token: params.token ?? (spec.action === 'settle' ? (r.token ?? r.delivery?.token ?? null) : null),
      tokens: spec.action === 'settle' ? this.legsOf(params.instruction).map((l) => l.symbol) : params.token ? [params.token] : [],
      expected: spec.expect.ok ? 'accepted' : 'refused',
      result,
      asExpected: true,
      stoppedAt,
      checks: await this.checks(spec, params),
      cdm: this.cdmFor(spec, params, r, block),
      txs: collectTxs(r),
      block: Number(block.number),
      time: new Date(Number(block.timestamp) * 1000).toISOString(),
      state: await this.state(),
      audit: audit.map(({ logIndex, ...e }) => e),
    };
  }

  /** Records a list of steps and forks. Side branches are rewound; the continuing branch is kept. */
  async steps(list, path, log) {
    const out = [];
    for (const item of list) {
      if (!item.fork) {
        const s = await this.step(item, path);
        log(`  ${s.id} ${s.result.ok ? 'accepted' : `refused (${s.result.reasons?.map((x) => x.text).join(', ') || s.result.error})`}: ${s.title}`);
        out.push(s);
        continue;
      }
      const f = item.fork;
      const options = [];
      const sides = f.options.filter((o) => !o.continues);
      const main = f.options.filter((o) => o.continues);
      if (main.length !== 1) throw new RecordingError(`${path} ${f.id}: exactly one option must continue the story`);
      for (const o of sides) {
        const snap = await this.snapshot();
        log(`  fork ${f.id}: side branch "${o.label}"`);
        const steps = await this.steps(o.steps, `${path} ${f.id}/${o.id}`, log);
        await this.revert(snap);
        options.push({ id: o.id, label: o.label, chose: o.chose, continues: false, steps });
      }
      log(`  fork ${f.id}: story continues with "${main[0].label}"`);
      const steps = await this.steps(main[0].steps, `${path} ${f.id}/${main[0].id}`, log);
      options.push({ id: main[0].id, label: main[0].label, chose: main[0].chose, continues: true, steps });
      // Keep the options in the order the story lists them.
      options.sort((a, b) => f.options.findIndex((o) => o.id === a.id) - f.options.findIndex((o) => o.id === b.id));
      out.push({ fork: { id: f.id, question: f.question, options } });
    }
    return out;
  }

  /** The same three ERC-7943 questions, asked by an app that only knows the standard, of all three tokens. */
  async interop(log) {
    const { ctx } = this;
    const snap = await this.snapshot();
    const setup = [];
    for (const t of ctx.deployment.tokens) {
      const inst = DEMO_INSTITUTIONS[t.id];
      if (!inst || t.eligibilitySource === 'vlei') continue; // Bob is an investor, not a vLEI-recognised bank
      setup.push(
        await this.step(
          { id: `I-${t.symbol}`, actor: inst.roles.issuer, action: 'issue', params: { token: t.symbol, to: 'bob', amount: '100' }, title: `${inst.institution} issues 100 ${t.symbol} to Bob`, expect: ok() },
          'interop',
        ),
      );
    }
    const investors = ctx.kit.investors.map((i) => i.id);
    const tokens = [];
    for (const t of ctx.deployment.tokens) {
      const read = (functionName, args) => ctx.publicClient.readContract({ address: t.address, abi: ERC7943_ABI, functionName, args });
      const supports = await read('supportsInterface', [ERC7943_INTERFACE_ID]);
      const parties = {};
      for (const id of investors) {
        const a = ctx.actors[id].address;
        parties[id] = { canSend: await read('canSend', [a]), canReceive: await read('canReceive', [a]) };
      }
      const transfers = {};
      for (const to of investors.filter((x) => x !== 'bob')) {
        transfers[`bob->${to}`] = await read('canTransfer', [ctx.actors.bob.address, ctx.actors[to].address, 10n ** BigInt(t.decimals) * 10n]);
      }
      tokens.push({ symbol: t.symbol, address: t.address, supportsErc7943: supports, parties, transfers, transferAmount: formatUnits(10n ** BigInt(t.decimals) * 10n, t.decimals) });
    }
    log(`  interop: asked ${tokens.length} tokens canSend, canReceive and canTransfer through the ERC-7943 interface only`);
    await this.revert(snap);
    return { interfaceId: ERC7943_INTERFACE_ID, functions: ['canSend(address)', 'canReceive(address)', 'canTransfer(address,address,uint256)'], setup, tokens };
  }
}

/**
 * Records every story on a fresh local chain. `stories` defaults to STORIES (tests pass others).
 * @returns {Promise<object>} the recording (also written to outDir unless outDir is false)
 */
export async function record({ outDir = DEFAULT_OUT_DIR, log = console.log, progress = () => {}, stories: storyList = STORIES } = {}) {
  ensureBuilt({ log: progress });
  const castKit = loadKitConfig();
  // The demo shows fictional provider names; the authorization attestations carry these names on chain.
  const demoKit = { ...castKit, attesters: castKit.attesters.map((a) => ({ ...a, name: DEMO_PROVIDERS[a.id]?.name ?? a.name })) };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'eea-kit-record-'));
  let anvil = null;
  try {
    const templates = [
      ...demoTemplates(tmp),
      ...listTemplateFiles([EXAMPLE_TEMPLATES]).map((f) => ({ file: path.relative(ROOT, f), template: JSON.parse(readFileSync(f, 'utf8')) })),
    ];
    anvil = await startAnvil({ accounts: castIds(demoKit).length, log: progress });
    const ctx = await createContext({ env: {}, rpcUrl: anvil.url, kit: demoKit, loadDeployment: false, deploymentFile: path.join(tmp, 'local.json') });
    log(`Deploying ${templates.length} templates to a fresh local chain`);
    await kit.deploy(ctx, { templateDirs: [tmp, EXAMPLE_TEMPLATES], outFile: false });

    const names = Object.fromEntries(Object.values(ctx.actors).map((a) => [a.id, a.name]));
    const rec = new Recorder(ctx, names);
    rec.today = isoDate((await rec.latest()).timestamp);

    log('Setup: the three products go live');
    const setup = await rec.steps(SETUP, 'setup', log);
    const baseline = { state: await rec.state(), audit: (await kit.auditTrail(ctx)).map(({ logIndex, ...e }) => e) };

    const stories = [];
    for (const story of storyList) {
      log(`Story ${story.letter}: ${story.title}`);
      const snap = await rec.snapshot();
      const steps = await rec.steps(story.steps, `story ${story.letter}`, log);
      await rec.revert(snap);
      const t = ctx.deployment.tokens.find((x) => x.symbol === story.token);
      stories.push({
        id: story.id,
        letter: story.letter,
        title: story.title,
        chapter: story.chapter ?? 'instruments',
        token: story.token,
        tokens: story.tokens ?? ['dDEP', 'dMMF', 'dPCN'],
        parties: story.parties ?? castKit.investors.map((i) => i.id),
        institution: story.institution ?? DEMO_INSTITUTIONS[t.id]?.institution ?? null,
        steps,
      });
    }
    log('Interoperability');
    const interop = await rec.interop(log);

    const d = ctx.deployment;
    const recording = {
      format: FORMAT,
      kit: 'eea-tokenization-starter-kit',
      recordedAt: new Date().toISOString(),
      commit: gitCommit(),
      network: ctx.network,
      chainId: ctx.chainId,
      explorer: ctx.explorer,
      contracts: { eas: d.shared.eas, schemaRegistry: d.shared.schemaRegistry, trustedIssuerResolver: d.shared.resolver, identityProxy: d.shared.identityProxy },
      cast: {
        operator: { id: 'operator', name: names.operator },
        providers: castKit.attesters.map((a) => ({ id: a.id, name: names[a.id], note: DEMO_PROVIDERS[a.id]?.note ?? '', address: ctx.actors[a.id].address })),
        investors: castKit.investors.map((i) => ({ id: i.id, name: i.name, who: DEMO_INVESTORS[i.id] ?? '', summary: i.summary, address: ctx.actors[i.id].address })),
        entities: (castKit.vlei?.holders ?? []).map((h) => ({
          id: h.wallet,
          name: names[h.wallet],
          institution: DEMO_ENTITIES[h.wallet]?.institution ?? h.legalName,
          monogram: DEMO_ENTITIES[h.wallet]?.monogram ?? null,
          credType: h.credType,
          lei: h.lei,
          testOnly: true,
          address: ctx.actors[h.wallet].address,
        })),
        bridge: castKit.vlei ? { id: castKit.vlei.bridge.id, name: names[castKit.vlei.bridge.id], address: ctx.actors[castKit.vlei.bridge.id].address } : null,
        institutions: [...new Map(Object.values(DEMO_INSTITUTIONS).map((x) => [x.institution, x])).values()].map((x) => ({
          name: x.institution,
          monogram: x.monogram,
          signers: Object.fromEntries(Object.entries(x.roles).map(([role, id]) => [role, { id, name: names[id], address: ctx.actors[id].address }])),
        })),
        names,
      },
      tokens: d.tokens.map((t) => {
        const tpl = templates.find((x) => x.template.id === t.id);
        return {
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          institution: DEMO_INSTITUTIONS[t.id]?.institution ?? null,
          monogram: DEMO_INSTITUTIONS[t.id]?.monogram ?? null,
          requiredTopics: t.topics,
          country: t.country,
          accreditation: t.accreditation,
          labels: t.labels,
          roles: t.roles,
          eligibilitySource: t.eligibilitySource ?? 'shibui',
          vlei: t.vlei ?? null,
          templateFile: tpl?.file ?? null,
          template: tpl?.template ?? null,
        };
      }),
      setup,
      baseline,
      stories,
      interop,
    };
    if (outDir) writeRecording(recording, outDir);
    return recording;
  } finally {
    await anvil?.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function writeRecording(recording, outDir = DEFAULT_OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(recording, null, 2);
  writeFileSync(path.join(outDir, 'demo.json'), `${json}\n`);
  // The same data as a script, so web/index.html also works when opened from a local file (no fetch needed).
  writeFileSync(path.join(outDir, 'demo.js'), `// Generated by npm run record. Do not edit.\nwindow.DEMO_RECORDING = ${json};\n`);
  // Story F's CDM objects on their own, for tools/cdm/validate.py (CI validates them with finos-cdm).
  writeFileSync(path.join(outDir, 'cdm.json'), `${JSON.stringify({ cdmVersion: '7.10.0', objects: cdmObjects(recording) }, null, 2)}\n`);
}

/** Every CDM object of a recording (story F), as {name, object}, for tools/cdm/validate.py. */
export function cdmObjects(recording) {
  const out = [];
  for (const s of allSteps(recording)) {
    if (s.cdm?.in) out.push({ name: `${s.id}-in`, object: s.cdm.in });
    if (s.cdm?.out) out.push({ name: `${s.id}-out`, object: s.cdm.out });
  }
  return out;
}

/** Every step in a recording, side branches included, in order. */
export function allSteps(recording) {
  const out = [...recording.setup];
  const walk = (list) => {
    for (const item of list) {
      if (item.fork) item.fork.options.forEach((o) => walk(o.steps));
      else out.push(item);
    }
  };
  recording.stories.forEach((s) => walk(s.steps));
  out.push(...recording.interop.setup);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const outDir = i >= 0 ? path.resolve(args[i + 1]) : DEFAULT_OUT_DIR;
  const t0 = Date.now();
  try {
    const r = await record({ outDir, progress: (m) => console.error(m) });
    const n = allSteps(r).length;
    console.log(`Recorded ${n} steps from commit ${r.commit.short ?? '(unknown)'}${r.commit.dirty ? ' with local changes' : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(ROOT, outDir) || '.'}/demo.json`);
  } catch (e) {
    console.error(`\nnpm run record failed: ${e instanceof RecordingError ? e.message : e.stack ?? e.message}`);
    process.exit(1);
  }
}
