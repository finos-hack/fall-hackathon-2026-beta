// npm run scenario (test E1): runs W1..W9 through the shared action library on a FRESH local chain (its own
// anvil on a random free port) and prints exactly one PASS/FAIL line per definition-of-done check, then "N of 8".
// NETWORK=sepolia runs the same checks on Sepolia (RPC_URL, DEPLOYER_KEY) and writes deployments/sepolia.json.

import { mkdtempSync, rmSync, readFileSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadKitConfig, listTemplateFiles, DEFAULT_TEMPLATE_DIR } from './lib/config.mjs';
import { ensureBuilt } from './lib/artifacts.mjs';
import { loadEnv, resolveNetwork, startAnvil, NetworkError, SEPOLIA_CHAIN_ID } from './lib/network.mjs';
import { createContext, withDeployment, readDeployment } from './lib/context.mjs';
import { ROOT, DEPLOYMENTS_DIR } from './lib/paths.mjs';
import * as kit from './actions/index.mjs';

export const CHECKS = Object.freeze([
  [1, 'One command starts everything locally; one setting switches to Sepolia'],
  [2, 'Issuance and redemption work for all three tokens'],
  [3, 'One credential lets an investor hold the deposit and the fund; the credit note is refused until accreditation is added'],
  [4, 'Revoking a credential blocks the next transfer, with the reason shown by topic'],
  [5, 'A trusted attester can be replaced, leaving an audit trail'],
  [6, 'Issuer controls work: pause, freeze, forced transfer'],
  [7, 'A fourth product needs a new config file and no new code'],
  [8, 'A newcomer can follow the README from a clean checkout'],
]);

/** The shipped demo templates the checks talk about. */
const DEP = 'dDEP';
const MMF = 'dMMF';
const PCN = 'dPCN';
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'templates');

class CheckFailed extends Error {}

function expect(cond, message) {
  if (!cond) throw new CheckFailed(message);
}

/** Fails the check unless the action succeeded. */
function ok(r, what) {
  expect(r && r.ok, `${what} failed: ${r?.message ?? r?.error ?? 'no result'}`);
  return r;
}

/** Fails the check unless the action was refused with `error` (and, if given, exactly these reason topics/status). */
function refused(r, what, error, { topics, status } = {}) {
  expect(r && r.ok === false, `${what} was expected to be refused but succeeded`);
  expect(r.error === error, `${what}: expected ${error}, got ${r.error} (${r.message})`);
  if (topics) {
    const got = r.reasons.map((x) => x.topic).sort().join(',');
    expect(got === [...topics].sort().join(','), `${what}: expected reasons [${topics.join(', ')}], got [${got}]`);
  }
  if (status) expect(r.reasons.length > 0 && r.reasons.every((x) => x.status === status), `${what}: expected every reason ${status}, got ${r.reasons.map((x) => x.text).join(', ')}`);
  return r;
}

function bal(state, investor, symbol) {
  return Number(state.balances[investor][symbol].balance);
}

function cell(state, investor, symbol) {
  return state.matrix[investor][symbol];
}

/** Hash of every source file outside templates/: proves the fourth product changed no code (C2). */
function codeFingerprint() {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(mjs|js|sol|json)$/.test(name)) h.update(p).update(readFileSync(p));
    }
  };
  for (const d of ['app', 'contracts']) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  h.update(readFileSync(path.join(ROOT, 'package.json')));
  return h.digest('hex');
}

/**
 * Runs the whole scenario. Returns {passed, total, checks, lines}; never throws for a failed check.
 * @param {{log?: (line: string) => void, progress?: (msg: string) => void, env?: object}} [o]
 */
