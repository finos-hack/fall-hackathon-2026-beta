// Shared plumbing for the action library: locking, input errors, amounts and small chain reads.

import { parseUnits, formatUnits } from 'viem';
import { withLock, InputError } from '../lib/context.mjs';
import { jsonSafe } from '../lib/tx.mjs';

/**
 * Wraps an action so that it (1) runs under the context lock, (2) never throws for bad input or an on-chain
 * refusal, and (3) always returns JSON-safe data tagged with the action name. `preparable`: the action sends exactly
 * one transaction, so in prepare mode it returns that transaction unsigned.
 * The returned function also exposes `.unlocked` for composition inside another locked action.
 */
export function defineAction(name, impl, { preparable = false } = {}) {
  const run = async (ctx, params = {}) => {
    if (ctx.mode === 'prepare' && !preparable) {
      return {
        ok: false,
        action: name,
        error: 'PrepareNotSupported',
        message: `${name} sends several dependent transactions, so it cannot be prepared unsigned; give the context a signer for this actor instead`,
        reasons: [],
      };
    }
    try {
      const r = await impl(ctx, params ?? {});
      return jsonSafe({ action: name, ...r });
    } catch (e) {
      if (e instanceof InputError) return { ok: false, action: name, error: 'BadRequest', message: e.message, reasons: [] };
      throw e;
    }
  };
  const locked = (ctx, params) => withLock(ctx, () => run(ctx, params));
  locked.unlocked = run;
  locked.actionName = name;
  return locked;
}

/** "100", "1.5" or 100 in token units -> raw bigint. */
export function parseAmount(amount, decimals, { allowZero = false, field = 'amount' } = {}) {
  const s = typeof amount === 'number' ? String(amount) : amount;
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s.trim())) {
    throw new InputError(`${field} must be a positive decimal number such as "100" or "2.5", not ${JSON.stringify(amount)}`);
  }
  const [, frac = ''] = s.trim().split('.');
  if (frac.length > decimals) throw new InputError(`${field} has more than ${decimals} decimal places`);
  const raw = parseUnits(s.trim(), decimals);
  if (!allowZero && raw === 0n) throw new InputError(`${field} must be greater than zero`);
  return raw;
}

export function formatAmount(raw, decimals) {
  return formatUnits(BigInt(raw), decimals);
}

export function read(ctx, address, abiName, functionName, args = []) {
  return ctx.publicClient.readContract({ address, abi: ctx.abis[abiName], functionName, args });
}

/** Strips the receipt from a sendTx result. */
export function txOnly(r) {
  if (!r.ok) return r;
  const { receipt, ...rest } = r;
  return rest;
}
