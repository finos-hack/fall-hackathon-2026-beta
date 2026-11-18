// Settlement between instruments (issue #5, decision D-A and D-B): delivery versus payment through DvPSettlement,
// driven by a CDM TransferInstruction and answered with the same instruction marked Settled.
//
// One transaction per step, so each step can also be prepared unsigned for an institution's own signer:
//   approveLeg (each party, its own token) -> proposeTrade (one party) -> affirmTrade (the other party: settles).
// settle() runs the four steps for two cast members and returns the CDM objects.

import { parseEventLogs } from 'viem';
import { requireDeployment, getToken, resolveParty, getActor, InputError, idOf } from '../lib/context.mjs';
import { sendTx, explainFor } from '../lib/tx.mjs';
import { transferInstruction, settledInstruction, parseTransferInstruction, cdmReference, isoDate } from '../lib/cdm.mjs';
import { defineAction, parseAmount, formatAmount, read, txOnly } from './common.mjs';

function dvpAddress(ctx) {
  const d = requireDeployment(ctx);
  if (!d.shared.dvp) throw new InputError('this deployment has no DvPSettlement contract; redeploy with the current kit');
  return d.shared.dvp;
}

function legIn(ctx, leg, field) {
  if (!leg || typeof leg !== 'object') throw new InputError(`${field} must be {token, from, to, amount}`);
  const t = getToken(ctx, leg.token);
  const from = resolveParty(ctx, leg.from, `${field}.from`);
  const to = resolveParty(ctx, leg.to, `${field}.to`);
  const amountRaw = leg.amountRaw !== undefined ? BigInt(leg.amountRaw) : parseAmount(leg.amount, t.decimals, { field: `${field}.amount` });
  return { t, from, to, amountRaw, onChain: { token: t.address, from: from.address, to: to.address, amount: amountRaw } };
}

/** Names the token and the reasons behind a refusal that came back through DvPSettlement. */
async function attribute(ctx, r, legs) {
  if (r.ok) return r;
  if ((r.error === 'ERC7943CannotSend' || r.error === 'ERC7943CannotReceive') && r.account) {
    for (const l of legs) {
      const reasons = (await explainFor(ctx, l.t, r.account)).filter((x) => x.status !== 'OK');
      const involved = r.error === 'ERC7943CannotSend' ? l.from.address === r.account : l.to.address === r.account;
      if (involved && reasons.length) {
        const verb = r.error === 'ERC7943CannotSend' ? 'send' : 'receive';
        return { ...r, token: l.t.symbol, reasons, message: `Refused: ${l[r.error === 'ERC7943CannotSend' ? 'from' : 'to'].name} may not ${verb} ${l.t.symbol} (${reasons.map((x) => x.text).join(', ')}), so neither leg moved` };
      }
    }
  }
  if (r.error === 'EnforcedPause') {
    for (const l of legs) if (await read(ctx, l.t.address, 'RegulatedToken', 'paused')) return { ...r, token: l.t.symbol, message: `Refused: ${l.t.symbol} is paused, so neither leg moved` };
  }
  if (r.error === 'ERC7943InsufficientUnfrozenBalance' || r.error === 'ERC20InsufficientBalance' || r.error === 'ERC20InsufficientAllowance') {
    return { ...r, message: `${r.message ?? `Refused: ${r.error}`}, so neither leg moved` };
  }
  return r;
}

/** Approves DvPSettlement for one leg. params: {actor (the payer of the leg), token, amount} */
export const approveLeg = defineAction('approveLeg', async (ctx, { actor, token, amount }) => {
  const t = getToken(ctx, token);
  getActor(ctx, actor);
  const raw = parseAmount(amount, t.decimals);
  const r = await sendTx(ctx, actor, { address: t.address, abi: ctx.abis.RegulatedToken, functionName: 'approve', args: [dvpAddress(ctx), raw] }, { token: t });
  return { ...txOnly(r), actor, token: t.symbol, amount: formatAmount(raw, t.decimals) };
}, { preparable: true });

/** Proposes a trade. params: {actor (a party), delivery {token, from, to, amount}, payment {...}, deadlineSeconds=3600, ref (bytes32)} */
export const proposeTrade = defineAction('proposeTrade', async (ctx, { actor, delivery, payment, deadlineSeconds = 3600, ref }) => {
  getActor(ctx, actor);
  const d = legIn(ctx, delivery, 'delivery');
  const p = legIn(ctx, payment, 'payment');
  if (typeof ref !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(ref)) throw new InputError('ref must be a bytes32 hex string (e.g. the CDM reference)');
  const now = Number((await ctx.publicClient.getBlock({ blockTag: 'latest' })).timestamp);
  const deadline = BigInt(now + Number(deadlineSeconds));
  const r = await sendTx(ctx, actor, { address: dvpAddress(ctx), abi: ctx.abis.DvPSettlement, functionName: 'propose', args: [d.onChain, p.onChain, deadline, ref] });
  if (!r.ok || r.prepared) return { ...txOnly(r), actor };
  const [ev] = parseEventLogs({ abi: ctx.abis.DvPSettlement, logs: r.receipt.logs, eventName: 'TradeProposed' });
  return { ...txOnly(r), actor, tradeId: ev.args.id, ref, deadline: Number(deadline) };
}, { preparable: true });

