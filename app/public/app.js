// EEA Tokenization Starter Kit: the web console (build plan 3.7). One static page, no build step, no framework,
// no external CDN. The browser never holds a key (decision D7): it reads GET /api/state and asks the server to
// act as the cast member chosen in "Act as" through POST /api/actions.
//
// This file is an ES module. Its pure parts (the guided story, the wording of results, the API client) are
// exported so the Node tests run the same story against a real server. The page wiring (boot) runs only in a
// browser. Everything shown comes from the server and is inserted as text, never as HTML.

const DEP = 'dDEP';
const MMF = 'dMMF';
const PCN = 'dPCN';
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// ============ Formatting (pure) ============

/** Block explorer link for a transaction, or null when the network has no explorer (the local chain). */
export function txUrl(explorer, hash) {
  if (!explorer || !HASH_RE.test(String(hash ?? ''))) return null;
  return `${String(explorer).replace(/\/+$/, '')}/tx/${hash}`;
}

export function addressUrl(explorer, address) {
  if (!explorer || !/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) return null;
  return `${String(explorer).replace(/\/+$/, '')}/address/${address}`;
}

export function shortHash(h) {
  const s = String(h ?? '');
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

/** "1000.5" -> "1,000.5" (amounts arrive as decimal strings in token units). */
export function groupDigits(value) {
  const s = String(value ?? '');
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s;
  return `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] ?? ''}`;
}

/** "accreditation: policy rejected" -> "accreditation" */
function reasonWord(r) {
  const t = String(r?.text ?? '');
  const i = t.indexOf(':');
  return i > 0 ? t.slice(0, i) : String(r?.topic ?? '').toLowerCase();
}

/**
 * One cell of "who may hold what", in words: never colour alone.
 * @returns {{eligible: boolean, text: string, detail: string}} text is "yes" or e.g. "no: accreditation, country"
 */
export function cellSummary(cell) {
  if (!cell) return { eligible: false, text: 'unknown', detail: '' };
  if (cell.eligible) return { eligible: true, text: 'yes', detail: '' };
  const reasons = cell.reasons ?? [];
  if (!reasons.length) return { eligible: false, text: 'no', detail: 'not eligible (no topic reported)' };
  return {
    eligible: false,
    text: `no: ${[...new Set(reasons.map(reasonWord))].join(', ')}`,
    detail: reasons.map((r) => r.text).join('; '),
  };
}

const ACTION_LABELS = Object.freeze({
  issue: 'Issue',
  transfer: 'Transfer',
  redeem: 'Redeem',
  freeze: 'Freeze',
  forcedTransfer: 'Forced transfer',
  pause: 'Pause',
  unpause: 'Unpause',
  onboardInvestor: 'Onboard investor',
  revokeCredential: 'Revoke credential',
  authorizeProvider: 'Authorize KYC provider',
  replaceAttester: 'Replace attester',
});

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? String(action ?? 'action');
}

function txLabel(key, obj, parent, action) {
  const on = obj?.token ? ` on ${obj.token}` : '';
  if (key === 'watchTxHash') return `let the explanation watch the provider${on}`;
  switch (parent) {
    case 'trusted':
      return `trust the provider${on}`;
    case 'registrations':
      return `register ${obj.topic ?? 'a topic'}${on}`;
    case 'removed':
      return `remove the provider${on}`;
    case 'reattested':
      return `re-attest ${obj.investor}`;
    case 'revoked':
      return 'revoke the credential';
    case 'authorization':
      return 'authorize the new provider';
    default:
      if (action === 'onboardInvestor') return 'issue the credential on EAS';
      if (action === 'authorizeProvider') return 'authorize the provider on EAS';
      if (action === 'replaceAttester') return 'authorize the new provider';
      return actionLabel(action).toLowerCase();
  }
}

/** Every transaction hash in an action result, with what it did. */
export function collectTxHashes(result) {
  const out = [];
  const seen = new Set();
  const visit = (v, parent) => {
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, parent));
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'txHash' || k === 'watchTxHash') && typeof x === 'string' && HASH_RE.test(x)) {
        if (!seen.has(x)) {
          seen.add(x);
          out.push({ hash: x, label: txLabel(k, v, parent, result?.action) });
        }
      } else if (x && typeof x === 'object' && k !== 'eligibility' && k !== 'credential' && k !== 'args') {
        visit(x, k);
      }
    }
  };
  visit(result, 'result');
  return out;
}

function okSentence(r, n) {
  const list = (xs) => (xs.length ? xs.join(', ') : 'none');
  switch (r.action) {
    case 'issue':
      return `${n(r.actor)} issued ${groupDigits(r.amount)} ${r.token} to ${n(r.to)}`;
    case 'transfer':
      return `${n(r.from ?? r.actor)} sent ${groupDigits(r.amount)} ${r.token} to ${n(r.to)}`;
    case 'redeem':
      return `${n(r.actor)} redeemed ${groupDigits(r.amount)} ${r.token} from ${n(r.from)}`;
    case 'freeze':
      return `${n(r.actor)} set the frozen ${r.token} of ${n(r.account)} to ${groupDigits(r.frozen)}`;
    case 'forcedTransfer':
      return `${n(r.actor)} moved ${groupDigits(r.amount)} ${r.token} from ${n(r.from)} to ${n(r.to)} (forced transfer)`;
    case 'pause':
      return `${n(r.actor)} paused ${r.token}`;
    case 'unpause':
      return `${n(r.actor)} unpaused ${r.token}`;
    case 'authorizeProvider': {
      const skipped = (r.skipped ?? []).map((s) => `${s.token} (${s.reason})`);
      return `${n(r.actor)} authorized ${n(r.provider)} for ${list(r.topics ?? [])}; trusted on ${list((r.trusted ?? []).map((t) => t.token))}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`;
    }
    case 'onboardInvestor': {
      const tokens = [...new Set((r.registrations ?? []).map((x) => x.token))];
      return `${n(r.actor)} issued one credential to ${n(r.investor)} and registered it ${(r.registrations ?? []).length} times (${list(tokens)})`;
    }
    case 'revokeCredential':
      return `${n(r.actor)} revoked the credential of ${n(r.investor)}`;
    case 'replaceAttester':
      return `${n(r.actor)} replaced ${n(r.from)} with ${n(r.to)} on ${list(r.tokens ?? [])}; re-attested ${list((r.reattested ?? []).map((x) => n(x.investor)))}`;
    default:
      return actionLabel(r.action);
  }
}

