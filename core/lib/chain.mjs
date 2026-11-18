// Chain-level guards shared by everything that talks to a node: errors, the mainnet refusal (C3) and URL redaction.
// No keys and no environment here.

import { createPublicClient, http } from 'viem';

export const SEPOLIA_CHAIN_ID = 11155111;
export const MAINNET_CHAIN_ID = 1;

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class MainnetRefusedError extends NetworkError {
  constructor(rpcUrl) {
    super(
      `Refusing to run: the RPC endpoint reports chain id 1 (Ethereum mainnet). Interlock is a testnet-only reference ` +
        `implementation and never sends a transaction to mainnet. Use a local Ethereum node or the Sepolia testnet.` +
        (rpcUrl ? ` (endpoint: ${redactUrl(rpcUrl)})` : ''),
    );
    this.name = 'MainnetRefusedError';
    this.chainId = 1;
  }
}

/** Hides credentials or API keys that providers put in RPC URLs. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    const parts = u.pathname.split('/');
    u.pathname = parts.map((p) => (p.length >= 16 ? `${p.slice(0, 4)}***` : p)).join('/');
    u.search = u.search ? '?***' : '';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

/** Reads eth_chainId with a throwaway client. Nothing is signed or sent. */
export async function readChainId(rpcUrl) {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
  try {
    return await client.getChainId();
  } catch (e) {
    throw new NetworkError(`cannot reach the RPC endpoint ${redactUrl(rpcUrl)}: ${e.shortMessage ?? e.message}`);
  }
}

/** Throws unless the chain id is safe: never mainnet, and the expected chain when one is given. */
export function assertChainAllowed(chainId, { network = 'this network', expectedChainId = null, rpcUrl } = {}) {
  if (Number(chainId) === MAINNET_CHAIN_ID) throw new MainnetRefusedError(rpcUrl);
  if (expectedChainId && Number(chainId) !== expectedChainId) {
    throw new NetworkError(
      `${network} expects chain id ${expectedChainId}, but ${redactUrl(rpcUrl)} reports ${chainId}. Check RPC_URL.`,
    );
  }
}
