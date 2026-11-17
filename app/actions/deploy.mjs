// Deploys the kit per the build plan's "Kit wiring" (decision D1) for every template file found.
// C1: every template is validated before the first transaction. C2: no code knows a template by name.
// C3: the chain id is re-read here before anything is sent, and chain id 1 is refused.

import { keccak256, encodePacked, zeroAddress, getAddress } from 'viem';
import { loadTemplates, DEFAULT_TEMPLATE_DIR } from '../lib/config.mjs';
import { loadArtifact } from '../lib/artifacts.mjs';
import { TOPICS, topicId } from '../lib/topics.mjs';
import { readChainId, assertChainAllowed, writeDeployment, setDeployment, getActor } from '../lib/context.mjs';
import { deployContract, mustSend, TxError } from '../lib/tx.mjs';

export const INVESTOR_ELIGIBILITY_SCHEMA =
  'address identity,uint8 kycStatus,uint8 amlStatus,uint8 sanctionsStatus,uint8 sourceOfFundsStatus,uint8 accreditationType,uint16 countryCode,uint64 expirationTimestamp,bytes32 evidenceHash,uint8 verificationMethod';
export const ISSUER_AUTH_SCHEMA = 'address issuerAddress,uint256[] authorizedTopics,string issuerName';

/** Policies with no settings, shared by every token. COUNTRY and ACCREDITATION are per token. */
const SHARED_POLICIES = Object.freeze({
  KYC: 'KYCStatusPolicy',
  AML: 'AMLPolicy',
  SANCTIONS: 'SanctionsPolicy',
  SOURCE_OF_FUNDS: 'SourceOfFundsPolicy',
  PROFESSIONAL: 'ProfessionalInvestorPolicy',
  INSTITUTIONAL: 'InstitutionalInvestorPolicy',
});

/** EAS schema UID: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function schemaUid(schema, resolver, revocable) {
  return keccak256(encodePacked(['string', 'address', 'bool'], [schema, resolver, revocable]));
}

/**
 * Deploys shared contracts and one eligibility set + token per template, then writes the deployment record.
 * @param {object} ctx  from createContext
 * @param {object} [o]
 * @param {string[]} [o.templateDirs]  directories whose *.json files are templates (default: templates/)
 * @param {string|false} [o.outFile]   where to write the record (default ctx.deploymentFile; false = don't write)
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<object>} the deployment record (also set on ctx.deployment)
 */
