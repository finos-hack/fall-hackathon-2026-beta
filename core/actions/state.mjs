// getState: everything the console, CLI and scenario show, read from the chain. Never includes a key.
// The audit trail is rebuilt from on-chain logs since the deploy block (cached incrementally per context).

import { decodeEventLog, getAbiItem, zeroAddress } from 'viem';
import { requireDeployment, nameOf, idOf, tokenByAddress } from '../lib/context.mjs';
import { explainFor, jsonSafe } from '../lib/tx.mjs';
import { topicName } from '../lib/topics.mjs';
import { decodeCredential, describeCredential, decodeIssuerAuth } from '../lib/credentials.mjs';
import { read, formatAmount } from './common.mjs';

const TOKEN_EVENTS = new Set(['Issued', 'Redeemed', 'Transfer', 'Frozen', 'ForcedTransfer', 'Paused', 'Unpaused']);
const ADAPTER_EVENTS = new Set(['TrustedAttesterAdded', 'TrustedAttesterRemoved']);

/**
 * @returns {Promise<object>} see apiNotes / docs: {network, chainId, explorer, blockNumber, blockTime, deployBlock,
 *   contracts, schemas, actors, investors, tokens, matrix, balances, auditTrail}
 */
export async function getState(ctx, { audit = true } = {}) {
  const d = requireDeployment(ctx);
  const block = await ctx.publicClient.getBlock({ blockTag: 'latest' });

  const tokens = await Promise.all(d.tokens.map((t) => tokenState(ctx, t)));

  const investors = ctx.kit.investors.map((i) => ({ id: i.id, name: i.name, address: ctx.actors[i.id].address, summary: i.summary }));
  const matrix = {};
  const balances = {};
  await Promise.all(
    investors.map(async (inv) => {
      matrix[inv.id] = {};
      balances[inv.id] = {};
      await Promise.all(
        d.tokens.map(async (t) => {
          const [eligible, topics, bal, frozen] = await Promise.all([
            read(ctx, t.eligibility, 'ShibuiEligibility', 'isEligible', [inv.address]),
            explainFor(ctx, t, inv.address),
            read(ctx, t.address, 'RegulatedToken', 'balanceOf', [inv.address]),
            read(ctx, t.address, 'RegulatedToken', 'getFrozenTokens', [inv.address]),
          ]);
          matrix[inv.id][t.symbol] = { eligible, reasons: topics.filter((x) => x.status !== 'OK'), topics };
          const unfrozen = bal > frozen ? bal - frozen : 0n;
          balances[inv.id][t.symbol] = {
            balance: formatAmount(bal, t.decimals),
            frozen: formatAmount(frozen, t.decimals),
            unfrozen: formatAmount(unfrozen, t.decimals),
            balanceRaw: bal.toString(),
            frozenRaw: frozen.toString(),
          };
        }),
      );
    }),
  );
  // Stable key order (cast order, then token order) regardless of which read finished first.
  const ordered = (obj) =>
    Object.fromEntries(investors.map((i) => [i.id, Object.fromEntries(d.tokens.map((t) => [t.symbol, obj[i.id][t.symbol]]))]));

  const state = {
    kit: 'eea-tokenization-starter-kit',
    network: ctx.network,
    chainId: ctx.chainId,
    explorer: ctx.explorer,
    blockNumber: Number(block.number),
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    deployBlock: d.deployBlock,
    deployedAt: d.deployedAt,
    contracts: {
      eas: d.shared.eas,
      schemaRegistry: d.shared.schemaRegistry,
      trustedIssuerResolver: d.shared.resolver,
      identityProxy: d.shared.identityProxy,
    },
    schemas: { investorEligibility: d.schemas.investorEligibility.uid, issuerAuthorization: d.schemas.issuerAuthorization.uid },
    actors: Object.values(ctx.actors).map((a) => ({ id: a.id, name: a.name, kind: a.kind, address: a.address })),
    investors,
    tokens,
    matrix: ordered(matrix),
    balances: ordered(balances),
    auditTrail: audit ? await auditTrail(ctx) : [],
  };
  return jsonSafe(state);
}

