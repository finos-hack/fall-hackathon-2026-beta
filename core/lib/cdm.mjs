// FINOS Common Domain Model (CDM) mapping for Interlock, pinned to CDM 7.10.0 (Python package finos-cdm 7.10.0).
//
// Interlock maps token movements to and from a CDM TransferInstruction: one TransferState per leg, each an
// UnscheduledTransfer of a DigitalAsset (the token, identified by its CAIP-19 address and its symbol) between two
// Parties (identified by their Ethereum address, with the wallet as the account).
//   - In:  a TransferInstruction with two legs and status Instructed drives a DvP settlement (parseTransferInstruction).
//   - Out: the same instruction with status Settled and the settling transaction hash (settledInstruction), and one
//          single-leg TransferInstruction per recorded issuance, transfer, redemption or forced transfer.
// The JSON is in Rune's serialized form ({"@data": ...} for values with metadata, display names for enums) and is
// validated by CDM's own tooling: tools/cdm/validate.py (attribute types and Rune conditions).
// Mapping rules and limits: docs/cdm-mapping.md (generated from MAPPING below).

import { keccak256, toHex, getAddress, isAddress, formatUnits, parseUnits } from 'viem';
import { InputError, tokenByAddress, resolveParty, getToken } from './context.mjs';

export const CDM_VERSION = '7.10.0';
export const CDM_TYPE = 'cdm.event.common.TransferInstruction';

/** The mapping rules, one row per CDM path. docs/cdm-mapping.md is generated from this table. */
export const MAPPING = Object.freeze([
  ['transferState[]', 'One per leg. A DvP settlement has two (delivery, payment); a single token movement has one'],
  ['transferState[].transferStatus', '"Instructed" before settlement; "Settled" once the transaction is mined'],
  ['…transfer.UnscheduledTransfer', 'A token movement is not part of a CDM product schedule, so it is unscheduled'],
  ['…UnscheduledTransfer.asset.DigitalAsset', 'The token. assetType "Other" (a CDM condition for DigitalAsset)'],
  ['…DigitalAsset.identifier[0]', 'CAIP-19 id of the ERC-20 contract, eip155:<chain id>/erc20:<address>; identifierType "Other"'],
  ['…DigitalAsset.identifier[1]', 'The token symbol, identifierType "Name"'],
  ['…UnscheduledTransfer.quantity', 'value: the amount in token units (decimal string); unit.financialUnit "Share"'],
  ['…UnscheduledTransfer.payerReceiver', 'payer and receiver Parties: partyId = Ethereum address, name = cast name; account = the same wallet'],
  ['…UnscheduledTransfer.settlementDate.unadjustedDate', 'The block date (UTC) of settlement, or the intended date when instructed'],
  ['…UnscheduledTransfer.identifier[0]', 'Settled only: the transaction hash, issuer "eip155:<chain id>:tx"'],
  ['(on chain) DvPSettlement ref', 'keccak256 of the canonical JSON of the Instructed TransferInstruction, so the trade on chain points at its CDM record'],
]);

const v = (x) => ({ '@data': x });

/** CAIP-19 asset id of an ERC-20 token. */
export function caip19(chainId, address) {
  return `eip155:${chainId}/erc20:${getAddress(address)}`;
}

function party(ctx, address) {
  const a = ctx.actorByAddress.get(String(address).toLowerCase());
  const addr = getAddress(address);
  return { partyId: [{ identifier: v(addr) }], name: v(a ? a.name : addr) };
}

function account(address) {
  return { accountNumber: v(getAddress(address)), accountName: v('Ethereum wallet') };
}

/**
 * One TransferState for `amountRaw` of token `t` from `from` to `to`.
 * @param {{date: string, status: 'Instructed'|'Settled', txHash?: string}} o
 */
export function transferState(ctx, t, from, to, amountRaw, { date, status, txHash }) {
  const transfer = {
    quantity: { value: formatUnits(BigInt(amountRaw), t.decimals), unit: { financialUnit: 'Share' } },
    asset: {
      DigitalAsset: {
        identifier: [
          { identifier: v(caip19(ctx.chainId, t.address)), identifierType: 'Other' },
          { identifier: v(t.symbol), identifierType: 'Name' },
        ],
        assetType: 'Other',
      },
    },
    settlementDate: { unadjustedDate: date },
    payerReceiver: {
      payerPartyReference: party(ctx, from),
      receiverPartyReference: party(ctx, to),
      payerAccountReference: account(from),
      receiverAccountReference: account(to),
    },
  };
  if (txHash) transfer.identifier = [{ issuer: v(`eip155:${ctx.chainId}:tx`), assignedIdentifier: [{ identifier: v(txHash) }] }];
  return { transfer: { UnscheduledTransfer: transfer }, transferStatus: status };
}