/**
 * An action result in words.
 * @returns {{kind: 'ok'|'refused'|'invalid'|'error', label: string, text: string, code: string|null,
 *   reasons: Array<{topic, topicId, status, text}>, role: string|null, txs: Array<{hash, label}>}}
 */
export function describeResult(r, nameOf = (x) => x) {
  const n = (x) => (x === undefined || x === null ? 'someone' : nameOf(x));
  if (!r || typeof r !== 'object') return { kind: 'error', label: 'Error', text: 'no answer from the server', code: null, reasons: [], role: null, txs: [] };
  if (r.ok) return { kind: 'ok', label: 'Accepted', text: okSentence(r, n), code: null, reasons: [], role: null, txs: collectTxHashes(r) };
  // Library messages start with "Refused: " or "Refused by EAS: "; the label already says "Refused".
  const text = String(r.message ?? r.error ?? 'refused')
    .replace(/^Refused by EAS:\s*([\s\S]*)$/, '$1 (EAS)')
    .replace(/^Refused:\s*/, '');
  if (r.error === 'BadRequest' || r.error === 'UnknownAction' || r.error === 'UnsupportedMediaType' || r.error === 'PayloadTooLarge') {
    return { kind: 'invalid', label: 'Not sent', text, code: r.error, reasons: [], role: null, txs: [] };
  }
  if (r.error === 'ServerError' || r.error === 'NotDeployed' || r.error === 'BadResponse') {
    return { kind: 'error', label: 'Error', text, code: r.error, reasons: [], role: null, txs: collectTxHashes(r) };
  }
  return { kind: 'refused', label: 'Refused', text, code: r.error ?? null, reasons: Array.isArray(r.reasons) ? r.reasons : [], role: r.role ?? null, txs: collectTxHashes(r) };
}

// ============ API client ============

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The three calls the console makes. `base` is '' in the browser and the server URL in the Node tests. */
export function createApi({ base = '', fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const parse = async (res) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: 'BadResponse', message: `unexpected answer (HTTP ${res.status}): ${text.slice(0, 200)}` };
    }
  };
  const get = async (p) => {
    const res = await fetchImpl(`${base}${p}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    const body = await parse(res);
    if (!res.ok) throw new ApiError(body.message ?? `HTTP ${res.status}`, res.status);
    return body;
  };
  return {
    state: () => get('/api/state'),
    templates: () => get('/api/templates'),
    async act(action, actor, params = {}) {
      const res = await fetchImpl(`${base}/api/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action, actor: actor ?? undefined, params }),
      });
      const body = await parse(res);
      if (body && typeof body === 'object') Object.defineProperty(body, 'httpStatus', { value: res.status, enumerable: false });
      return body;
    },
  };
}

// ============ Guided story ============

function token(state, symbol) {
  return state.tokens.find((t) => t.symbol === symbol);
}

function bal(state, investor, symbol) {
  return Number(state.balances?.[investor]?.[symbol]?.balance ?? Number.NaN);
}

/**
 * The guided story: seven steps over the seeded demo (npm start). Each step says who acts, what should happen
 * ("Expected"), runs through the same API as the forms and then checks what really happened.
 */
