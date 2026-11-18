// Attester and credential actions: W1 authorize a KYC provider, W2 onboard an investor, W6 revoke,
// W7 replace an attester. Credential UIDs are always looked up on chain (verifier.getRegisteredAttestation),
// so these work from a process that did not create them (the CLI next to a running server).

import { zeroHash, parseEventLogs } from 'viem';
import { requireDeployment, getToken, resolveParty, getActor, idOf, nameOf, InputError } from '../lib/context.mjs';
import { sendTx } from '../lib/tx.mjs';
import { TOPICS, TOPIC_NAMES, isTopicName, topicName } from '../lib/topics.mjs';
import { validateCredentialFields, ConfigError } from '../lib/config.mjs';
import {
  CREDENTIAL_DEFAULTS,
  encodeCredential,
  decodeCredential,
  encodeIssuerAuth,
  demoEvidenceHash,
} from '../lib/credentials.mjs';
import { defineAction, read, txOnly } from './common.mjs';

const YEAR = 365 * 24 * 3600;

function attestedUid(ctx, receipt) {
  const logs = parseEventLogs({ abi: ctx.abis.EAS, logs: receipt.logs, eventName: 'Attested' });
  if (!logs.length) throw new Error('EAS Attested event missing from the receipt');
  return logs[0].args.uid;
}

async function chainTime(ctx) {
  const b = await ctx.publicClient.getBlock({ blockTag: 'latest' });
  return Number(b.timestamp);
}

function attestRequest(schema, recipient, data, expirationTime = 0n) {
  return { schema, data: { recipient, expirationTime: BigInt(expirationTime), revocable: true, refUID: zeroHash, data, value: 0n } };
}

/** Tokens whose eligibility is Shibui (per-topic credentials). vLEI tokens are handled in vlei.mjs. */
export function shibuiTokens(d) {
  return d.tokens.filter((t) => (t.eligibilitySource ?? 'shibui') === 'shibui');
}

/** Is `attester` trusted for `topicId` on token t? */
function trustedFor(ctx, t, attester, topicId) {
  return read(ctx, t.adapter, 'EASTrustedIssuersAdapter', 'isAttesterTrusted', [attester, BigInt(topicId)]);
}

/** Eligibility of every cast investor on every token: {alice: {dDEP: true, ...}}. */
export async function eligibilitySnapshot(ctx) {
  const d = requireDeployment(ctx);
  const out = {};
  await Promise.all(
    ctx.kit.investors.map(async (inv) => {
      const a = ctx.actors[inv.id];
      out[inv.id] = {};
      await Promise.all(
        d.tokens.map(async (t) => {
          out[inv.id][t.symbol] = await read(ctx, t.eligibility, 'ShibuiEligibility', 'isEligible', [a.address]);
        }),
      );
    }),
  );
  return out;
}

/**
 * Live credentials registered for `wallet` on any token, by the given attesters.
 * @returns {Promise<Array<{uid, attester, attesterId, tokens: string[], attestation}>>}
 */
export async function registeredCredentials(ctx, wallet, attesterAddresses, { includeRevoked = false } = {}) {
  const d = requireDeployment(ctx);
  const found = new Map();
  const lookups = [];
  for (const t of shibuiTokens(d)) {
    for (const topic of t.topicIds) {
      for (const att of attesterAddresses) {
        lookups.push(
          read(ctx, t.verifier, 'EASClaimVerifier', 'getRegisteredAttestation', [wallet, BigInt(topic), att]).then((uid) => {
            if (uid === zeroHash) return;
            const e = found.get(uid) ?? { uid, attester: att, attesterId: idOf(ctx, att), tokens: [], topics: [] };
            if (!e.tokens.includes(t.symbol)) e.tokens.push(t.symbol);
            e.topics.push(`${t.symbol}:${topicName(topic)}`);
            found.set(uid, e);
          }),
        );
      }
    }
  }
  await Promise.all(lookups);
  const out = [];
  for (const e of found.values()) {
    const att = await read(ctx, d.shared.eas, 'EAS', 'getAttestation', [e.uid]);
    if (!includeRevoked && att.revocationTime !== 0n) continue;
    out.push({ ...e, attestation: att, revoked: att.revocationTime !== 0n, fields: decodeCredential(att.data) });
  }
  return out.sort((a, b) => Number(b.attestation.time - a.attestation.time));
}

function attesterAddressesFor(ctx, ref) {
  if (ref) return [resolveParty(ctx, ref, 'provider').address];
  return ctx.kit.attesters.map((a) => ctx.actors[a.id].address);
}

// ============ W1 ============