export async function runScenario({ log = console.log, progress = () => {}, env = loadEnv() } = {}) {
  const results = [];
  const lines = [];
  const emit = (n, title, passed, detail, partial = false) => {
    const line = `${passed ? 'PASS' : 'FAIL'} ${n}${partial && passed ? ' (partial)' : ''} ${title}${detail ? ` - ${detail}` : ''}`;
    results.push({ n, title, passed, partial, detail });
    lines.push(line);
    log(line);
  };

  const castKit = loadKitConfig();
  const settings = resolveNetwork({ env, kit: castKit });
  ensureBuilt({ log: progress });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'eea-kit-scenario-'));
  let anvil = null;
  let ctx = null;
  let ctx4 = null;
  const failed = new Set();

  const run = async (n, deps, fn) => {
    const [, title] = CHECKS[n - 1];
    const missing = deps.filter((d) => failed.has(d));
    if (missing.length) {
      failed.add(n);
      return emit(n, title, false, `not run: check ${missing.join(', ')} failed`);
    }
    progress(`check ${n}: ${title}`);
    try {
      const r = await fn();
      emit(n, title, true, r?.detail ?? r, r?.partial);
    } catch (e) {
      failed.add(n);
      emit(n, title, false, e instanceof CheckFailed ? e.message : `error: ${e.shortMessage ?? e.message}`);
    }
  };

  try {
    // ============ 1. Start: deploy every template, seed W1 + W2; Sepolia settings resolve without sending ============
    await run(1, [], async () => {
      const started = Date.now();
      let rpcUrl = settings.rpcUrl;
      if (settings.network === 'local') {
        anvil = await startAnvil({ accounts: settings.accountCount, log: progress }); // own chain, random free port
        rpcUrl = anvil.url;
      }
      const deploymentFile = settings.network === 'sepolia' ? path.join(DEPLOYMENTS_DIR, 'sepolia.json') : path.join(tmp, 'local.json');
      ctx = await createContext({ env, rpcUrl, kit: castKit, deploymentFile, loadDeployment: false, log: progress });
      const templateCount = listTemplateFiles([DEFAULT_TEMPLATE_DIR]).length;
      const d = await kit.deploy(ctx, { templateDirs: [DEFAULT_TEMPLATE_DIR] });
      expect(d.tokens.length === templateCount, `expected ${templateCount} tokens, deployed ${d.tokens.length}`);
      for (const t of d.tokens) {
        const code = await ctx.publicClient.getCode({ address: t.address });
        expect(code && code.length > 2, `${t.symbol} has no code at ${t.address}`);
      }
      const record = readDeployment(deploymentFile);
      expect(record.chainId === ctx.chainId && record.tokens.length === templateCount, 'deployment record does not match the chain');
      for (const sym of [DEP, MMF, PCN]) expect(d.tokens.some((t) => t.symbol === sym), `template ${sym} missing from templates/`);

      // W1: the operator authorizes KYC provider A; every template lists it.
      const w1 = ok(await kit.authorizeProvider(ctx, { provider: 'kyc-provider-a' }), 'W1 authorize kyc-provider-a');
      expect(w1.trusted.length === templateCount, `kyc-provider-a trusted on ${w1.trusted.length} of ${templateCount} tokens`);
      // W2: one credential each for Alice, Bob and Dave. Carol gets nothing.
      for (const inv of ['alice', 'bob', 'dave']) ok(await kit.onboardInvestor(ctx, { actor: 'kyc-provider-a', investor: inv }), `W2 onboard ${inv}`);

      // One setting switches to Sepolia: resolve its settings (dry check, nothing sent, no network I/O).
      const key = generatePrivateKey(); // throwaway key, never printed
      const sepoliaEnv = { NETWORK: 'sepolia', RPC_URL: 'https://sepolia.rpc.invalid/v1/demo', DEPLOYER_KEY: key };
      const s1 = resolveNetwork({ env: sepoliaEnv, kit: castKit });
      const s2 = resolveNetwork({ env: sepoliaEnv, kit: castKit });
      expect(s1.network === 'sepolia' && s1.expectedChainId === SEPOLIA_CHAIN_ID, 'NETWORK=sepolia did not resolve to chain id 11155111');
      expect(s1.rpcUrl === sepoliaEnv.RPC_URL && !s1.startLocalChain, 'NETWORK=sepolia must use RPC_URL and start no local chain');
      expect(s1.eas?.eas && s1.eas?.schemaRegistry, 'NETWORK=sepolia must reuse the public EAS (decision D5)');
      expect(s1.accounts.operator.address === privateKeyToAccount(key).address, 'the operator must be DEPLOYER_KEY');
      const addrs = Object.values(s1.accounts).map((a) => a.address);
      expect(new Set(addrs).size === addrs.length, 'derived Sepolia actors must be distinct');
      expect(Object.keys(s1.accounts).every((id) => s1.accounts[id].address === s2.accounts[id].address), 'derived Sepolia actors must be deterministic');
      let missingVars = null;
      try {
        resolveNetwork({ env: { NETWORK: 'sepolia' }, kit: castKit });
      } catch (e) {
        missingVars = e;
      }
      expect(missingVars instanceof NetworkError && /RPC_URL/.test(missingVars.message) && /DEPLOYER_KEY/.test(missingVars.message), 'NETWORK=sepolia without RPC_URL/DEPLOYER_KEY must stop with a clear message');

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      return `${settings.network === 'local' ? 'own local chain, ' : ''}${templateCount} tokens (${d.tokens.map((t) => t.symbol).join(', ')}) deployed and seeded in ${secs} s; NETWORK=sepolia resolves to chain id ${SEPOLIA_CHAIN_ID}, the public EAS and ${addrs.length} derived actors without sending anything`;
    });

    // ============ 2. W3 + W5 on every token ============
    await run(2, [1], async () => {
      const done = [];
      for (const t of ctx.deployment.tokens) {
        const s0 = await kit.getState(ctx, { audit: false });
        const supply0 = Number(s0.tokens.find((x) => x.symbol === t.symbol).totalSupply);
        ok(await kit.issue(ctx, { token: t.symbol, to: 'bob', amount: '100' }), `issue 100 ${t.symbol} to Bob`);
        const s1 = await kit.getState(ctx, { audit: false });
        expect(bal(s1, 'bob', t.symbol) === bal(s0, 'bob', t.symbol) + 100, `${t.symbol}: Bob's balance did not rise by 100`);
        expect(Number(s1.tokens.find((x) => x.symbol === t.symbol).totalSupply) === supply0 + 100, `${t.symbol}: supply did not rise by 100`);
        ok(await kit.redeem(ctx, { token: t.symbol, from: 'bob', amount: '40' }), `redeem 40 ${t.symbol} from Bob`);
        const s2 = await kit.getState(ctx, { audit: false });
        expect(bal(s2, 'bob', t.symbol) === bal(s0, 'bob', t.symbol) + 60, `${t.symbol}: Bob's balance did not fall by 40`);
        expect(Number(s2.tokens.find((x) => x.symbol === t.symbol).totalSupply) === supply0 + 60, `${t.symbol}: supply did not fall by 40`);
        done.push(t.symbol);
      }
      const trail = await kit.auditTrail(ctx);
      for (const sym of done) {
        expect(trail.some((e) => e.action === 'Issued' && e.token === sym), `audit trail lacks Issued on ${sym}`);
        expect(trail.some((e) => e.action === 'Redeemed' && e.token === sym), `audit trail lacks Redeemed on ${sym}`);
      }
      return `issued 100 and redeemed 40 on ${done.join(', ')}; balances, supply and the audit trail moved as expected`;
    });

    // ============ 3. I1 cast table + I2 one credential, refused credit note until accreditation ============
    await run(3, [1], async () => {
      const s = await kit.getState(ctx, { audit: false });
      const expected = {
        alice: { [DEP]: [], [MMF]: [], [PCN]: ['ACCREDITATION'] },
        bob: { [DEP]: [], [MMF]: [], [PCN]: [] },
        carol: { [DEP]: ['KYC', 'SANCTIONS'], [MMF]: ['KYC', 'AML', 'COUNTRY'], [PCN]: ['KYC', 'ACCREDITATION', 'COUNTRY'] },
        dave: { [DEP]: [], [MMF]: ['COUNTRY'], [PCN]: ['ACCREDITATION', 'COUNTRY'] },
      };
      for (const [inv, row] of Object.entries(expected)) {
        for (const [sym, topics] of Object.entries(row)) {
          const c = cell(s, inv, sym);
          expect(c.eligible === (topics.length === 0), `cast table: ${inv} on ${sym} should be ${topics.length ? 'no' : 'yes'}`);
          const got = c.reasons.map((r) => r.topic).sort().join(',');
          expect(got === [...topics].sort().join(','), `cast table: ${inv} on ${sym} reasons [${got}], expected [${topics.join(', ')}]`);
        }
      }
      expect(cell(s, 'carol', DEP).reasons.some((r) => r.text === 'KYC: no credential'), 'Carol should show "KYC: no credential"');

      ok(await kit.issue(ctx, { token: DEP, to: 'alice', amount: '100' }), 'issue dDEP to Alice');
      ok(await kit.issue(ctx, { token: MMF, to: 'alice', amount: '100' }), 'issue dMMF to Alice');
      const r = refused(await kit.issue(ctx, { token: PCN, to: 'alice', amount: '50' }), 'issue dPCN to Alice', 'ERC7943CannotReceive', {
        topics: ['ACCREDITATION'],
        status: 'POLICY_REJECTED',
      });
      expect(r.reasons[0].text === 'accreditation: policy rejected', `reason text was "${r.reasons[0].text}"`);
      expect(r.accountId === 'alice', 'the refusal must name Alice');

      ok(await kit.onboardInvestor(ctx, { actor: 'kyc-provider-a', investor: 'alice', credential: { accreditationType: 2 } }), 'updated credential for Alice');
      ok(await kit.issue(ctx, { token: PCN, to: 'alice', amount: '50' }), 'issue dPCN to Alice after accreditation');
      const s2 = await kit.getState(ctx, { audit: false });
      for (const sym of [DEP, MMF, PCN]) expect(cell(s2, 'alice', sym).eligible, `Alice should hold ${sym} now`);
      expect(bal(s2, 'alice', DEP) >= 100 && bal(s2, 'alice', MMF) >= 100 && bal(s2, 'alice', PCN) === 50, 'Alice balances wrong');
      return `cast table holds (4 investors x 3 tokens); Alice holds ${DEP} and ${MMF} on one credential, ${PCN} refused ("${r.reasons[0].text}") until an updated credential, then issued`;
    });

    // ============ 4. W6 revoke -> next transfer refused, reason by topic, on every token ============
    await run(4, [1, 3], async () => {
      const rv = ok(await kit.revokeCredential(ctx, { investor: 'alice' }), 'revoke Alice');
      expect(rv.actor === 'kyc-provider-a', `revocation should be signed by the attester, was ${rv.actor}`);
      const texts = [];
      for (const t of ctx.deployment.tokens) {
        const r = refused(await kit.transfer(ctx, { actor: 'alice', token: t.symbol, to: 'bob', amount: '1' }), `Alice transfer ${t.symbol}`, 'ERC7943CannotSend', {
          status: 'REVOKED',
        });
        expect(r.reasons.some((x) => x.topic === 'KYC' && x.text === 'KYC: revoked'), `${t.symbol}: no "KYC: revoked" reason`);
        texts.push(`${t.symbol} (${r.reasons.map((x) => x.text).join(', ')})`);
      }
      const s = await kit.getState(ctx);
      for (const t of ctx.deployment.tokens) expect(!cell(s, 'alice', t.symbol).eligible, `Alice still eligible on ${t.symbol}`);
      expect(s.auditTrail.some((e) => e.action === 'Credential revoked' && e.actorId === 'kyc-provider-a'), 'audit trail lacks the revocation');
      return `after revocation every transfer from Alice was refused: ${texts.join('; ')}`;
    });

    // ============ 5. W7 replace provider A by B, with an audit trail ============
    await run(5, [1], async () => {
      const from = (await kit.getState(ctx, { audit: false })).blockNumber;
      // I6: a provider cannot authorize itself; only the operator (resolver authorizer) can.
      refused(await kit.authorizeProvider(ctx, { actor: 'kyc-provider-b', provider: 'kyc-provider-b' }), 'self-authorization of provider B', 'InvalidAttestation');

      const r = ok(await kit.replaceAttester(ctx, { from: 'kyc-provider-a', to: 'kyc-provider-b' }), 'replace A by B');
      const n = ctx.deployment.tokens.length;
      expect(r.removed.length === n && r.authorization.trusted.length === n, `A removed on ${r.removed.length}, B trusted on ${r.authorization.trusted.length} of ${n}`);
      const re = r.reattested.map((x) => x.investor).sort().join(',');
      expect(re === 'bob,dave', `B should re-attest Bob and Dave (Alice is revoked), re-attested: ${re}`);
      for (const t of ctx.deployment.tokens) {
        expect(r.eligibility.before.bob[t.symbol] && !r.eligibility.afterRemoval.bob[t.symbol] && r.eligibility.after.bob[t.symbol], `Bob should drop out and return on ${t.symbol}`);
      }
      const s = await kit.getState(ctx);
      for (const t of s.tokens) {
        const names = t.trustedAttesters.map((a) => a.id).join(',');
        expect(names === 'kyc-provider-b', `${t.symbol} trusts [${names}], expected [kyc-provider-b]`);
      }
      const trail = s.auditTrail.filter((e) => e.block > from);
      const count = (pred) => trail.filter(pred).length;
      expect(count((e) => e.action === 'Attester removed' && /KYC Provider A/.test(e.detail) && e.actorId === 'operator') === n, 'audit trail: A removal missing on some token');
      expect(count((e) => e.action === 'Provider authorized' && e.actorId === 'operator' && /KYC Provider B/.test(e.detail)) === 1, 'audit trail: operator authorization of B missing');
      expect(count((e) => e.action === 'Attester trusted' && /KYC Provider B/.test(e.detail)) === n, 'audit trail: B trusted missing on some token');
      expect(count((e) => e.action === 'Credential issued' && e.actorId === 'kyc-provider-b') === 2, 'audit trail: re-attestations by B missing');
      ok(await kit.transfer(ctx, { actor: 'bob', token: DEP, to: 'dave', amount: '5' }), 'Bob transfer after rotation');
      return `A removed and B trusted on ${n} tokens, Bob and Dave re-attested by B (dropped out, then returned); provider self-authorization refused; ${trail.length} audit entries name who authorized whom`;
    });

    // ============ 6. W8 freeze, forced transfer, pause ============
    await run(6, [1, 5], async () => {
      ok(await kit.issue(ctx, { token: DEP, to: 'bob', amount: '100' }), 'top up Bob');
      const s0 = await kit.getState(ctx, { audit: false });
      const b0 = bal(s0, 'bob', DEP);
      const dave0 = bal(s0, 'dave', DEP);
      // U3 freeze: everything but 10 units.
      ok(await kit.freeze(ctx, { token: DEP, account: 'bob', amount: String(b0 - 10) }), 'freeze Bob');
      refused(await kit.transfer(ctx, { actor: 'bob', token: DEP, to: 'dave', amount: '20' }), 'transfer above the unfrozen balance', 'ERC7943InsufficientUnfrozenBalance');
      ok(await kit.transfer(ctx, { actor: 'bob', token: DEP, to: 'dave', amount: '10' }), 'transfer within the unfrozen balance');
      // U4 forced transfer: moves frozen units and unfreezes what it moves; refuses an ineligible recipient.
      ok(await kit.forcedTransfer(ctx, { token: DEP, from: 'bob', to: 'dave', amount: '30' }), 'forced transfer Bob -> Dave');
      const s1 = await kit.getState(ctx, { audit: false });
      expect(bal(s1, 'bob', DEP) === b0 - 40, 'forced transfer did not move 30 from Bob');
      expect(Number(s1.balances.bob[DEP].frozen) === b0 - 40, `frozen should drop to ${b0 - 40}, is ${s1.balances.bob[DEP].frozen}`);
      refused(await kit.forcedTransfer(ctx, { token: DEP, from: 'bob', to: 'carol', amount: '1' }), 'forced transfer to Carol', 'ERC7943CannotReceive', { topics: ['KYC', 'SANCTIONS'] });
      // Only compliance may pause.
      const nr = refused(await kit.pause(ctx, { actor: 'issuer', token: DEP }), 'pause by the issuer', 'AccessControlUnauthorizedAccount');
      expect(nr.role === 'COMPLIANCE_ROLE', `expected missing COMPLIANCE_ROLE, got ${nr.role}`);
      // U5 pause stops transfer and issue; forced transfer still works; unpause restores.
      ok(await kit.pause(ctx, { token: DEP }), 'pause');
      refused(await kit.transfer(ctx, { actor: 'dave', token: DEP, to: 'bob', amount: '1' }), 'transfer while paused', 'EnforcedPause');
      refused(await kit.issue(ctx, { token: DEP, to: 'bob', amount: '1' }), 'issue while paused', 'EnforcedPause');
      ok(await kit.forcedTransfer(ctx, { token: DEP, from: 'dave', to: 'bob', amount: '1' }), 'forced transfer while paused');
      ok(await kit.unpause(ctx, { token: DEP }), 'unpause');
      ok(await kit.transfer(ctx, { actor: 'dave', token: DEP, to: 'bob', amount: '1' }), 'transfer after unpause');
      ok(await kit.freeze(ctx, { token: DEP, account: 'bob', amount: '0' }), 'unfreeze Bob');
      const s2 = await kit.getState(ctx);
      expect(bal(s2, 'dave', DEP) === dave0 + 10 + 30 - 1 - 1, 'Dave balance wrong after the controls');
      for (const a of ['Frozen', 'Forced transfer', 'Paused', 'Unpaused']) {
        expect(s2.auditTrail.some((e) => e.action === a && e.token === DEP && e.actorId === 'compliance'), `audit trail lacks ${a} by the compliance officer`);
      }
      return `on ${DEP}: freeze refused a transfer above the unfrozen balance; forced transfer moved frozen units and unfroze them, refused Carol (KYC); pause stopped transfer and issue but not forced transfer; only compliance may pause`;
    });

    // ============ 7. C2 / W9 a fourth template, no code change ============
    await run(7, [1], async () => {
      const before = codeFingerprint();
      const dir = path.join(tmp, 'templates');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir);
      const shipped = listTemplateFiles([DEFAULT_TEMPLATE_DIR]);
      const fixtures = listTemplateFiles([FIXTURE_DIR]);
      expect(fixtures.length === 1, `expected one fixture template, found ${fixtures.length}`);
      for (const f of [...shipped, ...fixtures]) copyFileSync(f, path.join(dir, path.basename(f)));
      const fourth = JSON.parse(readFileSync(fixtures[0], 'utf8'));

      ctx4 = withDeployment(ctx, null);
      const d = await kit.deploy(ctx4, { templateDirs: [dir], outFile: path.join(tmp, 'fourth.json') });
      expect(d.tokens.length === shipped.length + 1, `expected ${shipped.length + 1} tokens, got ${d.tokens.length}`);
      const t = d.tokens.find((x) => x.symbol === fourth.symbol);
      expect(t, `the fourth token ${fourth.symbol} was not deployed`);
      for (const p of fourth.trustedAttesters) ok(await kit.authorizeProvider(ctx4, { provider: p }), `authorize ${p} on the new deployment`);
      ok(await kit.onboardInvestor(ctx4, { actor: fourth.trustedAttesters[0], investor: 'bob' }), 'onboard Bob');
      ok(await kit.issue(ctx4, { token: fourth.symbol, to: 'bob', amount: '25' }), `issue ${fourth.symbol} to Bob`);
      const r = refused(await kit.issue(ctx4, { token: fourth.symbol, to: 'carol', amount: '1' }), `issue ${fourth.symbol} to Carol`, 'ERC7943CannotReceive');
      expect(r.reasons.some((x) => x.text === 'KYC: no credential'), 'Carol should be refused for KYC');
      ok(await kit.redeem(ctx4, { token: fourth.symbol, from: 'bob', amount: '5' }), `redeem ${fourth.symbol}`);
      const s = await kit.getState(ctx4);
      expect(s.tokens.length === shipped.length + 1, 'getState should list four tokens');
      expect(s.balances.bob[fourth.symbol].balance === '20', `Bob should hold 20 ${fourth.symbol}`);
      expect(codeFingerprint() === before, 'code changed while adding the fourth product');
      return `${fourth.symbol} (${path.relative(ROOT, fixtures[0])}) deployed next to the shipped templates; issue, refusal (KYC: no credential) and redeem work; app/, contracts/ and package.json unchanged`;
    });

    // ============ 8. README path (partial: the human dry run cannot be scripted) ============
    await run(8, [], async () => {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const scripts = pkg.scripts ?? {};
      const readme = existsSync(path.join(ROOT, 'README.md')) ? readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
      const documented = new Set(['start', 'scenario']);
      for (const m of readme.matchAll(/\bnpm\s+(?:run\s+([\w:.-]+)|(start|test))\b/g)) documented.add(m[1] ?? m[2]);
      const missing = [...documented].filter((s) => !scripts[s]);
      expect(missing.length === 0, `package.json lacks scripts the README relies on: ${missing.join(', ')}`);
      return {
        partial: true,
        detail: `the commands it relies on exist in package.json (${[...documented].map((s) => (s === 'start' || s === 'test' ? `npm ${s}` : `npm run ${s}`)).join(', ')}); the dry run by a newcomer is a human step a script cannot do`,
      };
    });
  } finally {
    if (anvil) await anvil.stop();
    rmSync(tmp, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const summary = `${passed} of ${CHECKS.length}`;
  lines.push(summary);
  log(summary);
  return { passed, total: CHECKS.length, checks: results, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const verbose = process.env.VERBOSE === '1';
  runScenario({ progress: verbose ? (m) => console.error(`  ... ${m}`) : () => {} }).then(
    (r) => process.exit(r.passed === r.total ? 0 : 1),
    (e) => {
      console.error(e.stack ?? e.message);
      process.exit(1);
    },
  );
}