export const STORY = Object.freeze([
  {
    n: 1,
    key: 'issue',
    title: 'Issue',
    who: 'Issuer',
    needs: [PCN],
    text: 'The issuer issues 250 dPCN, the private credit note, to Bob at closing. Bob is accredited, so the note accepts him.',
    expected: 'Accepted. Bob’s dPCN balance rises by 250 and the audit trail shows the closing.',
    async run(s) {
      const before = bal(s.before, 'bob', PCN);
      const r = await s.act('issuer', 'issue', { token: PCN, to: 'bob', amount: '250' }, 'Issuer issues 250 dPCN to Bob');
      s.accepted(r, 'Issue 250 dPCN to Bob');
      const after = await s.state();
      const now = bal(after, 'bob', PCN);
      s.check(now === before + 250, `Bob’s dPCN balance went from ${groupDigits(before)} to ${groupDigits(now)}`);
      const label = token(after, PCN)?.labels?.issue ?? 'Issue';
      const entry = after.auditTrail.find((e) => r.ok && e.txHash === r.txHash && e.action === 'Issued');
      s.check(entry, entry ? `the audit trail shows "${entry.detail}"` : `the audit trail lacks the ${label.toLowerCase()}`);
    },
  },
  {
    n: 2,
    key: 'transfer',
    title: 'Transfer',
    who: 'Alice',
    needs: [DEP],
    text: 'Alice sends 100 dDEP to Bob. Both hold a KYC credential with sanctions clear, so the deposit lets them transact.',
    expected: 'Accepted. Alice’s dDEP balance falls by 100 and Bob’s rises by 100.',
    async run(s) {
      const a0 = bal(s.before, 'alice', DEP);
      const b0 = bal(s.before, 'bob', DEP);
      const r = await s.act('alice', 'transfer', { token: DEP, to: 'bob', amount: '100' }, 'Alice sends 100 dDEP to Bob');
      s.accepted(r, 'Transfer 100 dDEP from Alice to Bob');
      const after = await s.state();
      const a1 = bal(after, 'alice', DEP);
      const b1 = bal(after, 'bob', DEP);
      s.check(a1 === a0 - 100, `Alice’s dDEP balance went from ${groupDigits(a0)} to ${groupDigits(a1)}`);
      s.check(b1 === b0 + 100, `Bob’s dDEP balance went from ${groupDigits(b0)} to ${groupDigits(b1)}`);
    },
  },
  {
    n: 3,
    key: 'refused',
    title: 'Refused',
    who: 'Issuer',
    needs: [PCN],
    text: 'The issuer tries to issue 50 dPCN to Alice. Her credential says she is not accredited, and the note only accepts accredited investors, qualified purchasers and institutions.',
    expected: 'Refused before anything is sent (ERC7943CannotReceive), with the reason by topic: ACCREDITATION, “accreditation: policy rejected”. Alice’s dPCN balance does not change.',
    async run(s) {
      const before = bal(s.before, 'alice', PCN);
      const r = await s.act('issuer', 'issue', { token: PCN, to: 'alice', amount: '50' }, 'Issuer tries to issue 50 dPCN to Alice');
      s.refused(r, 'Issue 50 dPCN to Alice', 'ERC7943CannotReceive', { topic: 'ACCREDITATION', status: 'POLICY_REJECTED' });
      s.check(!r.txHash, r.txHash ? 'a transaction was sent' : 'no transaction was sent');
      const after = await s.state();
      const now = bal(after, 'alice', PCN);
      s.check(now === before, `Alice’s dPCN balance stayed at ${groupDigits(now)}`);
    },
  },
  {
    n: 4,
    key: 'revoke',
    title: 'Revoke',
    who: 'KYC Provider A, then Alice',
    needs: [DEP],
    text: 'KYC Provider A revokes Alice’s credential on EAS. Alice then tries to send 10 dDEP to Bob.',
    expected: 'The revocation is accepted. Alice’s transfer is refused (ERC7943CannotSend) with the reason by topic: KYC, “KYC: revoked”. The table shows “no” for Alice on every token.',
    async run(s) {
      const rv = await s.act('kyc-provider-a', 'revokeCredential', { investor: 'alice' }, 'KYC Provider A revokes Alice’s credential');
      s.accepted(rv, 'Revoke Alice’s credential');
      const r = await s.act('alice', 'transfer', { token: DEP, to: 'bob', amount: '10' }, 'Alice tries to send 10 dDEP to Bob');
      s.refused(r, 'Transfer 10 dDEP from Alice to Bob', 'ERC7943CannotSend', { topic: 'KYC', status: 'REVOKED' });
      const after = await s.state();
      const still = after.tokens.filter((t) => after.matrix.alice?.[t.symbol]?.eligible).map((t) => t.symbol);
      s.check(still.length === 0, still.length ? `Alice is still eligible on ${still.join(', ')}` : 'Alice shows “no: KYC …” on every token');
    },
  },
  {
    n: 5,
    key: 'rotate',
    title: 'Rotate attester',
    who: 'Operator',
    needs: [],
    text: 'The operator stops trusting KYC Provider A and trusts KYC Provider B instead, on every token. B then re-attests every investor whose credential from A is still live.',
    expected: 'A is removed and B is trusted on every token. B re-attests Bob and Dave (Alice stays revoked). Bob loses access while no provider is trusted, then gets it back. The audit trail names who removed, authorized and trusted whom.',
    async run(s) {
      const r = await s.act('operator', 'replaceAttester', { from: 'kyc-provider-a', to: 'kyc-provider-b' }, 'Operator replaces KYC Provider A with KYC Provider B');
      s.accepted(r, 'Replace KYC Provider A with KYC Provider B');
      if (!r.ok) return;
      const after = await s.state();
      const wrong = after.tokens.filter((t) => t.trustedAttesters.map((a) => a.id).join(',') !== 'kyc-provider-b').map((t) => t.symbol);
      s.check(wrong.length === 0, wrong.length ? `${wrong.join(', ')} do not trust exactly KYC Provider B` : `every token (${after.tokens.length}) now trusts KYC Provider B only`);
      const re = (r.reattested ?? []).map((x) => x.investor);
      s.check(re.includes('bob') && re.includes('dave'), `B re-attested ${re.length ? re.join(', ') : 'nobody'}`);
      const e = r.eligibility ?? {};
      const bounced = after.tokens.every((t) => e.before?.bob?.[t.symbol] && !e.afterRemoval?.bob?.[t.symbol] && e.after?.bob?.[t.symbol]);
      s.check(bounced, bounced ? 'Bob lost access when A was removed and got it back through B, on every token' : 'Bob did not drop out and come back on every token');
      const removedTx = new Set((r.removed ?? []).map((x) => x.txHash));
      const removedRows = after.auditTrail.filter((x) => x.action === 'Attester removed' && removedTx.has(x.txHash));
      const authRow = after.auditTrail.find((x) => x.action === 'Provider authorized' && x.txHash === r.authorization?.txHash);
      s.check(
        removedRows.length === (r.removed ?? []).length && authRow,
        authRow ? `the audit trail shows ${removedRows.length} removals and "${authRow.detail}" by ${authRow.actor}` : 'the audit trail lacks the authorization of B',
      );
    },
  },
  {
    n: 6,
    key: 'controls',
    title: 'Freeze, force, pause',
    who: 'Compliance officer (and Bob, Dave)',
    needs: [DEP],
    text: 'The compliance officer freezes all of Bob’s dDEP and Bob tries to send 1 dDEP. A forced transfer then moves 50 dDEP from Bob to Dave. The officer pauses dDEP and Dave tries to send 1 dDEP. Finally the officer unpauses dDEP and unfreezes Bob.',
    expected: 'Bob’s transfer is refused (ERC7943InsufficientUnfrozenBalance). The forced transfer moves 50 frozen dDEP to Dave. Dave’s transfer during the pause is refused (EnforcedPause). Unpause and unfreeze are accepted and dDEP is active again.',
    async run(s) {
      const b0 = bal(s.before, 'bob', DEP);
      const d0 = bal(s.before, 'dave', DEP);
      const all = s.before.balances?.bob?.[DEP]?.balance ?? '0';
      s.accepted(await s.act('compliance', 'freeze', { token: DEP, account: 'bob', amount: all }, `Compliance freezes all ${all} dDEP of Bob`), `Freeze ${groupDigits(all)} dDEP of Bob`);
      s.refused(await s.act('bob', 'transfer', { token: DEP, to: 'dave', amount: '1' }, 'Bob tries to send 1 dDEP'), 'Bob sends 1 frozen dDEP', 'ERC7943InsufficientUnfrozenBalance');
      s.accepted(await s.act('compliance', 'forcedTransfer', { token: DEP, from: 'bob', to: 'dave', amount: '50' }, 'Compliance forces 50 dDEP from Bob to Dave'), 'Forced transfer of 50 dDEP from Bob to Dave');
      s.accepted(await s.act('compliance', 'pause', { token: DEP }, 'Compliance pauses dDEP'), 'Pause dDEP');
      s.refused(await s.act('dave', 'transfer', { token: DEP, to: 'bob', amount: '1' }, 'Dave tries to send 1 dDEP while paused'), 'Dave sends 1 dDEP while paused', 'EnforcedPause');
      s.accepted(await s.act('compliance', 'unpause', { token: DEP }, 'Compliance unpauses dDEP'), 'Unpause dDEP');
      s.accepted(await s.act('compliance', 'freeze', { token: DEP, account: 'bob', amount: '0' }, 'Compliance unfreezes Bob'), 'Unfreeze Bob');
      const after = await s.state();
      const b1 = bal(after, 'bob', DEP);
      const d1 = bal(after, 'dave', DEP);
      s.check(b1 === b0 - 50 && d1 === d0 + 50, `dDEP balances: Bob ${groupDigits(b0)} → ${groupDigits(b1)}, Dave ${groupDigits(d0)} → ${groupDigits(d1)}`);
      const t = token(after, DEP);
      s.check(t && !t.paused && after.balances.bob[DEP].frozen === '0', t?.paused ? 'dDEP is still paused' : 'dDEP is active again and Bob has nothing frozen');
    },
  },
  {
    n: 7,
    key: 'file',
    title: 'New file',
    who: 'You (a file in templates/)',
    needs: [],
    text: 'A product is one JSON file in templates/. To add a fourth one, copy the worked example into templates/ and restart the kit. The deployer checks every file before it sends anything, then deploys the new token with its own rules and no code change. The console cannot deploy while it runs, because a deploy creates a whole new set of contracts, so “Run step” checks the folder instead.',
    commands: ['cp test/fixtures/templates/fourth-product.json templates/', 'npm start    # stop the running kit first with Ctrl+C'],
    expected: 'Every file in templates/ passes the deployer’s checks and every deployed token comes from one of them. A file added since the start shows as valid and waiting for a restart.',
    async run(s) {
      const t = await s.api.templates();
      const bad = t.files.filter((f) => !f.valid);
      s.check(!t.error, t.error ? `${t.error.file}: field "${t.error.field}": ${t.error.problem} (npm start would stop before sending anything)` : `${t.files.length} file(s) in ${t.dirs.join(', ')}`);
      for (const f of bad) s.check(false, `${f.file}: field "${f.problem.field}": ${f.problem.problem}`);
      for (const f of t.files.filter((x) => x.valid)) {
        s.check(true, f.deployed ? `${f.file}: valid, deployed as ${f.token}` : `${f.file}: valid, ${f.symbol} is deployed at the next restart (${t.restart})`);
      }
      s.check(t.missing.length === 0, t.missing.length ? `deployed tokens without a valid file: ${t.missing.join(', ')}` : 'every deployed token comes from a file in the folder');
    },
  },
]);