async function authorizeImpl(ctx, { actor = 'operator', provider, topics, name, tokens }) {
  const d = requireDeployment(ctx);
  getActor(ctx, actor);
  const p = resolveParty(ctx, provider, 'provider');
  const cfg = ctx.kit.attesters.find((a) => a.id === p.id);
  const topicNames = topics ?? cfg?.authorizedTopics;
  if (!Array.isArray(topicNames) || topicNames.length === 0) throw new InputError('topics: list the topics to authorize (e.g. ["KYC","AML"])');
  for (const tn of topicNames) {
    if (!isTopicName(tn)) throw new InputError(`topics: unknown topic "${tn}". Supported: ${TOPIC_NAMES.join(', ')}`);
  }
  const issuerName = name ?? cfg?.name ?? p.name;
  const targets = (tokens ? tokens.map((x) => getToken(ctx, x)) : d.tokens.filter((t) => p.id && t.trustedAttesters.includes(p.id))).filter(
    (t) => (t.eligibilitySource ?? 'shibui') === 'shibui',
  );

  // 1. Issuer Authorization attestation (only resolver authorizers may write it).
  const data = encodeIssuerAuth(p.address, topicNames.map((tn) => TOPICS[tn]), issuerName);
  const r = await sendTx(ctx, actor, {
    address: d.shared.eas,
    abi: ctx.abis.EAS,
    functionName: 'attest',
    args: [attestRequest(d.schemas.issuerAuthorization.uid, p.address, data)],
  });
  if (!r.ok) return { ...r, provider: p.id ?? p.address };
  const authUID = attestedUid(ctx, r.receipt);

  // 2. Trust it on each token for (token topics ∩ authorized topics), and let explain watch it.
  const trusted = [];
  const skipped = [];
  for (const t of targets) {
    const ids = t.topics.filter((tn) => topicNames.includes(tn)).map((tn) => TOPICS[tn]);
    if (!ids.length) {
      skipped.push({ token: t.symbol, reason: 'no topic in common' });
      continue;
    }
    if (await read(ctx, t.adapter, 'EASTrustedIssuersAdapter', 'isTrustedAttester', [p.address])) {
      skipped.push({ token: t.symbol, reason: 'already trusted' });
      continue;
    }
    const add = await sendTx(ctx, actor, {
      address: t.adapter,
      abi: ctx.abis.EASTrustedIssuersAdapter,
      functionName: 'addTrustedAttester',
      args: [p.address, ids.map(BigInt), authUID],
    }, { token: t });
    if (!add.ok) return { ...add, provider: p.id ?? p.address, authUID, txHash: r.txHash, trusted, token: t.symbol };
    const watched = await read(ctx, t.eligibility, 'ShibuiEligibility', 'watchedAttesters');
    let watchTxHash = null;
    if (!watched.some((w) => w.toLowerCase() === p.address.toLowerCase())) {
      const w = await sendTx(ctx, actor, { address: t.eligibility, abi: ctx.abis.ShibuiEligibility, functionName: 'watchAttester', args: [p.address] }, { token: t });
      if (!w.ok) return { ...w, provider: p.id ?? p.address, authUID, txHash: r.txHash, trusted, token: t.symbol };
      watchTxHash = w.txHash;
    }
    trusted.push({ token: t.symbol, topics: ids.map(topicName), txHash: add.txHash, watchTxHash });
  }
  return { ok: true, actor, txHash: r.txHash, provider: p.id ?? p.address, issuerName, topics: [...topicNames], authUID, trusted, skipped };
}

/** W1. params: {actor='operator', provider, topics? (default kit.config authorizedTopics), name?, tokens? (default: tokens whose template lists the provider)} */
export const authorizeProvider = defineAction('authorizeProvider', authorizeImpl);

// ============ W2 ============