/** The counterparty affirms; this settles both legs. params: {actor, tradeId} */
export const affirmTrade = defineAction('affirmTrade', async (ctx, { actor, tradeId }) => {
  getActor(ctx, actor);
  if (typeof tradeId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tradeId)) throw new InputError('tradeId must be a bytes32 hex string');
  const trade = await read(ctx, dvpAddress(ctx), 'DvPSettlement', 'trade', [tradeId]);
  const legs = [trade.delivery, trade.payment].map((l, i) => ({ ...legIn(ctx, { token: l.token, from: l.from, to: l.to, amountRaw: l.amount }, i ? 'payment' : 'delivery') }));
  const r = await sendTx(ctx, actor, { address: dvpAddress(ctx), abi: ctx.abis.DvPSettlement, functionName: 'affirm', args: [tradeId] });
  return { ...(await attribute(ctx, txOnly(r), legs)), actor, tradeId };
}, { preparable: true });

/**
 * Settles a CDM TransferInstruction of two legs (delivery, then payment) between two cast members: both approve,
 * the seller (payer of the delivery leg) proposes, the buyer affirms. params: {instruction} or {delivery, payment}.
 * @returns {ok, tradeId, ref, txHash (the settling transaction), steps: [...], cdm: {instructed, settled?}}
 */
export const settle = defineAction('settle', async (ctx, { instruction, delivery, payment, deadlineSeconds = 3600 }) => {
  let legs;
  let instructed;
  const today = isoDate((await ctx.publicClient.getBlock({ blockTag: 'latest' })).timestamp);
  if (instruction) {
    legs = parseTransferInstruction(ctx, instruction).map((l, i) => legIn(ctx, { token: l.token.symbol, from: l.from.address, to: l.to.address, amountRaw: l.amountRaw }, i ? 'payment' : 'delivery'));
    instructed = instruction;
  } else {
    legs = [legIn(ctx, delivery, 'delivery'), legIn(ctx, payment, 'payment')];
    instructed = transferInstruction(ctx, legs.map((l) => ({ token: l.t, from: l.from.address, to: l.to.address, amountRaw: l.amountRaw })), { date: today, status: 'Instructed' });
  }
  if (legs.length !== 2) throw new InputError(`a DvP settlement has exactly two legs (delivery, payment); the instruction has ${legs.length}`);
  const [d, p] = legs;
  if (d.from.address !== p.to.address || d.to.address !== p.from.address) throw new InputError('the payment leg must mirror the delivery leg: the buyer pays the seller');
  const seller = d.from.id ?? idOf(ctx, d.from.address);
  const buyer = d.to.id ?? idOf(ctx, d.to.address);
  if (!seller || !buyer) throw new InputError('settle signs for both parties, so both must be cast members; otherwise use approveLeg, proposeTrade and affirmTrade');
  const ref = cdmReference(instructed);
  const steps = [];
  const step = (r, what) => {
    steps.push({ what, ok: r.ok, txHash: r.txHash ?? null, error: r.error ?? null });
    return r;
  };
  const fail = (r, stage) => ({ ...r, stage, ref, steps, cdm: { instructed } });

  let r = step(await approveLeg.unlocked(ctx, { actor: seller, token: d.t.symbol, amount: formatAmount(d.amountRaw, d.t.decimals) }), `${d.from.name} approves the ${d.t.symbol} leg`);
  if (!r.ok) return fail(r, 'approve');
  r = step(await approveLeg.unlocked(ctx, { actor: buyer, token: p.t.symbol, amount: formatAmount(p.amountRaw, p.t.decimals) }), `${p.from.name} approves the ${p.t.symbol} leg`);
  if (!r.ok) return fail(r, 'approve');
  const prop = step(
    await proposeTrade.unlocked(ctx, {
      actor: seller,
      delivery: { token: d.t.symbol, from: d.from.address, to: d.to.address, amountRaw: d.amountRaw },
      payment: { token: p.t.symbol, from: p.from.address, to: p.to.address, amountRaw: p.amountRaw },
      deadlineSeconds,
      ref,
    }),
    `${d.from.name} proposes the trade`,
  );
  if (!prop.ok) return fail(prop, 'propose');
  const aff = step(await affirmTrade.unlocked(ctx, { actor: buyer, tradeId: prop.tradeId }), `${p.from.name} affirms: both legs settle`);
  if (!aff.ok) return { ...fail(aff, 'affirm'), tradeId: prop.tradeId };
  const block = await ctx.publicClient.getTransactionReceipt({ hash: aff.txHash }).then((rc) => ctx.publicClient.getBlock({ blockNumber: rc.blockNumber }));
  const settled = settledInstruction(instructed, { txHash: aff.txHash, date: isoDate(block.timestamp), chainId: ctx.chainId });
  return {
    ok: true,
    actor: buyer,
    seller,
    buyer,
    tradeId: prop.tradeId,
    ref,
    txHash: aff.txHash,
    delivery: { token: d.t.symbol, amount: formatAmount(d.amountRaw, d.t.decimals) },
    payment: { token: p.t.symbol, amount: formatAmount(p.amountRaw, p.t.decimals) },
    steps,
    cdm: { instructed, settled },
  };
});
