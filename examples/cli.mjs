#!/usr/bin/env node
// Command-line tool over the shared action library. Works against a running kit (npm start) from a separate
// process: addresses come from deployments/<network>.json, credential UIDs are looked up on chain.

import { pathToFileURL } from 'node:url';
import { loadEnv, NetworkError } from './lib/network.mjs';
import { ConfigError } from './lib/config.mjs';
import { openDeployment } from './lib/context.mjs';
import { getState, runAction } from '../core/actions/index.mjs';

export const HELP = `EEA Tokenization Starter Kit: command-line tool

Usage: npm run cli -- <command> [arguments] [options]
   or: node examples/cli.mjs <command> [arguments] [options]

Commands (default actor in brackets; override with --actor <id>):
  state                                 tokens, who may hold what, balances and the audit trail
  issue <token> <to> <amount>           issue new units                      [issuer]
  transfer <token> <from> <to> <amount> transfer, signed by <from>            [the sender]
  redeem <token> <from> <amount>        redeem (burn) units                  [issuer]
  freeze <token> <account> <amount>     set the frozen amount (0 unfreezes)  [compliance]
  force <token> <from> <to> <amount>    forced transfer                      [compliance]
  pause <token>                         pause the token                      [compliance]
  unpause <token>                       unpause the token                    [compliance]
  onboard <investor>                    issue and register one credential    [--provider, default kyc-provider-a]
      [--country 840] [--accreditation 2] [--kyc 1] [--aml 0] [--sanctions 0] [--sof 1] [--expires-in-days 365]
  revoke <investor> [--provider <id>]   revoke the investor's live credential [its attester]
  authorize <provider> [--topics KYC,AML] [--tokens dDEP,dMMF]
                                        authorize a KYC provider and trust it [operator]
  rotate <from-provider> <to-provider>  replace a trusted attester (W7)       [operator]

Tokens: symbol (dDEP) or template id. Parties: cast id (alice, bob, carol, dave, issuer, ...) or an address.
Amounts are in token units, e.g. 100 or 2.5.

Options:
  --json                  print the raw JSON result
  --actor <id>            act as this cast member
  --deployment <file>     deployment record (default deployments/<NETWORK>.json)
  --rpc <url>             RPC endpoint (default RPC_URL, then the URL in the local record, then http://127.0.0.1:8545)
  --network <name>        local or sepolia (default NETWORK, then local)
  -h, --help              this help

Exit code: 0 when the action succeeded, 1 when it was refused or failed.`;

const VALUE_FLAGS = new Set([
  'actor', 'deployment', 'rpc', 'network', 'provider', 'topics', 'tokens',
  'country', 'accreditation', 'kyc', 'aml', 'sanctions', 'sof', 'expires-in-days', 'limit',
]);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        flags[k] = v;
      } else flags[k] = inline ?? true;
    } else positional.push(a);
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

const int = (v, name) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(String(v))) throw new Error(`--${name} must be a whole number`);
  return Number(v);
};

/** Maps a CLI command to {action, params}. Throws on wrong usage. */
export function toAction(command, args, flags) {
  const need = (n, usage) => {
    if (args.length < n) throw new Error(`usage: ${usage}`);
  };
  const actor = flags.actor;
  switch (command) {
    case 'issue':
      need(3, 'issue <token> <to> <amount>');
      return { action: 'issue', actor, params: { token: args[0], to: args[1], amount: args[2] } };
    case 'transfer':
      need(4, 'transfer <token> <from> <to> <amount>');
      return { action: 'transfer', actor: actor ?? args[1], params: { token: args[0], from: args[1], to: args[2], amount: args[3] } };
    case 'redeem':
      need(3, 'redeem <token> <from> <amount>');
      return { action: 'redeem', actor, params: { token: args[0], from: args[1], amount: args[2] } };
    case 'freeze':
      need(3, 'freeze <token> <account> <amount>');
      return { action: 'freeze', actor, params: { token: args[0], account: args[1], amount: args[2] } };
    case 'force':
    case 'forcedTransfer':
      need(4, 'force <token> <from> <to> <amount>');
      return { action: 'forcedTransfer', actor, params: { token: args[0], from: args[1], to: args[2], amount: args[3] } };
    case 'pause':
    case 'unpause':
      need(1, `${command} <token>`);
      return { action: command, actor, params: { token: args[0] } };
    case 'onboard': {
      need(1, 'onboard <investor> [--provider id] [--country n] [--accreditation n] ...');
      const credential = {};
      const map = { country: 'countryCode', accreditation: 'accreditationType', kyc: 'kycStatus', aml: 'amlStatus', sanctions: 'sanctionsStatus', sof: 'sourceOfFundsStatus' };
      for (const [flag, field] of Object.entries(map)) {
        const v = int(flags[flag], flag);
        if (v !== undefined) credential[field] = v;
      }
      const params = { investor: args[0], credential };
      if (flags['expires-in-days'] !== undefined) params.expiresInDays = Number(flags['expires-in-days']);
      return { action: 'onboardInvestor', actor: actor ?? flags.provider, params };
    }
    case 'revoke':
      need(1, 'revoke <investor> [--provider id]');
      return { action: 'revokeCredential', actor, params: { investor: args[0], provider: flags.provider } };
    case 'authorize': {
      need(1, 'authorize <provider> [--topics KYC,AML] [--tokens dDEP,dMMF]');
      const params = { provider: args[0] };
      if (flags.topics) params.topics = String(flags.topics).split(',').map((s) => s.trim()).filter(Boolean);
      if (flags.tokens) params.tokens = String(flags.tokens).split(',').map((s) => s.trim()).filter(Boolean);
      return { action: 'authorizeProvider', actor, params };
    }
    case 'rotate':
    case 'replace':
      need(2, 'rotate <from-provider> <to-provider>');
      return { action: 'replaceAttester', actor, params: { from: args[0], to: args[1] } };
    default:
      throw new Error(`unknown command "${command}". Run with --help.`);
  }
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd()).join('\n');
}

