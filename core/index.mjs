// Interlock core: the public entry point. Contracts' bindings, the deployer, the action library and the state reader,
// with no demo cast and no keys. See docs/spec.md for what each part promises.
//
//   import { createContext, deploy, issue, transfer, getState } from './core/index.mjs';
//   const ctx = await createContext({ rpcUrl, cast, signers });   // signers: one viem Account per cast id
//   await deploy(ctx, { templateDirs: ['./my-templates'], outFile: false });

export {
  createContext,
  castMemberIds,
  withMode,
  withDeployment,
  setDeployment,
  readDeployment,
  writeDeployment,
  getActor,
  getToken,
  resolveParty,
  InputError,
} from './lib/context.mjs';
export {
  deploy,
  getState,
  auditTrail,
  runAction,
  seedDemo,
  ACTIONS,
  issue,
  transfer,
  redeem,
  freeze,
  forcedTransfer,
  pause,
  unpause,
  authorizeProvider,
  onboardInvestor,
  revokeCredential,
  replaceAttester,
  onboardEntity,
  registerEntityCredential,
  revokeEntity,
  entityOf,
  settle,
  approveLeg,
  proposeTrade,
  affirmTrade,
  INTEROP_ACTIONS,
  eligibilitySnapshot,
  registeredCredentials,
} from './actions/index.mjs';
export { validateCast, validateTemplate, loadTemplates, loadKitConfig, listTemplateFiles, ConfigError } from './lib/config.mjs';
export { NetworkError, MainnetRefusedError, SEPOLIA_CHAIN_ID, MAINNET_CHAIN_ID, readChainId, assertChainAllowed } from './lib/chain.mjs';
export { TOPICS, TOPIC_NAMES, STATUSES, statusText, describeTopicStatus } from './lib/topics.mjs';
export { TxError, explainFor } from './lib/tx.mjs';
export { CDM_VERSION, MAPPING as CDM_MAPPING, transferInstruction, settledInstruction, parseTransferInstruction, cdmReference, movementInstruction, caip19 } from './lib/cdm.mjs';
export { ensureBuilt, artifactsPresent, ArtifactError } from './lib/artifacts.mjs';