async function onboardImpl(ctx, { actor, provider, investor, credential = {}, expiresInDays, easExpirationTime = 0, tokens }) {
  const d = requireDeployment(ctx);
  const providerId = actor ?? provider ?? ctx.kit.attesters[0]?.id;
  const prov = getActor(ctx, providerId);
  const inv = resolveParty(ctx, investor, 'investor');
  const cfg = ctx.kit.investors.find((i) => i.id === inv.id);
  let overrides;
  try {
    overrides = validateCredentialFields(credential ?? {}, 'request', 'credential');
  } catch (e) {
    if (e instanceof ConfigError) throw new InputError(`${e.field}: ${e.problem}`);
    throw e;
  }
  if (!cfg?.credential && Object.keys(overrides).length === 0) {
    return {
      ok: false,
      error: 'NoCredentialFields',
      message: `${inv.name} has no credential in kit.config.json; pass credential fields (e.g. {"countryCode":840,"accreditationType":2})`,
      reasons: [],
      investor: inv.id ?? inv.address,
    };
  }
  const targets = (tokens ? tokens.map((x) => getToken(ctx, x)) : d.tokens).filter((t) => (t.eligibilitySource ?? 'shibui') === 'shibui');

  // Registrations this provider may make: required topics it is trusted for, per token.
  const plan = [];
  for (const t of targets) {
    for (const topic of t.topicIds) {
      if (await trustedFor(ctx, t, prov.address, topic)) plan.push({ t, topic });
    }
  }
  if (!plan.length) {
    return {
      ok: false,
      error: 'AttesterNotTrusted',
      message: `Refused: ${prov.name} is not a trusted attester for any required topic on ${targets.map((t) => t.symbol).join(', ')}. Authorize it first.`,
      reasons: [],
      actor: providerId,
      investor: inv.id ?? inv.address,
    };
  }

  const now = await chainTime(ctx);
  const fields = { ...CREDENTIAL_DEFAULTS, ...(cfg?.credential ?? {}), ...overrides };
  if (overrides.expirationTimestamp === undefined) {
    fields.expirationTimestamp = expiresInDays !== undefined ? now + Math.round(Number(expiresInDays) * 86400) : now + YEAR;
  }
  if (!Number.isFinite(fields.expirationTimestamp) || fields.expirationTimestamp < 0) throw new InputError('expiresInDays must be a number');
  fields.evidenceHash ??= demoEvidenceHash(`${inv.id ?? inv.address} by ${providerId} at ${now}`);
  const easExpiry = Number(easExpirationTime) || 0;

  // One credential on EAS: recipient = the investor wallet, identity field = the wallet (the kit's identity model).
  const r = await sendTx(ctx, providerId, {
    address: d.shared.eas,
    abi: ctx.abis.EAS,
    functionName: 'attest',
    args: [attestRequest(d.schemas.investorEligibility.uid, inv.address, encodeCredential(inv.address, fields), easExpiry)],
  });
  if (!r.ok) return { ...r, investor: inv.id ?? inv.address };
  const uid = attestedUid(ctx, r.receipt);

  // One registration per token and topic, by the provider itself (Shibui refuses the investor).
  const registrations = [];
  for (const { t, topic } of plan) {
    const reg = await sendTx(ctx, providerId, {
      address: t.verifier,
      abi: ctx.abis.EASClaimVerifier,
      functionName: 'registerAttestation',
      args: [inv.address, BigInt(topic), uid],
    }, { token: t });
    if (!reg.ok) return { ...reg, txHash: r.txHash, uid, investor: inv.id ?? inv.address, registrations, token: t.symbol };
    registrations.push({ token: t.symbol, topic: topicName(topic), txHash: reg.txHash });
  }
  return {
    ok: true,
    actor: providerId,
    txHash: r.txHash,
    uid,
    investor: inv.id ?? inv.address,
    credential: { ...fields },
    easExpirationTime: easExpiry,
    registrations,
  };
}

/**
 * W2. params: {actor (the KYC provider; `provider` is an alias, default the first attester in kit.config.json),
 *   investor, credential? (fields overriding kit.config.json: kycStatus, amlStatus, sanctionsStatus,
 *   sourceOfFundsStatus, accreditationType, countryCode, expirationTimestamp, evidenceHash, verificationMethod),
 *   expiresInDays? (payload expiry, default 365), easExpirationTime? (EAS-level, unix seconds, default 0 = never),
 *   tokens? (default: all)}
 */
export const onboardInvestor = defineAction('onboardInvestor', onboardImpl);

// ============ W6 ============

async function revokeImpl(ctx, { actor, provider, investor, uid }) {
  const d = requireDeployment(ctx);
  const inv = resolveParty(ctx, investor, 'investor');
  let creds;
  if (uid) {
    const att = await read(ctx, d.shared.eas, 'EAS', 'getAttestation', [uid]);
    if (att.uid === zeroHash) throw new InputError(`uid ${uid} is not an attestation on this EAS`);
    creds = att.revocationTime === 0n ? [{ uid, attester: att.attester, attesterId: idOf(ctx, att.attester), attestation: att }] : [];
  } else {
    creds = await registeredCredentials(ctx, inv.address, attesterAddressesFor(ctx, provider ?? (actor && ctx.kit.attesters.some((a) => a.id === actor) ? actor : null)));
  }
  if (!creds.length) {
    return {
      ok: false,
      error: 'NoLiveCredential',
      message: `${inv.name} has no live registered credential${provider ? ` from ${nameOf(ctx, resolveParty(ctx, provider).address)}` : ''}`,
      reasons: [],
      investor: inv.id ?? inv.address,
    };
  }
  const revoked = [];
  for (const c of creds) {
    const signer = actor ?? c.attesterId;
    if (!signer) throw new InputError(`the credential ${c.uid} was attested by ${c.attester}, which is not in the cast; pass actor`);
    const r = await sendTx(ctx, signer, {
      address: d.shared.eas,
      abi: ctx.abis.EAS,
      functionName: 'revoke',
      args: [{ schema: c.attestation.schema, data: { uid: c.uid, value: 0n } }],
    });
    if (!r.ok) return { ...txOnly(r), investor: inv.id ?? inv.address, uid: c.uid, revoked };
    revoked.push({ uid: c.uid, attester: c.attesterId ?? c.attester, txHash: r.txHash });
  }
  return { ok: true, actor: actor ?? revoked[0].attester, txHash: revoked[0].txHash, uid: revoked[0].uid, investor: inv.id ?? inv.address, revoked };
}