export function formatState(s, { limit = 15 } = {}) {
  const out = [];
  out.push(`Network: ${s.network} (chain id ${s.chainId}), block ${s.blockNumber}`);
  out.push('', 'TOKENS');
  out.push(
    table([
      ['symbol', 'name', 'supply', 'paused', 'required topics', 'trusted attesters'],
      ...s.tokens.map((t) => [t.symbol, t.name, t.totalSupply, t.paused ? 'yes' : 'no', t.requiredTopics.join(', '), t.trustedAttesters.map((a) => a.name).join(', ') || '(none)']),
    ]),
  );
  out.push('', 'WHO MAY HOLD WHAT');
  out.push(
    table([
      ['investor', ...s.tokens.map((t) => t.symbol)],
      ...s.investors.map((i) => [
        i.name,
        ...s.tokens.map((t) => {
          const c = s.matrix[i.id][t.symbol];
          return c.eligible ? 'yes' : `no: ${c.reasons.map((r) => r.text).join(', ')}`;
        }),
      ]),
    ]),
  );
  out.push('', 'BALANCES (frozen in brackets)');
  out.push(
    table([
      ['investor', ...s.tokens.map((t) => t.symbol)],
      ...s.investors.map((i) => [
        i.name,
        ...s.tokens.map((t) => {
          const b = s.balances[i.id][t.symbol];
          return b.frozen !== '0' ? `${b.balance} (${b.frozen})` : b.balance;
        }),
      ]),
    ]),
  );
  const trail = s.auditTrail.slice(-limit);
  out.push('', `AUDIT TRAIL (last ${trail.length} of ${s.auditTrail.length})`);
  if (trail.length) {
    out.push(
      table([
        ['block', 'who', 'action', 'token', 'detail'],
        ...trail.map((e) => [e.block, e.actor, e.action, e.token ?? '-', e.detail]),
      ]),
    );
  }
  return out.join('\n');
}

export function formatResult(r) {
  if (r.ok) {
    const bits = [`OK ${r.action}`];
    if (r.token) bits.push(r.token);
    if (r.amount) bits.push(r.amount);
    if (r.from) bits.push(`from ${r.from}`);
    if (r.to) bits.push(`to ${r.to}`);
    if (r.account) bits.push(`account ${r.account}`);
    if (r.investor) bits.push(`investor ${r.investor}`);
    if (r.provider) bits.push(`provider ${r.provider}`);
    if (r.uid) bits.push(`credential ${r.uid}`);
    if (r.txHash) bits.push(`(tx ${r.txHash})`);
    return bits.join(' ');
  }
  const lines = [`REFUSED ${r.action ?? ''}: ${r.message ?? r.error}`.replace(/\s+:/, ':')];
  for (const x of r.reasons ?? []) lines.push(`  - ${x.text}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    stderr(e.message);
    return 1;
  }
  const { command, args, flags } = parsed;
  if (flags.help || !command || command === 'help') {
    stdout(HELP);
    return 0;
  }
  let request = null;
  if (command !== 'state') {
    try {
      request = toAction(command, args, flags);
    } catch (e) {
      stderr(e.message);
      return 1;
    }
  }
  const env = loadEnv();
  if (flags.network) env.NETWORK = String(flags.network);
  let ctx;
  try {
    ctx = await openDeployment({ env, rpcUrl: flags.rpc, deploymentFile: flags.deployment });
  } catch (e) {
    stderr(e instanceof NetworkError || e instanceof ConfigError ? e.message : e.stack ?? e.message);
    return 1;
  }
  if (command === 'state') {
    const s = await getState(ctx);
    stdout(flags.json ? JSON.stringify(s, null, 2) : formatState(s, { limit: Number(flags.limit ?? 15) }));
    return 0;
  }
  const r = await runAction(ctx, request);
  stdout(flags.json ? JSON.stringify(r, null, 2) : formatResult(r));
  return r.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.stack ?? e.message);
      process.exit(1);
    },
  );
}
