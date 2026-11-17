// Sending transactions and turning on-chain refusals into plain data.
// A refused action never throws: it is simulated first, the revert is decoded by name against every
// kit ABI, and the result is {ok:false, error, ..., reasons:[{topic, status, text}]}.

import { decodeErrorResult, formatUnits, parseEther, BaseError, keccak256, toHex, getAddress } from 'viem';
import { MAINNET_CHAIN_ID, MainnetRefusedError, NetworkError } from './network.mjs';
import { describeTopicStatus } from './topics.mjs';
import { nameOf, idOf, getActor } from './context.mjs';

/** On Sepolia, actors other than the operator get topped up from the operator when they run low. */
const SEPOLIA_MIN_BALANCE = parseEther('0.003');
const SEPOLIA_TOP_UP = parseEther('0.01');

export class TxError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TxError';
    Object.assign(this, details);
  }
}

const ROLE_NAMES = new Map(
  [
    ['DEFAULT_ADMIN_ROLE', '0x0000000000000000000000000000000000000000000000000000000000000000'],
    ['ISSUER_ROLE', keccak256(toHex('ISSUER_ROLE'))],
    ['COMPLIANCE_ROLE', keccak256(toHex('COMPLIANCE_ROLE'))],
    ['OPERATOR_ROLE', keccak256(toHex('OPERATOR_ROLE'))],
  ].map(([n, h]) => [h, n]),
);

/** Converts bigint values (deeply) to decimal strings so results are JSON-safe. */
export function jsonSafe(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}

/**
 * C3 guard, run right before every signature: reads the chain id from the endpoint again and refuses chain id 1
 * (and any change since connecting). viem also re-checks the chain id inside every send.
 */
async function assertSendAllowed(ctx) {
  if (Number(ctx.chainId) === MAINNET_CHAIN_ID || Number(ctx.chain?.id) === MAINNET_CHAIN_ID) throw new MainnetRefusedError(ctx.rpcUrl);
  const now = await ctx.publicClient.getChainId();
  if (now === MAINNET_CHAIN_ID) throw new MainnetRefusedError(ctx.rpcUrl);
  if (now !== ctx.chainId) throw new NetworkError(`the endpoint changed chain id from ${ctx.chainId} to ${now}; refusing to sign`);
}

/** Finds the raw revert data in a viem error chain, or null when it is not a revert. */
export function revertDataOf(err) {
  let data = null;
  let reverted = false;
  const visit = (e) => {
    if (!e || typeof e !== 'object') return;
    const n = e.name ?? '';
    if (/Revert|ExecutionReverted|RawContractError/.test(n)) reverted = true;
    if (typeof e.raw === 'string' && e.raw.startsWith('0x') && e.raw.length >= 10) data ??= e.raw;
    if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length >= 10) data ??= e.data;
    if (e.data && typeof e.data.data === 'string' && e.data.data.startsWith('0x')) data ??= e.data.data;
  };
  if (err instanceof BaseError) {
    err.walk((e) => {
      visit(e);
      return false;
    });
  }
  let e = err;
  for (let i = 0; e && i < 10; i++, e = e.cause) visit(e);
  const msg = String(err?.message ?? '');
  if (/execution reverted|reverted/i.test(msg)) reverted = true;
  return { reverted: reverted || data !== null, data };
}

/** Decodes revert data against every kit error. Returns {error, args}. */
export function decodeRevert(ctx, data) {
  if (!data || data === '0x') return { error: 'Reverted', args: {} };
  try {
    const r = decodeErrorResult({ abi: ctx.errorAbi, data });
    const args = {};
    (r.abiItem.inputs ?? []).forEach((inp, i) => {
      args[inp.name || `arg${i}`] = r.args?.[i];
    });
    if (r.errorName === 'Error') return { error: 'Error', args: { reason: r.args?.[0] } };
    if (r.errorName === 'Panic') return { error: 'Panic', args: { code: r.args?.[0] } };
    return { error: r.errorName, args };
  } catch {
    return { error: 'UnknownError', args: { selector: data.slice(0, 10), data } };
  }
}

/** explain(wallet) on a token's eligibility slot: every topic with its status. */
export async function explainFor(ctx, token, wallet) {
  const rows = await ctx.publicClient.readContract({
    address: token.eligibility,
    abi: ctx.abis.ShibuiEligibility,
    functionName: 'explain',
    args: [wallet],
  });
  return rows.map(describeTopicStatus);
}

function fmt(token, raw) {
  return token ? `${formatUnits(BigInt(raw), token.decimals)} ${token.symbol}` : String(raw);
}