/**
 * Runs one story step against the API. Never throws: a failure becomes a check that did not pass.
 * @returns {Promise<{n, title, asExpected: boolean, checks: Array<{ok, text}>, actions: Array<{label, result}>}>}
 */
export async function runStep(step, api, { onAction = () => {} } = {}) {
  const checks = [];
  const actions = [];
  const check = (ok, text) => {
    checks.push({ ok: Boolean(ok), text });
    return Boolean(ok);
  };
  const s = {
    api,
    before: null,
    state: () => api.state(),
    async act(actor, action, params, label) {
      const result = await api.act(action, actor, params);
      actions.push({ label, result });
      onAction(result, label);
      return result;
    },
    check,
    accepted(r, what) {
      return check(r?.ok === true, r?.ok ? `${what}: accepted` : `${what}: ${r?.message ?? r?.error ?? 'no answer'} (expected it to be accepted)`);
    },
    refused(r, what, error, { topic, status } = {}) {
      if (!r || r.ok !== false) return check(false, `${what}: accepted, but it should have been refused (${error})`);
      let ok = r.error === error;
      let line = `${what}: refused (${r.error}): ${describeResult(r).text}`;
      if (!ok) line += ` (expected ${error})`;
      if (topic) {
        const hit = (r.reasons ?? []).find((x) => x.topic === topic && (!status || x.status === status));
        ok = ok && Boolean(hit);
        line += hit ? `; topic ${hit.topic}: “${hit.text}”` : `; no ${topic}${status ? ` ${status}` : ''} reason`;
      }
      return check(ok, line);
    },
  };
  try {
    s.before = await api.state();
    const missing = (step.needs ?? []).filter((sym) => !s.before.tokens.some((t) => t.symbol === sym));
    if (missing.length) check(false, `this deployment has no ${missing.join(', ')}: the story uses the three shipped templates`);
    else await step.run(s);
  } catch (e) {
    check(false, `stopped: ${e.message}`);
  }
  return { n: step.n, title: step.title, asExpected: checks.length > 0 && checks.every((c) => c.ok), checks, actions };
}

