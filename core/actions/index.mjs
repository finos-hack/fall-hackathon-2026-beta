// THE shared action library. The CLI, the scripted scenario and the web server all call these functions,
// so the three can never drift apart (build plan 3.7).
//
// Every action: (ctx, params) -> Promise<result>. A refused action resolves {ok:false, ...}; it never throws
// for bad input or an on-chain refusal. Only infrastructure failures (RPC down, missing artifacts) throw.

import { issue, transfer, redeem, freeze, forcedTransfer, pause, unpause } from './token.mjs';
import { authorizeProvider, onboardInvestor, revokeCredential, replaceAttester } from './credentials.mjs';
import { getState, auditTrail } from './state.mjs';
import { onboardEntity, registerEntityCredential, revokeEntity, entityOf } from './vlei.mjs';
import { settle, approveLeg, proposeTrade, affirmTrade } from './settle.mjs';
import { deploy } from './deploy.mjs';

export { deploy, getState, auditTrail };
export { issue, transfer, redeem, freeze, forcedTransfer, pause, unpause };
export { authorizeProvider, onboardInvestor, revokeCredential, replaceAttester };
export { onboardEntity, registerEntityCredential, revokeEntity, entityOf };
export { settle, approveLeg, proposeTrade, affirmTrade };
export { eligibilitySnapshot, registeredCredentials } from './credentials.mjs';
export { createContext, withDeployment, setDeployment, readDeployment, writeDeployment } from '../lib/context.mjs';

/** Actions the server's POST /api/actions and the CLI may run, by name. */
export const ACTIONS = Object.freeze({
  authorizeProvider,
  onboardInvestor,
  revokeCredential,
  replaceAttester,
  issue,
  transfer,
  redeem,
  freeze,
  forcedTransfer,
  pause,
  unpause,
});

/**
 * Actions that need more than the three-product quickstart: a vLEI token (OnChainTrust slot) or two instruments to
 * settle against each other. runAction (and so the server's POST /api/actions) accepts them too.
 */
export const INTEROP_ACTIONS = Object.freeze({
  onboardEntity,
  registerEntityCredential,
  revokeEntity,
  settle,
  approveLeg,
  proposeTrade,
  affirmTrade,
});

/** Aliases accepted by runAction (and the CLI) for convenience. */
const ALIASES = Object.freeze({
  authorize: 'authorizeProvider',
  onboard: 'onboardInvestor',
  revoke: 'revokeCredential',
  rotate: 'replaceAttester',
  replace: 'replaceAttester',
  force: 'forcedTransfer',
  forced: 'forcedTransfer',
});

/**
 * Runs a named action. `actor` (if given) overrides params.actor.
 * @returns {Promise<object>} the action result, or {ok:false, error:'UnknownAction'|'BadRequest', message}
 */
export async function runAction(ctx, { action, actor, params = {} } = {}) {
  const name = ALIASES[action] ?? action;
  const all = { ...ACTIONS, ...INTEROP_ACTIONS };
  const fn = typeof name === 'string' && Object.hasOwn(all, name) ? all[name] : null;
  if (!fn) {
    return { ok: false, error: 'UnknownAction', message: `unknown action "${action}". Known: ${Object.keys(all).join(', ')}`, reasons: [] };
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, action: name, error: 'BadRequest', message: 'params must be an object', reasons: [] };
  }
  return fn(ctx, actor ? { ...params, actor } : params);
}

/**
 * Seeds the demo from kit.config.json "seed": W1 authorize providers, W2 onboard investors, W3 issue.
 * Entries for tokens that are not deployed are skipped (a template set without dDEP still starts).
 * @returns {Promise<{ok: boolean, steps: object[]}>}
 */
export async function seedDemo(ctx, { log = ctx.log ?? (() => {}) } = {}) {
  const seed = ctx.kit.seed;
  const steps = [];
  const symbols = new Set(ctx.deployment.tokens.flatMap((t) => [t.symbol.toLowerCase(), t.id]));
  const step = (r) => {
    steps.push(r);
    if (!r.ok) throw new Error(`seed step ${r.action} failed: ${r.message ?? r.error}`);
    return r;
  };
  for (const provider of seed.authorize) {
    const r = step(await authorizeProvider(ctx, { provider }));
    log(`  W1 ${provider} authorized on ${r.trusted.map((x) => x.token).join(', ') || '(no token lists it)'}`);
  }
  for (const o of seed.onboard) {
    const r = step(await onboardInvestor(ctx, { actor: o.provider, investor: o.investor }));
    log(`  W2 ${o.investor} onboarded by ${o.provider} (${r.registrations.length} registrations)`);
  }
  for (const s of seed.issue) {
    if (!symbols.has(s.token.toLowerCase())) {
      log(`  W3 skipped: no token ${s.token} in this deployment`);
      continue;
    }
    step(await issue(ctx, { token: s.token, to: s.to, amount: s.amount }));
    log(`  W3 issued ${s.amount} ${s.token} to ${s.to}`);
  }
  return { ok: true, steps };
}