async function tokenState(ctx, t) {
  const [supply, paused, attesters] = await Promise.all([
    read(ctx, t.address, 'RegulatedToken', 'totalSupply'),
    read(ctx, t.address, 'RegulatedToken', 'paused'),
    read(ctx, t.adapter, 'EASTrustedIssuersAdapter', 'getTrustedAttesters'),
  ]);
  const trustedAttesters = await Promise.all(
    attesters.map(async (a) => {
      const topics = await read(ctx, t.adapter, 'EASTrustedIssuersAdapter', 'getAttesterTopics', [a]);
      return { id: idOf(ctx, a), name: nameOf(ctx, a), address: a, topics: topics.map((x) => topicName(Number(x))) };
    }),
  );
  return {
    id: t.id,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    address: t.address,
    totalSupply: formatAmount(supply, t.decimals),
    totalSupplyRaw: supply.toString(),
    paused,
    requiredTopics: t.topics,
    trustedAttesters,
    templateAttesters: t.trustedAttesters,
    roles: t.roles ?? { issuer: 'issuer', compliance: 'compliance' },
    country: t.country,
    accreditation: t.accreditation,
    labels: t.labels,
    eligibility: t.eligibility,
    verifier: t.verifier,
    adapter: t.adapter,
    registry: t.registry,
  };
}

// ============ Audit trail ============

async function getLogsChunked(ctx, params, fromBlock, toBlock) {
  const step = ctx.chainId === 31337 || ctx.chainId === 1337 ? 1_000_000n : 9_000n;
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += step) {
    const to = from + step - 1n > toBlock ? toBlock : from + step - 1n;
    out.push(...(await ctx.publicClient.getLogs({ ...params, fromBlock: from, toBlock: to })));
  }
  return out;
}

/**
 * Chronological list of what happened since deployment, rebuilt from logs:
 * EAS Attested/Revoked (the kit's two schemas), adapter TrustedAttesterAdded/Removed,
 * token Issued/Redeemed/Transfer/Frozen/ForcedTransfer/Paused/Unpaused.
 * @returns {Promise<Array<{block, time, actor, actorId, action, token, detail, txHash, logIndex}>>}
 */
export function auditTrail(ctx) {
  // One refresh at a time per context, so concurrent getState calls never append the same logs twice.
  const run = (ctx._auditBusy ?? Promise.resolve()).then(() => refreshAudit(ctx));
  ctx._auditBusy = run.catch(() => {});
  return run.then((entries) => entries.slice());
}

async function refreshAudit(ctx) {
  const d = requireDeployment(ctx);
  ctx._audit ??= { next: BigInt(d.deployBlock), entries: [], times: new Map(), senders: new Map(), attestations: new Map() };
  const cache = ctx._audit;
  const latest = await ctx.publicClient.getBlockNumber({ cacheTime: 0 });
  if (latest < cache.next) return cache.entries;

  const schemas = [d.schemas.investorEligibility.uid, d.schemas.issuerAuthorization.uid];
  const easAbi = ctx.abis.EAS;
  const [attested, revoked, other] = await Promise.all([
    getLogsChunked(ctx, { address: d.shared.eas, event: getAbiItem({ abi: easAbi, name: 'Attested' }), args: { schemaUID: schemas } }, cache.next, latest),
    getLogsChunked(ctx, { address: d.shared.eas, event: getAbiItem({ abi: easAbi, name: 'Revoked' }), args: { schemaUID: schemas } }, cache.next, latest),
    getLogsChunked(ctx, { address: [...d.tokens.map((t) => t.address), ...d.tokens.map((t) => t.adapter)] }, cache.next, latest),
  ]);

  const decoded = [];
  for (const l of [...attested, ...revoked]) decoded.push({ log: l, name: l.eventName, args: l.args, source: 'eas' });
  for (const l of other) {
    let ev;
    try {
      ev = decodeEventLog({ abi: ctx.eventAbi, data: l.data, topics: l.topics, strict: true });
    } catch {
      continue;
    }
    const token = tokenByAddress(ctx, l.address);
    if (token && TOKEN_EVENTS.has(ev.eventName)) decoded.push({ log: l, name: ev.eventName, args: ev.args, source: 'token', token });
    const viaAdapter = d.tokens.find((t) => t.adapter.toLowerCase() === l.address.toLowerCase());
    if (viaAdapter && ADAPTER_EVENTS.has(ev.eventName)) decoded.push({ log: l, name: ev.eventName, args: ev.args, source: 'adapter', token: viaAdapter });
  }
  decoded.sort((a, b) => Number(a.log.blockNumber - b.log.blockNumber) || a.log.logIndex - b.log.logIndex);

  // A forced transfer also emits Transfer; show it once.
  const forcedTx = new Set(decoded.filter((e) => e.name === 'ForcedTransfer').map((e) => `${e.log.transactionHash}:${e.token.address}`));

  // Block times, senders and attestation payloads, fetched in parallel (batched by the transport) and cached.
  const blocks = [...new Set(decoded.map((e) => e.log.blockNumber))].filter((b) => !cache.times.has(b));
  const txs = [...new Set(decoded.map((e) => e.log.transactionHash))].filter((h) => !cache.senders.has(h));
  const uids = decoded.filter((e) => e.source === 'eas').map((e) => e.args.uid).filter((u) => !cache.attestations.has(u));
  await Promise.all([
    ...blocks.map(async (b) => cache.times.set(b, Number((await ctx.publicClient.getBlock({ blockNumber: b })).timestamp))),
    ...txs.map(async (h) => cache.senders.set(h, (await ctx.publicClient.getTransaction({ hash: h })).from)),
    ...[...new Set(uids)].map(async (u) => cache.attestations.set(u, await read(ctx, d.shared.eas, 'EAS', 'getAttestation', [u]))),
  ]);

  for (const e of decoded) {
    if (e.name === 'Transfer') {
      if (e.args.from === zeroAddress || e.args.to === zeroAddress) continue; // Issued / Redeemed cover these
      if (forcedTx.has(`${e.log.transactionHash}:${e.token.address}`)) continue;
    }
    const sender = cache.senders.get(e.log.transactionHash);
    const entry = describeEvent(ctx, d, e, cache);
    if (!entry) continue;
    const ts = cache.times.get(e.log.blockNumber);
    cache.entries.push({
      block: Number(e.log.blockNumber),
      time: ts ? new Date(ts * 1000).toISOString() : null,
      actor: nameOf(ctx, sender),
      actorId: idOf(ctx, sender),
      action: entry.action,
      token: e.token?.symbol ?? null,
      detail: entry.detail,
      txHash: e.log.transactionHash,
      logIndex: e.log.logIndex,
    });
  }
  cache.next = latest + 1n;
  return cache.entries;
}

