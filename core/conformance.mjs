// Interlock conformance suites (issue #5, S5): checks anyone can run against THEIR OWN contracts, read-only, with an
// Ethereum JSON-RPC URL and an address. No keys, no deployment of ours needed.
//
//   erc7943(client, token)              an ERC-7943 fungible token: interface id, and views that never revert
//   eligibility(client, slot, expect?)  an Interlock IEligibility slot: never reverts, fails closed, explain agrees
//
// Each returns {passed, total, checks: [{id, title, ok, detail}]}. npm run conformance -- --help for the CLI.
// The acceptance scenario for whole deployments is examples/scenario.mjs (npm run scenario).

import { createPublicClient, http, parseAbi, toFunctionSelector, getAddress, isAddress, keccak256, toHex, zeroAddress } from 'viem';

export const ERC7943_INTERFACE_ID = '0x3edbb4c4';
const ERC165_INTERFACE_ID = '0x01ffc9a7';

/** The six ERC-7943 fungible functions; the interface id is the XOR of their selectors. */
export const ERC7943_FUNCTIONS = Object.freeze([
  'function canSend(address account) view returns (bool)',
  'function canReceive(address account) view returns (bool)',
  'function canTransfer(address from, address to, uint256 amount) view returns (bool)',
  'function getFrozenTokens(address account) view returns (uint256)',
  'function setFrozenTokens(address account, uint256 amount) returns (bool)',
  'function forcedTransfer(address from, address to, uint256 amount) returns (bool)',
]);

const ERC7943_ABI = parseAbi([...ERC7943_FUNCTIONS, 'function supportsInterface(bytes4 interfaceId) view returns (bool)', 'function balanceOf(address) view returns (uint256)']);

/** Interlock's IEligibility (contracts/interfaces/IEligibility.sol). */
export const ELIGIBILITY_ABI = parseAbi([
  'function isEligible(address wallet) view returns (bool)',
  'struct TopicStatus { uint256 topic; uint8 status; }',
  'function explain(address wallet) view returns (TopicStatus[])',
]);
const STATUS_COUNT = 8;

export function interfaceIdOf(signatures) {
  let id = 0;
  for (const s of signatures) id ^= Number.parseInt(toFunctionSelector(s).slice(2), 16);
  return `0x${(id >>> 0).toString(16).padStart(8, '0')}`;
}

/** Deterministic "strangers": addresses nobody holds a credential for. */
function strangers(n = 3) {
  return Array.from({ length: n }, (_, i) => getAddress(`0x${keccak256(toHex(`interlock conformance stranger ${i}`)).slice(26)}`));
}

function suite() {
  const checks = [];
  const check = async (id, title, fn) => {
    try {
      const r = await fn();
      checks.push({ id, title, ok: r === true || r?.ok === true, detail: typeof r === 'object' ? r.detail ?? '' : '' });
    } catch (e) {
      checks.push({ id, title, ok: false, detail: e.shortMessage ?? e.message });
    }
  };
  const result = () => ({ passed: checks.filter((c) => c.ok).length, total: checks.length, checks });
  return { check, result };
}

async function noRevert(fn, label) {
  try {
    await fn();
    return null;
  } catch (e) {
    return `${label} reverted: ${e.shortMessage ?? e.message}`.split('\n')[0];
  }
}

/** ERC-7943 (fungible) conformance of `token`. Read-only. */
export async function erc7943(client, token) {
  const { check, result } = suite();
  const read = (functionName, args = []) => client.readContract({ address: token, abi: ERC7943_ABI, functionName, args });
  const who = [zeroAddress, getAddress(token), ...strangers()];

  await check('T1', `the interface id of the six functions is ${ERC7943_INTERFACE_ID}`, () => ({ ok: interfaceIdOf(ERC7943_FUNCTIONS) === ERC7943_INTERFACE_ID, detail: interfaceIdOf(ERC7943_FUNCTIONS) }));
  await check('T2', `supportsInterface(${ERC7943_INTERFACE_ID}) is true`, async () => (await read('supportsInterface', [ERC7943_INTERFACE_ID])) === true);
  await check('T3', `supportsInterface(${ERC165_INTERFACE_ID}) is true (ERC-165)`, async () => (await read('supportsInterface', [ERC165_INTERFACE_ID])) === true);
  await check('T4', 'supportsInterface(0xffffffff) is false (ERC-165)', async () => (await read('supportsInterface', ['0xffffffff'])) === false);
  await check('T5', 'canSend and canReceive never revert (zero address, the token itself, strangers)', async () => {
    const errs = [];
    for (const a of who) {
      for (const f of ['canSend', 'canReceive']) {
        const e = await noRevert(() => read(f, [a]), `${f}(${a})`);
        if (e) errs.push(e);
      }
    }
    return { ok: errs.length === 0, detail: errs.join('; ') };
  });
  await check('T6', 'canTransfer never reverts, including for amounts that cannot be met', async () => {
    const errs = [];
    for (const amount of [0n, 1n, 2n ** 255n, 2n ** 256n - 1n]) {
      const e = await noRevert(() => read('canTransfer', [who[2], who[3], amount]), `canTransfer(..., ${amount})`);
      if (e) errs.push(e);
    }
    return { ok: errs.length === 0, detail: errs.join('; ') };
  });
  await check('T7', 'getFrozenTokens never reverts', async () => {
    const errs = [];
    for (const a of who) {
      const e = await noRevert(() => read('getFrozenTokens', [a]), `getFrozenTokens(${a})`);
      if (e) errs.push(e);
    }
    return { ok: errs.length === 0, detail: errs.join('; ') };
  });
  await check('T8', 'canTransfer is false when the sender has no unfrozen balance for the amount', async () => {
    const s = strangers(1)[0];
    const bal = await read('balanceOf', [s]).catch(() => 0n);
    const frozen = await read('getFrozenTokens', [s]);
    const unfrozen = bal > frozen ? bal - frozen : 0n;
    return { ok: (await read('canTransfer', [s, strangers(2)[1], unfrozen + 1n])) === false, detail: `unfrozen ${unfrozen}` };
  });
  return result();
}