/** Builds the {ok:false,...} result for a decoded refusal, adding reasons from explain where they apply. */
export async function buildRefusal(ctx, { error, args }, { token = null, actorId = null } = {}) {
  const out = { ok: false, error, args: jsonSafe(args), reasons: [] };
  const who = (a) => nameOf(ctx, a);
  const sym = token?.symbol ?? 'the token';
  switch (error) {
    case 'ERC7943CannotSend':
    case 'ERC7943CannotReceive': {
      out.account = args.account;
      out.accountId = idOf(ctx, args.account);
      if (token) {
        const all = await explainFor(ctx, token, args.account);
        out.reasons = all.filter((r) => r.status !== 'OK');
      }
      const verb = error === 'ERC7943CannotSend' ? 'send' : 'receive';
      const why = out.reasons.length ? out.reasons.map((r) => r.text).join(', ') : 'not eligible';
      out.message = `Refused: ${who(args.account)} may not ${verb} ${sym} (${why})`;
      break;
    }
    case 'ERC7943CannotTransfer': {
      out.account = args.from;
      out.accountId = idOf(ctx, args.from);
      out.message = `Refused: transfer of ${fmt(token, args.amount)} from ${who(args.from)} to ${who(args.to)} is not allowed`;
      break;
    }
    case 'ERC7943InsufficientUnfrozenBalance': {
      out.account = args.account;
      out.accountId = idOf(ctx, args.account);
      out.message = `Refused: ${who(args.account)} has only ${fmt(token, args.unfrozen)} unfrozen, ${fmt(token, args.amount)} needed`;
      break;
    }
    case 'ERC20InsufficientBalance': {
      out.account = args.sender;
      out.accountId = idOf(ctx, args.sender);
      out.message = `Refused: ${who(args.sender)} holds ${fmt(token, args.balance)}, ${fmt(token, args.needed)} needed`;
      break;
    }
    case 'EnforcedPause':
      out.message = `Refused: ${sym} is paused`;
      break;
    case 'ExpectedPause':
      out.message = `Refused: ${sym} is not paused`;
      break;
    case 'AccessControlUnauthorizedAccount': {
      const role = ROLE_NAMES.get(String(args.neededRole).toLowerCase()) ?? args.neededRole;
      out.account = args.account;
      out.accountId = idOf(ctx, args.account);
      out.role = role;
      out.message = `Refused: ${who(args.account)} does not hold ${role}${token ? ` on ${token.symbol}` : ''}`;
      break;
    }
    case 'OwnableUnauthorizedAccount':
      out.account = args.account;
      out.accountId = idOf(ctx, args.account);
      out.message = `Refused: ${who(args.account)} is not the owner`;
      break;
    case 'InvalidAttestation':
      out.message = 'Refused by EAS: the schema resolver rejected this attestation (only authorizers may authorize a KYC provider)';
      break;
    case 'AccessDenied':
      out.message = 'Refused by EAS: only the original attester may revoke this attestation';
      break;
    case 'AlreadyRevoked':
      out.message = 'Refused by EAS: the attestation is already revoked';
      break;
    case 'Error':
      out.message = `Refused: ${args.reason}`;
      break;
    case 'Panic':
      out.message = `Refused: panic code ${args.code}`;
      break;
    default:
      out.message = `Refused: ${error}`;
  }
  if (actorId) out.actor = actorId;
  return out;
}

/**
 * Simulates, then sends a contract call as `actorId` and waits for the receipt.
 * @returns {Promise<{ok: true, txHash: string, receipt: object} | {ok: false, error: string, ...}>}
 */
export async function sendTx(ctx, actorId, { address, abi, functionName, args = [], value }, { token = null } = {}) {
  const actor = getActor(ctx, actorId);
  const fullAbi = [...abi, ...ctx.errorAbi];
  try {
    await ctx.publicClient.simulateContract({ account: actor.account, address, abi: fullAbi, functionName, args, value });
  } catch (err) {
    const { reverted, data } = revertDataOf(err);
    if (!reverted) throw err;
    return buildRefusal(ctx, decodeRevert(ctx, data), { token, actorId });
  }
  await ensureFunded(ctx, actor);
  await assertSendAllowed(ctx);
  const hash = await actor.wallet.writeContract({ account: actor.account, chain: ctx.chain, address, abi: fullAbi, functionName, args, value });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    return { ok: false, error: 'Reverted', message: `Transaction ${hash} reverted on chain`, txHash: hash, reasons: [], actor: actorId };
  }
  return { ok: true, txHash: hash, receipt };
}

/** Deploys a contract from its artifact as `actorId`. Throws on failure (a deployment is never a "refusal"). */
export async function deployContract(ctx, actorId, artifact, args = []) {
  await assertSendAllowed(ctx);
  const actor = getActor(ctx, actorId);
  const hash = await actor.wallet.deployContract({
    account: actor.account,
    chain: ctx.chain,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new TxError(`deploying ${artifact.name} failed (tx ${hash})`, { txHash: hash });
  }
  return { address: getAddress(receipt.contractAddress), txHash: hash, receipt };
}

/** Like sendTx, but throws a TxError on refusal. For the deployer, where every call must succeed. */
export async function mustSend(ctx, actorId, req, label) {
  const r = await sendTx(ctx, actorId, req);
  if (!r.ok) throw new TxError(`${label ?? req.functionName} was refused: ${r.message}`, { refusal: r });
  return r;
}

/** Sepolia only: keep non-operator actors supplied with a little test ether for gas. */
export async function ensureFunded(ctx, actor) {
  if (ctx.network !== 'sepolia' || actor.id === 'operator') return;
  const balance = await ctx.publicClient.getBalance({ address: actor.address });
  if (balance >= SEPOLIA_MIN_BALANCE) return;
  const op = getActor(ctx, 'operator');
  await assertSendAllowed(ctx);
  ctx.log?.(`Sending ${formatUnits(SEPOLIA_TOP_UP, 18)} test ether to ${actor.name} for gas`);
  const hash = await op.wallet.sendTransaction({ account: op.account, chain: ctx.chain, to: actor.address, value: SEPOLIA_TOP_UP });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
}
