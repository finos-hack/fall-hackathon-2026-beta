// npm start (W0): build if needed, start the local chain, deploy every template, seed the demo, serve the console.
// NETWORK=sepolia: no local chain; reuses deployments/sepolia.json unless REDEPLOY=1 (a full deploy costs gas).
// Optional: PORT (default 3000), RPC_URL (use a running node instead of starting anvil), TEMPLATE_DIRS
// (comma-separated directories of template files, default templates/).

import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadKitConfig, loadTemplates, ConfigError, DEFAULT_TEMPLATE_DIR } from './lib/config.mjs';
import { ensureBuilt, ArtifactError } from './lib/artifacts.mjs';
import { loadEnv, resolveNetwork, startAnvil, isPortFree, freePort, NetworkError, DEFAULT_LOCAL_PORT, redactUrl } from './lib/network.mjs';
import { createContext, readDeployment, setDeployment } from './lib/context.mjs';
import { deploy, seedDemo } from './actions/index.mjs';
import { startServer } from './server.mjs';
import { ROOT } from './lib/paths.mjs';

const t0 = Date.now();
const log = (m) => console.log(m);
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);

let anvil = null;
let server = null;
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await server?.close();
  } catch {
    // ignore
  }
  try {
    await anvil?.stop();
  } catch {
    // ignore
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  const env = loadEnv();
  const kit = loadKitConfig();
  const settings = resolveNetwork({ env, kit });
  const templateDirs = env.TEMPLATE_DIRS
    ? env.TEMPLATE_DIRS.split(',').map((d) => path.resolve(ROOT, d.trim())).filter(Boolean)
    : [DEFAULT_TEMPLATE_DIR];
  // C1: check every template before building, starting a chain or sending anything. deploy() checks again.
  loadTemplates(templateDirs, kit);

  ensureBuilt({ log });

  let rpcUrl = settings.rpcUrl;
  if (settings.startLocalChain) {
    const port = (await isPortFree(DEFAULT_LOCAL_PORT)) ? DEFAULT_LOCAL_PORT : await freePort();
    anvil = await startAnvil({ port, accounts: settings.accountCount, log });
    rpcUrl = anvil.url;
  } else {
    log(`Using ${settings.network} endpoint ${redactUrl(rpcUrl)}`);
  }

  // C3: createContext reads the chain id first and refuses chain id 1 before any transaction.
  const ctx = await createContext({ env, rpcUrl, kit, loadDeployment: false, log });
  log(`Connected: network ${ctx.network}, chain id ${ctx.chainId}`);

  const reuse = ctx.network === 'sepolia' && env.REDEPLOY !== '1' && existsSync(ctx.deploymentFile);
  if (reuse) {
    setDeployment(ctx, readDeployment(ctx.deploymentFile));
    log(`Reusing ${path.relative(ROOT, ctx.deploymentFile)} (set REDEPLOY=1 to deploy again)`);
  } else {
    await deploy(ctx, { templateDirs, log });
    log('Seeding the demo cast (W1 authorize, W2 onboard, W3 issue)...');
    await seedDemo(ctx, { log });
  }

  server = await startServer({ ctx, port: Number(env.PORT ?? 3000), log });
  log(`Console listening on ${server.url} (ready in ${secs()} s). Press Ctrl+C to stop.`);
  log(`API: GET ${server.url}/api/state, POST ${server.url}/api/actions. CLI: npm run cli -- --help`);
} catch (e) {
  const known = e instanceof ConfigError || e instanceof NetworkError || e instanceof ArtifactError;
  console.error(`\nnpm start stopped: ${known ? e.message : e.stack ?? e.message}`);
  await shutdown(1);
}