/**
 * Conformance of an IEligibility slot. `expect` (optional): {wallet: true|false} the slot must answer.
 * Read-only.
 */
export async function eligibility(client, slot, expect = {}) {
  const { check, result } = suite();
  const isEl = (w) => client.readContract({ address: slot, abi: ELIGIBILITY_ABI, functionName: 'isEligible', args: [w] });
  const expl = (w) => client.readContract({ address: slot, abi: ELIGIBILITY_ABI, functionName: 'explain', args: [w] });
  const s = strangers();
  const wallets = [...new Set([zeroAddress, getAddress(slot), ...s, ...Object.keys(expect).map((w) => getAddress(w))])];

  await check('E1', 'isEligible and explain never revert (zero address, the slot itself, strangers, expected wallets)', async () => {
    const errs = [];
    for (const w of wallets) {
      for (const [f, fn] of [['isEligible', isEl], ['explain', expl]]) {
        const e = await noRevert(() => fn(w), `${f}(${w})`);
        if (e) errs.push(e);
      }
    }
    return { ok: errs.length === 0, detail: errs.join('; ') };
  });
  await check('E2', 'fails closed: a stranger with no credential is not eligible', async () => {
    const yes = [];
    for (const w of [zeroAddress, ...s]) if (await isEl(w)) yes.push(w);
    return { ok: yes.length === 0, detail: yes.length ? `eligible: ${yes.join(', ')}` : '' };
  });
  await check('E3', 'explain reports at least one topic, with a known status', async () => {
    const bad = [];
    for (const w of wallets) {
      const rows = await expl(w);
      if (!rows.length) bad.push(`${w}: no topics`);
      for (const r of rows) if (Number(r.status) >= STATUS_COUNT) bad.push(`${w}: status ${r.status}`);
    }
    return { ok: bad.length === 0, detail: bad.join('; ') };
  });
  await check('E4', 'explain agrees with isEligible: eligible exactly when every topic is OK', async () => {
    const bad = [];
    for (const w of wallets) {
      const [el, rows] = await Promise.all([isEl(w), expl(w)]);
      const allOk = rows.length > 0 && rows.every((r) => Number(r.status) === 0);
      if (el !== allOk) bad.push(`${w}: isEligible ${el}, explain ${allOk ? 'all OK' : 'not all OK'}`);
    }
    return { ok: bad.length === 0, detail: bad.join('; ') };
  });
  if (Object.keys(expect).length) {
    await check('E5', 'answers what the expectations file says', async () => {
      const bad = [];
      for (const [w, want] of Object.entries(expect)) if ((await isEl(getAddress(w))) !== want) bad.push(`${w}: expected ${want}`);
      return { ok: bad.length === 0, detail: bad.join('; ') };
    });
  }
  return result();
}

export function report(name, r, log = console.log) {
  for (const c of r.checks) log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} ${c.title}${c.detail ? ` - ${c.detail}` : ''}`);
  log(`${name}: ${r.passed} of ${r.total}`);
  return r.passed === r.total;
}

export function clientFor(rpcUrl) {
  return createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 30_000 }) });
}

export function parseArgs(argv) {
  const [suiteName, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    opts[k.slice(2)] = rest[i + 1];
    i++;
  }
  for (const k of ['token', 'slot']) if (opts[k] && !isAddress(opts[k], { strict: false })) throw new Error(`--${k} must be an address`);
  return { suite: suiteName, opts };
}