/** A TransferInstruction with the given legs [{token, from, to, amountRaw}]. */
export function transferInstruction(ctx, legs, { date, status = 'Instructed', txHash } = {}) {
  return {
    '@type': CDM_TYPE,
    '@model': 'cdm',
    '@version': CDM_VERSION,
    transferState: legs.map((l) => transferState(ctx, l.token, l.from, l.to, l.amountRaw, { date, status, txHash })),
  };
}

/** The instructed object, marked Settled with the settling transaction hash and date. */
export function settledInstruction(instruction, { txHash, date, chainId }) {
  const out = structuredClone(instruction);
  for (const s of out.transferState) {
    s.transferStatus = 'Settled';
    s.transfer.UnscheduledTransfer.settlementDate = { unadjustedDate: date };
    s.transfer.UnscheduledTransfer.identifier = [{ issuer: v(`eip155:${chainId}:tx`), assignedIdentifier: [{ identifier: v(txHash) }] }];
  }
  return out;
}

/** Canonical JSON (sorted keys, no spaces): the same object always hashes to the same reference. */
export function canonicalJson(x) {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** keccak256 of the canonical JSON: what DvPSettlement stores as the trade's `ref`. */
export function cdmReference(instruction) {
  return keccak256(toHex(canonicalJson(instruction)));
}

const data = (x) => (x && typeof x === 'object' && '@data' in x ? x['@data'] : x);

/**
 * Reads a TransferInstruction (CDM in) into legs the kit can settle. Each leg's token is found by its CAIP-19 id
 * (or, failing that, its symbol); parties by their Ethereum address or cast name.
 * @returns {Array<{token: object, from: {id, name, address}, to: {id, name, address}, amountRaw: bigint, status}>}
 */
export function parseTransferInstruction(ctx, instruction) {
  if (!instruction || typeof instruction !== 'object') throw new InputError('instruction must be a CDM TransferInstruction object');
  if (instruction['@type'] && instruction['@type'] !== CDM_TYPE) throw new InputError(`instruction: expected @type ${CDM_TYPE}, got ${instruction['@type']}`);
  const states = instruction.transferState;
  if (!Array.isArray(states) || states.length === 0) throw new InputError('instruction.transferState must list the legs');
  return states.map((s, i) => {
    const at = `instruction.transferState[${i}]`;
    const u = s?.transfer?.UnscheduledTransfer;
    if (!u) throw new InputError(`${at}.transfer.UnscheduledTransfer is required (Interlock maps token movements to unscheduled transfers)`);
    const ids = u.asset?.DigitalAsset?.identifier ?? [];
    const caip = ids.map((x) => String(data(x.identifier))).find((x) => x.startsWith('eip155:'));
    let token = null;
    if (caip) {
      const m = /^eip155:(\d+)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(caip);
      if (!m) throw new InputError(`${at}: "${caip}" is not a CAIP-19 ERC-20 id`);
      if (Number(m[1]) !== Number(ctx.chainId)) throw new InputError(`${at}: the asset is on chain ${m[1]}, this context is chain ${ctx.chainId}`);
      token = tokenByAddress(ctx, m[2]);
    }
    if (!token) {
      const name = ids.find((x) => x.identifierType === 'Name');
      token = name ? getToken(ctx, String(data(name.identifier))) : null;
    }
    if (!token) throw new InputError(`${at}: no token of this deployment matches the asset`);
    const who = (ref, field) => {
      const id = data(ref?.partyId?.[0]?.identifier);
      if (typeof id !== 'string') throw new InputError(`${at}.payerReceiver.${field}: partyId is required`);
      return resolveParty(ctx, isAddress(id, { strict: false }) ? getAddress(id) : id, field);
    };
    const from = who(u.payerReceiver?.payerPartyReference, 'payerPartyReference');
    const to = who(u.payerReceiver?.receiverPartyReference, 'receiverPartyReference');
    const value = String(u.quantity?.value ?? '');
    if (!/^\d+(\.\d+)?$/.test(value)) throw new InputError(`${at}.quantity.value must be a positive decimal`);
    const amountRaw = parseUnits(value, token.decimals);
    if (amountRaw <= 0n) throw new InputError(`${at}.quantity.value must be greater than zero`);
    return { token, from, to, amountRaw, status: s.transferStatus ?? null };
  });
}

/** UTC date (YYYY-MM-DD) of a unix time in seconds. */
export function isoDate(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/**
 * CDM out for one recorded token movement (story F): a single-leg TransferInstruction, Settled.
 * Issuance is paid by the token's issuer to the holder; redemption by the holder to the issuer.
 * @param {{action: 'issue'|'transfer'|'redeem'|'forcedTransfer', token: object, from: string, to: string,
 *          amountRaw: bigint|string, txHash: string, date: string}} m  addresses for from and to
 */
export function movementInstruction(ctx, { token, from, to, amountRaw, txHash, date }) {
  return transferInstruction(ctx, [{ token, from, to, amountRaw: BigInt(amountRaw) }], { date, status: 'Settled', txHash });
}
