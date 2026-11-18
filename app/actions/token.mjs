// Token actions: W3 issue, W4 transfer, W5 redeem, W8 freeze / forced transfer / pause / unpause.
// Each takes {actor, ...params}, simulates first, and returns {ok:true, txHash, ...} or a decoded refusal.

import { getToken, resolveParty, getActor, InputError } from '../lib/context.mjs';
import { sendTx } from '../lib/tx.mjs';
import { defineAction, parseAmount, formatAmount, txOnly } from './common.mjs';

/** The default signer for a role on token t: the template's roles, else the kit role of the same name. */
function signer(t, role) {
  return t.roles?.[role] ?? role;
}

function partyOut(p) {
  return p.id ?? p.address;
}

async function tokenCall(ctx, actor, t, functionName, args, extra) {
  getActor(ctx, actor); // unknown actor -> BadRequest
  const r = await sendTx(ctx, actor, { address: t.address, abi: ctx.abis.RegulatedToken, functionName, args }, { token: t });
  return { ...txOnly(r), actor, token: t.symbol, ...extra };
}

/** W3. params: {actor=the token's issuer, token, to, amount} */
export const issue = defineAction('issue', async (ctx, { actor, token, to, amount }) => {
  const t = getToken(ctx, token);
  actor ??= signer(t, 'issuer');
  const p = resolveParty(ctx, to, 'to');
  const raw = parseAmount(amount, t.decimals);
  return tokenCall(ctx, actor, t, 'issue', [p.address, raw], { to: partyOut(p), amount: formatAmount(raw, t.decimals), amountRaw: raw });
});

/** W4. The sender signs: params {actor (the sender; `from` is an alias), token, to, amount} */
export const transfer = defineAction('transfer', async (ctx, { actor, from, token, to, amount }) => {
  const sender = actor ?? from;
  if (!sender) throw new InputError('transfer needs actor (the sending investor)');
  if (actor && from && actor !== from) throw new InputError('transfer: the sender signs, so actor and from must match');
  const t = getToken(ctx, token);
  const p = resolveParty(ctx, to, 'to');
  const raw = parseAmount(amount, t.decimals);
  return tokenCall(ctx, sender, t, 'transfer', [p.address, raw], { from: sender, to: partyOut(p), amount: formatAmount(raw, t.decimals), amountRaw: raw });
});

/** W5. params: {actor=the token's issuer, token, from, amount} */
export const redeem = defineAction('redeem', async (ctx, { actor, token, from, amount }) => {
  const t = getToken(ctx, token);
  actor ??= signer(t, 'issuer');
  const p = resolveParty(ctx, from, 'from');
  const raw = parseAmount(amount, t.decimals);
  return tokenCall(ctx, actor, t, 'redeem', [p.address, raw], { from: partyOut(p), amount: formatAmount(raw, t.decimals), amountRaw: raw });
});

/** W8. Sets (overwrites) the frozen amount. params: {actor=the token's compliance signer, token, account, amount} (0 unfreezes) */
export const freeze = defineAction('freeze', async (ctx, { actor, token, account, amount }) => {
  const t = getToken(ctx, token);
  actor ??= signer(t, 'compliance');
  const p = resolveParty(ctx, account, 'account');
  const raw = parseAmount(amount, t.decimals, { allowZero: true });
  return tokenCall(ctx, actor, t, 'setFrozenTokens', [p.address, raw], { account: partyOut(p), frozen: formatAmount(raw, t.decimals), frozenRaw: raw });
});

/** W8. params: {actor=the token's compliance signer, token, from, to, amount} */
export const forcedTransfer = defineAction('forcedTransfer', async (ctx, { actor, token, from, to, amount }) => {
  const t = getToken(ctx, token);
  actor ??= signer(t, 'compliance');
  const f = resolveParty(ctx, from, 'from');
  const p = resolveParty(ctx, to, 'to');
  const raw = parseAmount(amount, t.decimals);
  return tokenCall(ctx, actor, t, 'forcedTransfer', [f.address, p.address, raw], {
    from: partyOut(f),
    to: partyOut(p),
    amount: formatAmount(raw, t.decimals),
    amountRaw: raw,
  });
});

/** W8. params: {actor=the token's compliance signer, token} */
export const pause = defineAction('pause', async (ctx, { actor, token }) => {
  const t = getToken(ctx, token);
  actor ??= signer(t, 'compliance');
  return tokenCall(ctx, actor, t, 'pause', [], {});
});

/** W8. params: {actor=the token's compliance signer, token} */
export const unpause = defineAction('unpause', async (ctx, { actor, token }) => {
  const t = getToken(ctx, token);
  actor ??= signer(t, 'compliance');
  return tokenCall(ctx, actor, t, 'unpause', [], {});
});