function describeEvent(ctx, d, e, cache) {
  const n = (a) => nameOf(ctx, a);
  const amt = (raw) => `${formatAmount(raw, e.token.decimals)} ${e.token.symbol}`;
  const a = e.args;
  switch (e.name) {
    case 'Attested': {
      const att = cache.attestations.get(a.uid);
      if (a.schemaUID === d.schemas.issuerAuthorization.uid) {
        const auth = att ? decodeIssuerAuth(att.data) : null;
        return {
          action: 'Provider authorized',
          detail: `${n(a.attester)} authorized ${n(a.recipient)}${auth ? ` ("${auth.issuerName}") for ${auth.topics.join(', ')}` : ''} (authorization ${a.uid})`,
        };
      }
      const f = att ? decodeCredential(att.data) : null;
      return { action: 'Credential issued', detail: `${n(a.attester)} issued a credential to ${n(a.recipient)}: ${describeCredential(f)} (credential ${a.uid})` };
    }
    case 'Revoked':
      if (a.schemaUID === d.schemas.issuerAuthorization.uid) {
        return { action: 'Authorization revoked', detail: `${n(a.attester)} revoked the authorization of ${n(a.recipient)} (${a.uid})` };
      }
      return { action: 'Credential revoked', detail: `${n(a.attester)} revoked the credential of ${n(a.recipient)} (credential ${a.uid})` };
    case 'TrustedAttesterAdded':
      return { action: 'Attester trusted', detail: `${n(a.attester)} trusted on ${e.token.symbol} for ${a.claimTopics.map((x) => topicName(Number(x))).join(', ')}` };
    case 'TrustedAttesterRemoved':
      return { action: 'Attester removed', detail: `${n(a.attester)} no longer trusted on ${e.token.symbol}` };
    case 'Issued':
      return { action: 'Issued', detail: `${e.token.labels?.issue ?? 'Issue'}: ${amt(a.amount)} to ${n(a.to)}` };
    case 'Redeemed':
      return { action: 'Redeemed', detail: `${e.token.labels?.redeem ?? 'Redeem'}: ${amt(a.amount)} from ${n(a.from)}` };
    case 'Transfer':
      return { action: 'Transfer', detail: `${amt(a.value)} from ${n(a.from)} to ${n(a.to)}` };
    case 'Frozen':
      return { action: 'Frozen', detail: `${n(a.account)} now has ${amt(a.amount)} frozen` };
    case 'ForcedTransfer':
      return { action: 'Forced transfer', detail: `${amt(a.amount)} moved from ${n(a.from)} to ${n(a.to)}` };
    case 'Paused':
      return { action: 'Paused', detail: `${e.token.symbol} paused` };
    case 'Unpaused':
      return { action: 'Unpaused', detail: `${e.token.symbol} unpaused` };
    default:
      return null;
  }
}