/** W6. params: {actor? (default: the credential's attester), investor, provider? (whose credential), uid? (explicit)} */
export const revokeCredential = defineAction('revokeCredential', revokeImpl);

// ============ W7 ============

async function replaceImpl(ctx, { actor = 'operator', from, to, topics, name, tokens }) {
  const d = requireDeployment(ctx);
  getActor(ctx, actor);
  const A = resolveParty(ctx, from, 'from');
  const B = resolveParty(ctx, to, 'to');
  if (!B.id) throw new InputError('to: the new provider must be in the cast (kit.config.json attesters) so the kit can sign for it');
  if (A.address === B.address) throw new InputError('from and to are the same attester');
  if (tokens !== undefined && (!Array.isArray(tokens) || tokens.length === 0)) throw new InputError('tokens: a non-empty list of token symbols, or leave it out for every token');
  const scope = (tokens ? tokens.map((x) => getToken(ctx, x)) : d.tokens).filter((t) => (t.eligibilitySource ?? 'shibui') === 'shibui');

  const tokensWithA = [];
  for (const t of scope) {
    if (await read(ctx, t.adapter, 'EASTrustedIssuersAdapter', 'isTrustedAttester', [A.address])) tokensWithA.push(t);
  }
  if (!tokensWithA.length) {
    return { ok: false, error: 'AttesterNotTrusted', message: `Refused: ${A.name} is not trusted on any token`, reasons: [], from: A.id ?? A.address };
  }

  // Investors A attested, with a live credential (a revoked one is not re-attested: that would undo the revocation).
  const toReattest = [];
  const inScope = new Set(tokensWithA.map((t) => t.symbol));
  for (const inv of ctx.kit.investors) {
    const creds = (await registeredCredentials(ctx, ctx.actors[inv.id].address, [A.address])).filter((c) => c.tokens.some((s) => inScope.has(s)));
    if (creds.length && creds[0].fields) toReattest.push({ investor: inv.id, fields: creds[0].fields, previousUid: creds[0].uid });
  }

  const before = await eligibilitySnapshot(ctx);
  const removed = [];
  for (const t of tokensWithA) {
    const r = await sendTx(ctx, actor, { address: t.adapter, abi: ctx.abis.EASTrustedIssuersAdapter, functionName: 'removeTrustedAttester', args: [A.address] }, { token: t });
    if (!r.ok) return { ...txOnly(r), from: A.id ?? A.address, removed, token: t.symbol };
    removed.push({ token: t.symbol, txHash: r.txHash });
  }
  const afterRemoval = await eligibilitySnapshot(ctx);

  const auth = await authorizeImpl(ctx, { actor, provider: B.id, topics, name, tokens: tokensWithA.map((t) => t.symbol) });
  if (!auth.ok) return { ...txOnly(auth), from: A.id ?? A.address, removed };

  const reattested = [];
  for (const r of toReattest) {
    const { identity, ...fields } = r.fields;
    fields.evidenceHash = demoEvidenceHash(`${r.investor} re-attested by ${B.id} replacing ${r.previousUid}`);
    const o = await onboardImpl(ctx, { actor: B.id, investor: r.investor, credential: fields, tokens: tokensWithA.map((t) => t.symbol) });
    if (!o.ok) return { ...txOnly(o), from: A.id ?? A.address, removed, authorization: auth, reattested };
    reattested.push({ investor: r.investor, uid: o.uid, previousUid: r.previousUid, txHash: o.txHash, registrations: o.registrations.length });
  }
  const after = await eligibilitySnapshot(ctx);
  return {
    ok: true,
    actor,
    txHash: auth.txHash,
    from: A.id ?? A.address,
    to: B.id,
    tokens: tokensWithA.map((t) => t.symbol),
    removed,
    authorization: { authUID: auth.authUID, txHash: auth.txHash, trusted: auth.trusted },
    reattested,
    eligibility: { before, afterRemoval, after },
  };
}

/** W7. params: {actor='operator', from (old provider), to (new provider), topics?, name?, tokens? (default: every token that trusts `from`)} */
export const replaceAttester = defineAction('replaceAttester', replaceImpl);