export async function deploy(ctx, { templateDirs = [DEFAULT_TEMPLATE_DIR], outFile = ctx.deploymentFile, log = ctx.log ?? (() => {}) } = {}) {
  // C1: validate everything first. A ConfigError here means nothing was sent.
  const templates = loadTemplates(templateDirs, ctx.kit);

  // C3: read the chain id again right before the first transaction.
  const chainId = await readChainId(ctx.rpcUrl);
  assertChainAllowed(chainId, { network: ctx.network, expectedChainId: ctx.network === 'sepolia' ? ctx.chainId : null, rpcUrl: ctx.rpcUrl });
  if (chainId !== ctx.chainId) throw new TxError(`chain id changed from ${ctx.chainId} to ${chainId} since connecting`);

  const operator = getActor(ctx, 'operator').address;
  const issuer = getActor(ctx, 'issuer').address;
  const compliance = getActor(ctx, 'compliance').address;
  const art = (name) => loadArtifact(name);
  const abi = (name) => ctx.abis[name];
  const send = (address, contract, functionName, args, label) =>
    mustSend(ctx, 'operator', { address, abi: abi(contract), functionName, args }, label);
  const create = async (name, args = []) => (await deployContract(ctx, 'operator', art(name), args)).address;

  const deployBlock = Number(await ctx.publicClient.getBlockNumber({ cacheTime: 0 }));
  const startedAt = Date.now();
  log(`Deploying ${templates.length} template(s) to ${ctx.network} (chain id ${chainId}) from block ${deployBlock}`);

  // ============ Shared ============
  let schemaRegistry;
  let eas;
  if (ctx.publicEas) {
    // D5: on Sepolia reuse the public EAS. Check it is really there before relying on it.
    schemaRegistry = getAddress(ctx.publicEas.schemaRegistry);
    eas = getAddress(ctx.publicEas.eas);
    const linked = await ctx.publicClient
      .readContract({ address: eas, abi: abi('EAS'), functionName: 'getSchemaRegistry' })
      .catch(() => null);
    if (!linked || getAddress(linked) !== schemaRegistry) {
      throw new TxError(`the public EAS at ${eas} was not found on this chain (or uses another schema registry)`);
    }
  } else {
    schemaRegistry = await create('SchemaRegistry');
    eas = await create('EAS', [schemaRegistry]);
  }
  const resolver = await create('TrustedIssuerResolver', [eas, operator, [operator]]);

  const registerSchema = async (schema, schemaResolver) => {
    const uid = schemaUid(schema, schemaResolver, true);
    const existing = await ctx.publicClient.readContract({
      address: schemaRegistry,
      abi: abi('SchemaRegistry'),
      functionName: 'getSchema',
      args: [uid],
    });
    if (existing.uid === uid) return uid; // already registered (public EAS): reuse
    await send(schemaRegistry, 'SchemaRegistry', 'register', [schema, schemaResolver, true], `register schema`);
    return uid;
  };
  const investorEligibility = await registerSchema(INVESTOR_ELIGIBILITY_SCHEMA, zeroAddress);
  const issuerAuthorization = await registerSchema(ISSUER_AUTH_SCHEMA, resolver);

  const identityProxy = await create('EASIdentityProxy', [operator]);
  const policies = {};
  for (const [topic, contract] of Object.entries(SHARED_POLICIES)) policies[topic] = await create(contract);

  // ============ Per token ============
  const tokens = [];
  for (const t of templates) {
    log(`  ${t.symbol} (${t.file}): ${t.requiredTopics.join(', ')}`);
    const topicIds = t.requiredTopics.map(topicId);

    const registry = await create('ClaimTopicsRegistry', [operator]);
    for (const id of topicIds) await send(registry, 'ClaimTopicsRegistry', 'addClaimTopic', [BigInt(id)]);

    const adapter = await create('EASTrustedIssuersAdapter', [operator]);
    await send(adapter, 'EASTrustedIssuersAdapter', 'setEASAddress', [eas]);
    await send(adapter, 'EASTrustedIssuersAdapter', 'setIssuerAuthSchemaUID', [issuerAuthorization]);

    const verifier = await create('EASClaimVerifier', [operator]);
    await send(verifier, 'EASClaimVerifier', 'setEASAddress', [eas]);
    await send(verifier, 'EASClaimVerifier', 'setTrustedIssuersAdapter', [adapter]);
    await send(verifier, 'EASClaimVerifier', 'setIdentityProxy', [identityProxy]);
    await send(verifier, 'EASClaimVerifier', 'setClaimTopicsRegistry', [registry]);

    const tokenPolicies = {};
    let countryPolicy = null;
    let accreditationPolicy = null;
    if (t.country) {
      const mode = t.country.mode === 'block' ? 1 : 0; // CountryAllowListPolicy.Mode { Allow, Block }
      countryPolicy = await create('CountryAllowListPolicy', [operator, mode, t.country.codes]);
    }
    if (t.accreditation) {
      accreditationPolicy = await create('AccreditationPolicy', [operator, t.accreditation.allowedTypes]);
    }
    for (const name of t.requiredTopics) {
      const policy = name === 'COUNTRY' ? countryPolicy : name === 'ACCREDITATION' ? accreditationPolicy : policies[name];
      if (!policy) throw new TxError(`no policy for topic ${name} in ${t.file}`);
      tokenPolicies[name] = policy;
      await send(verifier, 'EASClaimVerifier', 'setTopicSchemaMapping', [BigInt(TOPICS[name]), investorEligibility]);
      await send(verifier, 'EASClaimVerifier', 'setTopicPolicy', [BigInt(TOPICS[name]), policy]);
    }

    const eligibility = await create('ShibuiEligibility', [verifier, operator]);
    const token = await create('RegulatedToken', [t.name, t.symbol, t.decimals, operator, eligibility]);
    const issuerRole = await ctx.publicClient.readContract({ address: token, abi: abi('RegulatedToken'), functionName: 'ISSUER_ROLE' });
    const complianceRole = await ctx.publicClient.readContract({ address: token, abi: abi('RegulatedToken'), functionName: 'COMPLIANCE_ROLE' });
    await send(token, 'RegulatedToken', 'grantRole', [issuerRole, issuer], 'grant ISSUER_ROLE');
    await send(token, 'RegulatedToken', 'grantRole', [complianceRole, compliance], 'grant COMPLIANCE_ROLE');

    tokens.push({
      id: t.id,
      file: t.file,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      address: token,
      eligibility,
      verifier,
      adapter,
      registry,
      topics: t.requiredTopics,
      topicIds,
      policies: tokenPolicies,
      countryPolicy,
      accreditationPolicy,
      country: t.country,
      accreditation: t.accreditation,
      trustedAttesters: t.trustedAttesters,
      labels: t.labels,
    });
  }

  const deployment = {
    kit: 'eea-tokenization-starter-kit',
    network: ctx.network,
    chainId,
    // Local only: where the chain listens, so the CLI can find it. Never stored for Sepolia (URLs carry API keys).
    rpcUrl: ctx.network === 'local' ? ctx.rpcUrl : undefined,
    deployBlock,
    deployedAt: new Date().toISOString(),
    deploySeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    templateDirs: templateDirs.map(String),
    actors: Object.fromEntries(Object.values(ctx.actors).map((a) => [a.id, a.address])),
    shared: { schemaRegistry, eas, resolver, identityProxy, policies },
    schemas: {
      investorEligibility: { uid: investorEligibility, schema: INVESTOR_ELIGIBILITY_SCHEMA, resolver: zeroAddress },
      issuerAuthorization: { uid: issuerAuthorization, schema: ISSUER_AUTH_SCHEMA, resolver },
    },
    tokens,
  };
  if (outFile) writeDeployment(outFile, deployment);
  setDeployment(ctx, deployment);
  log(`Deployed ${tokens.length} token(s) in ${deployment.deploySeconds} s${outFile ? `; record: ${outFile}` : ''}`);
  return deployment;
}
