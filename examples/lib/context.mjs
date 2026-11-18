// The examples' context: reads the environment (NETWORK, RPC_URL, DEPLOYER_KEY via .env), picks the quickstart
// signers (anvil's public test keys locally, keys derived from DEPLOYER_KEY on Sepolia) and the repository's cast,
// templates and deployment records, then hands everything to the core. Institutions bring their own signers by
// calling the core's createContext directly (see docs/spec.md, "Signers").

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createContext as createCoreContext, setDeployment, readDeployment } from '../../core/lib/context.mjs';
import { NetworkError } from '../../core/lib/chain.mjs';
import { DEPLOYMENTS_DIR, OUT_DIR } from '../../core/lib/paths.mjs';
import { loadKitConfig, DEFAULT_KIT_CONFIG, DEFAULT_TEMPLATE_DIR } from './config.mjs';
import { loadEnv, resolveNetwork, sepoliaTopUp } from './network.mjs';

export * from '../../core/lib/context.mjs';
export { readChainId, assertChainAllowed } from '../../core/lib/chain.mjs';

/**
 * @param {object} o
 * @param {Record<string,string>} [o.env]       environment (defaults to process.env over .env)
 * @param {string} [o.rpcUrl]                   overrides the URL from env (e.g. a freshly started anvil)
 * @param {object} [o.kit]                      parsed cast (defaults to loading kit.config.json)
 * @param {object} [o.deployment]               deployment record; defaults to reading o.deploymentFile if present
 * @param {string} [o.deploymentFile]           defaults to deployments/<network>.json
 * @param {boolean} [o.loadDeployment]          false: ignore an existing record (a fresh deploy follows)
 * @param {string[]} [o.templateDirs]           default template directories for deploy()
 */
export async function createContext({
  env = loadEnv(),
  rpcUrl,
  kit,
  kitConfigPath = DEFAULT_KIT_CONFIG,
  deployment,
  deploymentFile,
  loadDeployment = true,
  templateDirs = [DEFAULT_TEMPLATE_DIR],
  outDir = OUT_DIR,
  log = () => {},
} = {}) {
  const cast = kit ?? loadKitConfig(kitConfigPath);
  const settings = resolveNetwork({ env, kit: cast });
  const url = rpcUrl ?? settings.rpcUrl;
  if (!url) throw new NetworkError('no RPC endpoint: start a local chain or set RPC_URL');
  const ctx = await createCoreContext({
    rpcUrl: url,
    cast,
    signers: settings.accounts,
    network: settings.network,
    expectedChainId: settings.expectedChainId,
    publicEas: settings.eas,
    deploymentFile: deploymentFile ?? path.join(DEPLOYMENTS_DIR, `${settings.network}.json`),
    templateDirs,
    topUp: settings.network === 'sepolia' ? sepoliaTopUp : null,
    outDir,
    log,
  });
  if (deployment) setDeployment(ctx, deployment);
  else if (loadDeployment && existsSync(ctx.deploymentFile)) setDeployment(ctx, readDeployment(ctx.deploymentFile));
  return ctx;
}

/**
 * Connects to an existing deployment (for the CLI or a server started on its own), in a process that did not
 * deploy it. Record: deploymentFile, DEPLOYMENT_FILE, or deployments/<NETWORK>.json. RPC: rpcUrl, RPC_URL, or for
 * NETWORK=local the URL stored in the record (falling back to http://127.0.0.1:8545).
 */
export async function openDeployment({ env = loadEnv(), rpcUrl, deploymentFile, kit, log } = {}) {
  const network = (env.NETWORK ?? 'local').trim().toLowerCase() || 'local';
  const file = deploymentFile ?? env.DEPLOYMENT_FILE ?? path.join(DEPLOYMENTS_DIR, `${network}.json`);
  if (!existsSync(file)) {
    throw new NetworkError(`no deployment record at ${file}. Start the kit first (npm start), or pass --deployment <file>.`);
  }
  const deployment = readDeployment(file);
  const url = rpcUrl || env.RPC_URL || (network === 'local' ? deployment.rpcUrl || 'http://127.0.0.1:8545' : undefined);
  return createContext({ env, rpcUrl: url, kit, deployment, deploymentFile: file, log });
}