/** "7 of 7 steps as expected." once every step has run; progress before that. */
export function storySummary(outcomes, total = STORY.length) {
  const done = outcomes.filter(Boolean);
  const good = done.filter((o) => o.asExpected).length;
  if (done.length < total) return `${done.length} of ${total} steps run so far, ${good} as expected.`;
  return `${good} of ${total} steps as expected.`;
}

// ============ Action forms ============

/** The forms: which fields each action takes and who usually does it. The actor is always "Act as". */
export const ACTION_FORMS = Object.freeze([
  { action: 'issue', usual: 'issuer', fields: ['token', 'to', 'amount'] },
  { action: 'transfer', usual: 'investor', fields: ['token', 'to', 'amount'], note: 'The sender is the person in “Act as”.' },
  { action: 'redeem', usual: 'issuer', fields: ['token', 'from', 'amount'] },
  { action: 'freeze', usual: 'compliance', fields: ['token', 'account', 'frozen'], note: 'Sets the frozen amount; it replaces the previous one, and 0 unfreezes.' },
  { action: 'forcedTransfer', usual: 'compliance', fields: ['token', 'from', 'to', 'amount'] },
  { action: 'pause', usual: 'compliance', fields: ['token'] },
  { action: 'unpause', usual: 'compliance', fields: ['token'] },
  {
    action: 'onboardInvestor',
    usual: 'attester',
    fields: ['investor', 'kycStatus', 'amlStatus', 'sanctionsStatus', 'countryCode', 'accreditationType', 'expiresInDays'],
    note: 'The KYC provider in “Act as” issues one credential and registers it on every token that trusts it. Empty fields keep the values from kit.config.json.',
  },
  { action: 'revokeCredential', usual: 'attester', fields: ['investor'], note: 'Only the provider that issued a credential can revoke it.' },
  { action: 'authorizeProvider', usual: 'operator', fields: ['provider'] },
  { action: 'replaceAttester', usual: 'operator', fields: ['fromProvider', 'toProvider'] },
]);

const CHOICES = Object.freeze({
  kycStatus: [['1', 'verified'], ['0', 'not verified'], ['2', 'expired'], ['3', 'revoked'], ['4', 'pending']],
  amlStatus: [['0', 'clear'], ['1', 'flagged']],
  sanctionsStatus: [['0', 'clear'], ['1', 'hit']],
  accreditationType: [['0', 'none'], ['1', 'retail qualified'], ['2', 'accredited'], ['3', 'qualified purchaser'], ['4', 'institutional']],
});

const FIELDS = Object.freeze({
  token: { label: 'Token', kind: 'token' },
  to: { label: 'To', kind: 'investor', pick: 1 },
  from: { label: 'From', kind: 'investor' },
  account: { label: 'Account', kind: 'investor' },
  investor: { label: 'Investor', kind: 'investor' },
  amount: { label: 'Amount (token units)', kind: 'amount' },
  frozen: { label: 'Frozen amount (token units)', kind: 'amount', param: 'amount' },
  provider: { label: 'KYC provider', kind: 'attester' },
  fromProvider: { label: 'Replace this provider', kind: 'attester', param: 'from' },
  toProvider: { label: 'With this provider', kind: 'attester', param: 'to', pick: 1 },
  kycStatus: { label: 'KYC status', kind: 'choice', credential: true },
  amlStatus: { label: 'AML status', kind: 'choice', credential: true },
  sanctionsStatus: { label: 'Sanctions status', kind: 'choice', credential: true },
  accreditationType: { label: 'Accreditation', kind: 'choice', credential: true },
  countryCode: { label: 'Country code (ISO 3166-1 numeric, e.g. 840)', kind: 'number', credential: true, min: 1, max: 999 },
  expiresInDays: { label: 'Valid for (days)', kind: 'number', min: 1, max: 36500, placeholder: '365' },
});

/** Turns form values ({field: string}) into action params. Empty optional fields are left out. */
export function formParams(action, values) {
  const spec = ACTION_FORMS.find((f) => f.action === action);
  if (!spec) throw new Error(`unknown action ${action}`);
  const params = {};
  const credential = {};
  for (const f of spec.fields) {
    const def = FIELDS[f];
    const v = String(values[f] ?? '').trim();
    if (def.credential) {
      if (v !== '') credential[f] = Number(v);
    } else if (def.kind === 'number') {
      if (v !== '') params[def.param ?? f] = Number(v);
    } else {
      params[def.param ?? f] = v;
    }
  }
  if (Object.keys(credential).length) params.credential = credential;
  return params;
}

// ============ Page wiring (browser only) ============

