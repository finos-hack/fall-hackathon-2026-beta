// vLEI actions: institutions recognised by their GLEIF vLEI credential, through OnChainTrust's VleiEligibility slot.
//
// Locally the cast's test bridge issues bridge-schema attestations for fictional entities (onboardEntity) and can
// revoke them (revokeEntity). On Sepolia the bridge is OnChainTrust's live service; Interlock never issues there, it
// only registers an existing attestation UID on its vLEI tokens (registerEntityCredential). EAS keeps no index by
// recipient, so a wallet's attestation is registered once per VleiEligibility slot; anyone may register it.

import { zeroHash, parseEventLogs } from 'viem';
import { requireDeployment, getActor, resolveParty, InputError } from '../lib/context.mjs';
import { sendTx } from '../lib/tx.mjs';
import { encodeVleiCredential, demoEvidenceHash } from '../lib/credentials.mjs';
import { defineAction, read, txOnly } from './common.mjs';

export function vleiTokens(d) {
  return d.tokens.filter((t) => t.eligibilitySource === 'vlei');
}

function requireVlei(ctx) {
  const d = requireDeployment(ctx);
  const tokens = vleiTokens(d);
  if (!d.vlei || !tokens.length) throw new InputError('this deployment has no vLEI token (a template with "eligibility": {"source": "vlei"})');
  return { d, tokens };
}

async function registerOn(ctx, actor, tokens, uid) {
  const out = [];
  for (const t of tokens) {
    const r = await sendTx(ctx, actor, { address: t.eligibility, abi: ctx.abis.VleiEligibility, functionName: 'register', args: [uid] }, { token: t });
    if (!r.ok) return { ok: false, refusal: txOnly(r), registrations: out, token: t.symbol };
    out.push({ token: t.symbol, txHash: r.txHash });
  }
  return { ok: true, registrations: out };
}

/** Local test bridge only. params: {actor (default: the cast's bridge), holder (an institution id in cast.vlei.holders), expiresInDays?} */
export const onboardEntity = defineAction('onboardEntity', async (ctx, { actor, holder, expiresInDays = 365 }) => {
  const { d, tokens } = requireVlei(ctx);
  if (!d.vlei.local) throw new InputError('onboardEntity issues test credentials from a local bridge; on a public bridge use registerEntityCredential with an existing attestation UID');
  const bridgeId = actor ?? ctx.kit.vlei?.bridge.id;
  getActor(ctx, bridgeId);
  const h = (ctx.kit.vlei?.holders ?? []).find((x) => x.wallet === holder);
  if (!h) throw new InputError(`holder: "${holder}" is not a vLEI holder in the cast (vlei.holders)`);
  const wallet = getActor(ctx, h.wallet).address;
  const now = Number((await ctx.publicClient.getBlock({ blockTag: 'latest' })).timestamp);
  const data = encodeVleiCredential({
    lei: h.lei,
    legalName: h.legalName,
    credType: h.credType,
    keriAid: `ETEST${h.lei}`, // a fictional KERI identifier, test only
    vleiSaid: demoEvidenceHash(`vLEI ${h.credType} ${h.lei}`),
    verifiedAt: now,
  });
  const expirationTime = BigInt(now + Math.round(Number(expiresInDays) * 86400));
  const r = await sendTx(ctx, bridgeId, {
    address: d.shared.eas,
    abi: ctx.abis.EAS,
    functionName: 'attest',
    args: [{ schema: d.vlei.schemaUid, data: { recipient: wallet, expirationTime, revocable: true, refUID: zeroHash, data, value: 0n } }],
  });
  if (!r.ok) return { ...txOnly(r), holder };
  const logs = parseEventLogs({ abi: ctx.abis.EAS, logs: r.receipt.logs, eventName: 'Attested' });
  const uid = logs[0].args.uid;
  const reg = await registerOn(ctx, bridgeId, tokens, uid);
  if (!reg.ok) return { ...reg.refusal, holder, uid, txHash: r.txHash };
  return { ok: true, actor: bridgeId, holder, uid, txHash: r.txHash, credential: { lei: h.lei, legalName: h.legalName, credType: h.credType, expiresAt: Number(expirationTime) }, registrations: reg.registrations };
});

/** Registers an existing bridge attestation (e.g. one issued by OnChainTrust on Sepolia) on every vLEI token. params: {actor='operator', uid} */
export const registerEntityCredential = defineAction('registerEntityCredential', async (ctx, { actor = 'operator', uid }) => {
  const { tokens } = requireVlei(ctx);
  if (typeof uid !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(uid)) throw new InputError('uid must be a 32-byte attestation UID');
  getActor(ctx, actor);
  const reg = await registerOn(ctx, actor, tokens, uid);
  if (!reg.ok) return { ...reg.refusal, uid };
  return { ok: true, actor, uid, txHash: reg.registrations[0]?.txHash, registrations: reg.registrations };
});

/** Local test bridge only: the bridge revokes the holder's registered attestation. params: {actor (default: the bridge), holder} */
export const revokeEntity = defineAction('revokeEntity', async (ctx, { actor, holder }) => {
  const { d, tokens } = requireVlei(ctx);
  if (!d.vlei.local) throw new InputError('revokeEntity is for the local test bridge; on Sepolia only OnChainTrust\'s bridge can revoke');
  const bridgeId = actor ?? ctx.kit.vlei?.bridge.id;
  const p = resolveParty(ctx, holder, 'holder');
  const uid = await read(ctx, tokens[0].eligibility, 'VleiEligibility', 'attestationOf', [p.address]);
  if (uid === zeroHash) return { ok: false, error: 'NoLiveCredential', message: `${p.name} has no registered vLEI attestation`, reasons: [], holder };
  const r = await sendTx(ctx, bridgeId, { address: d.shared.eas, abi: ctx.abis.EAS, functionName: 'revoke', args: [{ schema: d.vlei.schemaUid, data: { uid, value: 0n } }] });
  if (!r.ok) return { ...txOnly(r), holder, uid };
  return { ok: true, actor: bridgeId, holder: p.id ?? p.address, uid, txHash: r.txHash };
});

/** The legal entity behind a wallet, as the vLEI slot reports it (empty when not currently eligible). */
export async function entityOf(ctx, token, wallet) {
  const [lei, legalName, credType, expiresAt] = await read(ctx, token.eligibility, 'VleiEligibility', 'identityOf', [wallet]);
  const reason = await read(ctx, token.eligibility, 'VleiEligibility', 'reason', [wallet]);
  return { lei, legalName, credType, expiresAt: Number(expiresAt), reason };
}