function boot() {
  const $ = (sel) => document.querySelector(sel);
  const api = createApi();
  const ui = {
    state: null,
    seq: 0,
    shownSeq: 0,
    busy: false,
    outcomes: new Array(STORY.length).fill(null),
    actorsKey: '',
    tokensKey: '',
  };

  /** Builds an element. Text is always inserted as text, never parsed as HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  /** Replaces an element's children, skipping empty ones (replaceChildren(null) would insert the text "null"). */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return el;
  }

  const nameOf = (ref) => {
    if (ref === undefined || ref === null) return 'someone';
    const a = ui.state?.actors.find((x) => x.id === ref || x.address?.toLowerCase() === String(ref).toLowerCase());
    return a ? a.name : String(ref);
  };

  function txNode(hash) {
    const href = txUrl(ui.state?.explorer, hash);
    if (href) return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'hash', title: hash }, shortHash(hash));
    return h('code', { class: 'hash', title: hash }, shortHash(hash));
  }

  function addressNode(address) {
    const href = addressUrl(ui.state?.explorer, address);
    if (href) return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'hash', title: address }, shortHash(address));
    return h('code', { class: 'hash', title: address }, shortHash(address));
  }

  function setBanner(message) {
    const b = $('#banner');
    if (!message) {
      b.hidden = true;
      b.textContent = '';
      return;
    }
    b.hidden = false;
    b.textContent = message;
  }

  function setBusy(busy) {
    ui.busy = busy;
    for (const b of document.querySelectorAll('button.run-step, #run-all, #f-submit')) b.disabled = busy;
    document.body.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  // ---------- Header and "Act as" ----------

  const ROLE_TEXT = {
    operator: 'Deploys the kit and is the only one who may authorize a KYC provider.',
    issuer: 'Issues and redeems tokens (ISSUER_ROLE).',
    compliance: 'Freezes, forces transfers, pauses and unpauses (COMPLIANCE_ROLE).',
  };

  function actorRole(id) {
    const a = ui.state?.actors.find((x) => x.id === id);
    if (!a) return '';
    if (a.kind === 'role') return ROLE_TEXT[a.id] ?? 'Holds a role on the tokens.';
    if (a.kind === 'attester') return 'KYC provider: issues and revokes investor credentials on EAS.';
    const inv = ui.state.investors.find((x) => x.id === id);
    return `Investor: ${inv?.summary ?? 'fictional'}. Sends their own tokens.`;
  }

  function renderHeader(s) {
    const net = s.network === 'sepolia' ? 'Sepolia testnet' : 'Local chain';
    $('#network').textContent = `${net} · chain id ${s.chainId} · block ${s.blockNumber}`;
    const sel = $('#act-as');
    const key = s.actors.map((a) => `${a.id}:${a.name}`).join('|');
    if (key !== ui.actorsKey) {
      ui.actorsKey = key;
      const current = sel.value || 'issuer';
      const groups = [
        ['Roles', 'role'],
        ['KYC providers', 'attester'],
        ['Investors', 'investor'],
      ];
      sel.replaceChildren(
        ...groups.map(([label, kind]) =>
          h('optgroup', { label }, s.actors.filter((a) => a.kind === kind).map((a) => h('option', { value: a.id }, a.name))),
        ),
      );
      sel.value = s.actors.some((a) => a.id === current) ? current : 'issuer';
    }
    renderActAsHint();
  }

  function renderActAsHint() {
    const id = $('#act-as').value;
    $('#act-as-role').textContent = actorRole(id);
    $('#f-submit').textContent = `Send as ${nameOf(id)}`;
    renderUsual();
  }

  // ---------- Tokens ----------

  function renderTokens(s) {
    const accr = { 1: 'retail qualified', 2: 'accredited', 3: 'qualified purchaser', 4: 'institutional' };
    $('#tokens').replaceChildren(
      ...s.tokens.map((t) =>
        h(
          'article',
          { class: 'token', 'data-token': t.symbol },
          h('h3', {}, t.symbol, ' ', h('span', { class: 'token-name' }, t.name)),
          h('p', { class: `status ${t.paused ? 'paused' : 'active'}` }, t.paused ? 'Paused: transfers, issue and redeem are stopped' : 'Active'),
          h(
            'dl',
            {},
            h('dt', {}, 'Supply'),
            h('dd', {}, `${groupDigits(t.totalSupply)} ${t.symbol}`),
            h('dt', {}, 'Required topics'),
            h('dd', {}, t.requiredTopics.join(', ')),
            t.country ? [h('dt', {}, 'Countries'), h('dd', {}, `${t.country.mode} ${t.country.codes.join(', ')}`)] : null,
            t.accreditation ? [h('dt', {}, 'Accreditation'), h('dd', {}, t.accreditation.allowedTypes.map((x) => accr[x] ?? x).join(', '))] : null,
            h('dt', {}, 'Trusted KYC providers'),
            h('dd', {}, t.trustedAttesters.length ? t.trustedAttesters.map((a) => `${a.name} (${a.topics.join(', ')})`).join('; ') : 'none: nobody can be eligible'),
            h('dt', {}, 'Issue / redeem'),
            h('dd', {}, `${t.labels?.issue ?? 'Issue'} / ${t.labels?.redeem ?? 'Redeem'}`),
            h('dt', {}, 'Contract'),
            h('dd', {}, addressNode(t.address)),
          ),
        ),
      ),
    );
  }

  // ---------- Who may hold what ----------

  function renderMatrix(s) {
    const head = h('tr', {}, h('th', { scope: 'col' }, 'Investor'), s.tokens.map((t) => h('th', { scope: 'col' }, t.symbol, h('span', { class: 'sub' }, t.name))));
    const rows = s.investors.map((inv) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, inv.name, h('span', { class: 'sub' }, inv.summary)),
        s.tokens.map((t) => {
          const c = cellSummary(s.matrix[inv.id]?.[t.symbol]);
          const b = s.balances[inv.id]?.[t.symbol];
          const holds = b && b.balance !== '0' ? `holds ${groupDigits(b.balance)}${b.frozen !== '0' ? ` (${groupDigits(b.frozen)} frozen)` : ''}` : null;
          return h(
            'td',
            { class: c.eligible ? 'yes' : 'no', 'data-investor': inv.id, 'data-token': t.symbol },
            h('span', { class: 'verdict' }, c.text),
            c.detail ? h('span', { class: 'sub' }, c.detail) : null,
            holds ? h('span', { class: 'sub holds' }, holds) : null,
          );
        }),
      ),
    );
    $('#matrix').replaceChildren(
      h('caption', {}, 'Read live from each token’s eligibility check. “no” names the topics that fail.'),
      h('thead', {}, head),
      h('tbody', {}, rows),
    );
  }

  // ---------- Audit trail ----------

  function renderAudit(s) {
    const rows = [...s.auditTrail].reverse();
    $('#audit-count').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} since block ${s.deployBlock}, newest first.`;
    $('#audit-body').replaceChildren(
      ...rows.map((e) =>
        h(
          'tr',
          {},
          h('td', { 'data-label': 'Time' }, e.time ? h('time', { datetime: e.time }, new Date(e.time).toLocaleString()) : `block ${e.block}`),
          h('td', { 'data-label': 'Who' }, e.actor ?? ''),
          h('td', { 'data-label': 'Action' }, e.action),
          h('td', { 'data-label': 'Token' }, e.token ?? '—'),
          h('td', { 'data-label': 'Result' }, e.detail),
          h('td', { 'data-label': 'Transaction' }, txNode(e.txHash)),
        ),
      ),
    );
  }

  // ---------- Results ----------

  function resultNode(r, title) {
    const d = describeResult(r, nameOf);
    return h(
      'div',
      { class: `outcome ${d.kind}` },
      title ? h('p', { class: 'outcome-title' }, title) : null,
      h('p', { class: 'outcome-head' }, h('strong', {}, `${d.label}: `), d.text),
      d.reasons.length
        ? h(
            'ul',
            { class: 'reasons', 'aria-label': 'Reasons by topic' },
            d.reasons.map((x) => h('li', {}, h('strong', {}, `Topic ${x.topic}`), ` — ${x.text}`, h('span', { class: 'sub' }, ` (${x.status})`))),
          )
        : null,
      d.kind === 'refused' && !d.reasons.length ? h('p', { class: 'sub' }, `Check: ${d.code}${d.role ? `, missing role ${d.role}` : ''} (not an eligibility topic)`) : null,
      d.txs.length ? h('ul', { class: 'txs', 'aria-label': 'Transactions' }, d.txs.map((t) => h('li', {}, `${t.label}: `, txNode(t.hash)))) : null,
    );
  }

  function showResult(r, title) {
    const box = $('#result');
    const old = box.firstElementChild;
    if (old) {
      const list = $('#history-list');
      list.prepend(h('li', {}, old));
      while (list.children.length > 20) list.lastElementChild.remove();
      $('#history').hidden = false;
    }
    box.replaceChildren(resultNode(r, title));
  }

  // ---------- Story ----------

  function renderStory() {
    $('#story').replaceChildren(
      ...STORY.map((step) =>
        h(
          'li',
          { class: 'step', id: `step-${step.n}` },
          h('h3', {}, `${step.n}. ${step.title}`),
          h('p', { class: 'who' }, `Acts: ${step.who}`),
          h('p', {}, step.text),
          step.commands ? h('pre', {}, h('code', {}, step.commands.join('\n'))) : null,
          h('p', { class: 'expected' }, h('strong', {}, 'Expected: '), step.expected),
          h('button', { type: 'button', class: 'run-step', 'data-step': String(step.n), onclick: () => runSteps([step]) }, `Run step ${step.n}`),
          h('p', { class: 'step-result', id: `step-${step.n}-result`, role: 'status' }, 'Result: not run yet'),
          h('div', { class: 'step-detail', id: `step-${step.n}-detail` }),
        ),
      ),
    );
    renderSummary();
  }

  function renderStepOutcome(out) {
    const res = $(`#step-${out.n}-result`);
    res.textContent = `Result: ${out.asExpected ? 'as expected' : 'not as expected'}`;
    res.className = `step-result ${out.asExpected ? 'good' : 'bad'}`;
    fill($(`#step-${out.n}-detail`),
      h('ul', { class: 'checks', 'aria-label': `What step ${out.n} checked` }, out.checks.map((c) => h('li', { class: c.ok ? 'good' : 'bad' }, `${c.ok ? '✔ ' : '✘ '}${c.text}`))),
      out.actions.length
        ? h('details', {}, h('summary', {}, `What was sent (${out.actions.length})`), h('ol', { class: 'step-actions' }, out.actions.map((a) => h('li', {}, resultNode(a.result, a.label)))))
        : null,
    );
  }

  function renderSummary() {
    $('#story-summary-text').textContent = storySummary(ui.outcomes);
    $('#story-summary-list').replaceChildren(
      ...STORY.map((step, i) => {
        const o = ui.outcomes[i];
        return h('li', {}, `${step.n}. ${step.title}: ${o ? (o.asExpected ? 'as expected' : 'not as expected') : 'not run yet'}`);
      }),
    );
  }

  async function runSteps(steps) {
    if (ui.busy) return;
    setBusy(true);
    try {
      for (const step of steps) {
        const res = $(`#step-${step.n}-result`);
        res.textContent = 'Result: running…';
        res.className = 'step-result';
        const out = await runStep(step, api);
        ui.outcomes[step.n - 1] = out;
        renderStepOutcome(out);
        renderSummary();
        await refresh({ force: true });
      }
    } finally {
      setBusy(false);
    }
    if (ui.outcomes.every(Boolean)) $('#story-summary').focus();
  }

  // ---------- Action form ----------

  function fieldNode(name, s) {
    const def = FIELDS[name];
    const id = `f-${name}`;
    const label = h('label', { for: id }, def.label);
    let control;
    if (def.kind === 'token') {
      control = h('select', { id, name }, s.tokens.map((t) => h('option', { value: t.symbol }, `${t.symbol} · ${t.name}`)));
    } else if (def.kind === 'investor' || def.kind === 'attester') {
      const people = s.actors.filter((a) => a.kind === def.kind);
      control = h('select', { id, name }, people.map((a) => h('option', { value: a.id }, a.name)));
      if (people[def.pick ?? 0]) control.value = people[def.pick ?? 0].id;
    } else if (def.kind === 'amount') {
      control = h('input', { id, name, type: 'text', inputmode: 'decimal', autocomplete: 'off', required: true, pattern: '\\d+(\\.\\d+)?', placeholder: '100' });
    } else if (def.kind === 'number') {
      control = h('input', { id, name, type: 'number', inputmode: 'numeric', min: def.min, max: def.max, step: 1, placeholder: def.placeholder ?? 'as in kit.config.json' });
    } else {
      control = h('select', { id, name }, h('option', { value: '' }, 'as in kit.config.json'), CHOICES[name].map(([v, t]) => h('option', { value: v }, `${t} (${v})`)));
    }
    return h('div', { class: 'field' }, label, control);
  }

  function renderFields() {
    const s = ui.state;
    const spec = ACTION_FORMS.find((f) => f.action === $('#f-action').value);
    if (!s || !spec) return;
    $('#f-note').textContent = spec.note ?? '';
    $('#f-fields').replaceChildren(...spec.fields.map((f) => fieldNode(f, s)));
    renderUsual();
  }

  function renderUsual() {
    const spec = ACTION_FORMS.find((f) => f.action === $('#f-action').value);
    const box = $('#f-usual');
    if (!spec || !ui.state) return box.replaceChildren();
    const actAs = $('#act-as').value;
    const actor = ui.state.actors.find((a) => a.id === actAs);
    const fits = spec.usual === actAs || actor?.kind === spec.usual;
    if (fits) return box.replaceChildren(h('span', {}, `${nameOf(actAs)} usually does this.`));
    const suggest = ui.state.actors.find((a) => a.id === spec.usual || a.kind === spec.usual);
    const who = spec.usual === 'investor' ? 'an investor (the sender)' : spec.usual === 'attester' ? 'a KYC provider' : nameOf(spec.usual);
    fill(
      box,
      h('span', {}, `Usually done by ${who}. As ${nameOf(actAs)} it shows the refusal. `),
      suggest
        ? h('button', { type: 'button', class: 'link', onclick: () => { $('#act-as').value = suggest.id; renderActAsHint(); } }, `Act as ${suggest.name}`)
        : null,
    );
  }

  function renderForm(s) {
    const key = `${s.tokens.map((t) => t.symbol).join(',')}|${s.actors.map((a) => a.id).join(',')}`;
    if (key === ui.tokensKey) return;
    ui.tokensKey = key;
    const sel = $('#f-action');
    if (!sel.options.length) sel.replaceChildren(...ACTION_FORMS.map((f) => h('option', { value: f.action }, actionLabel(f.action))));
    renderFields();
  }

  async function submitAction(ev) {
    ev.preventDefault();
    if (ui.busy) return;
    const form = $('#action-form');
    if (!form.reportValidity()) return;
    const action = $('#f-action').value;
    const actor = $('#act-as').value;
    const values = Object.fromEntries([...form.querySelectorAll('#f-fields [name]')].map((el) => [el.name, el.value]));
    const params = formParams(action, values);
    setBusy(true);
    $('#result-status').textContent = `Sending ${actionLabel(action).toLowerCase()} as ${nameOf(actor)}…`;
    try {
      const r = await api.act(action, actor, params);
      showResult(r, `${actionLabel(action)} as ${nameOf(actor)}`);
      $('#result-status').textContent = `${actionLabel(action)} as ${nameOf(actor)}: ${describeResult(r, nameOf).label.toLowerCase()}.`;
      await refresh({ force: true });
    } catch (e) {
      showResult({ ok: false, error: 'ServerError', message: e.message }, actionLabel(action));
      $('#result-status').textContent = 'The server could not be reached.';
    } finally {
      setBusy(false);
    }
  }

  // ---------- State ----------

  async function refresh({ force = false } = {}) {
    const seq = ++ui.seq;
    try {
      const s = await api.state();
      if (seq < ui.shownSeq) return ui.state; // a newer answer is already shown
      const changed = force || !ui.state || s.blockNumber !== ui.state.blockNumber || s.network !== ui.state.network;
      ui.shownSeq = seq;
      ui.state = s;
      setBanner(null);
      if (changed) {
        renderHeader(s);
        renderTokens(s);
        renderMatrix(s);
        renderAudit(s);
        renderForm(s);
      }
      return s;
    } catch (e) {
      setBanner(e.status === 503 ? 'No deployment is loaded yet. Start the kit with npm start, then reload this page.' : `Cannot load the kit state: ${e.message}`);
      return null;
    }
  }

  $('#act-as').addEventListener('change', renderActAsHint);
  $('#f-action').addEventListener('change', renderFields);
  $('#action-form').addEventListener('submit', submitAction);
  $('#refresh').addEventListener('click', () => refresh({ force: true }));
  $('#run-all').addEventListener('click', () => runSteps(STORY));
  renderStory();
  refresh({ force: true });
  setInterval(() => {
    if (!ui.busy && document.visibilityState === 'visible') refresh();
  }, 10_000);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
