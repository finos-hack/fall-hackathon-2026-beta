// npm run record:sepolia (manual; .github/workflows/record-sepolia.yml): records the main lines of stories D and E on
// the Sepolia testnet, against OnChainTrust's live vLEI bridge, and writes web/recordings/sepolia.json (and .js).
//
// Inputs, all from the environment (repository secrets in CI; never in chat, the repository or logs):
//   RPC_URL            optional: a Sepolia endpoint (default: the public endpoint in examples/lib/network.mjs)
//   DEPLOYER_KEY       one funded Sepolia key (the operator; other actors are derived from it and topped up,
//                      so this is the only wallet anyone has to fund; the recorder says how much before sending)
//   VLEI_HOLDER_KEYS   two comma-separated private keys of wallets holding live bridge attestations
//   VLEI_HOLDER_UIDS   the two matching EAS attestation UIDs (the bridge's, under schema 0x0b5f…1aa7)
//
// Those attestations name REAL institutions. They are never written: the holders appear as "vLEI holder 1" and
// "vLEI holder 2", each with a link to its attestation on easscan, and the recorder reads the real names and LEIs
// from the slot only to check that none of them appears anywhere in the output. If one does, nothing is written.
// Public networks have no snapshot or revert, so side branches are not recorded here (they are in the local one).

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { formatEther, nonceManager } from 'viem';
import { createContext } from '../core/lib/context.mjs';
import { SEPOLIA_CHAIN_ID } from '../core/lib/chain.mjs';
import { ensureBuilt } from '../core/lib/artifacts.mjs';
import { ROOT } from '../core/lib/paths.mjs';
import { isoDate } from '../core/lib/cdm.mjs';
import * as kit from '../core/actions/index.mjs';
import { entityOf } from '../core/actions/vlei.mjs';
import { SEPOLIA_VLEI_BRIDGE } from '../core/actions/deploy.mjs';
import { loadKitConfig } from './lib/config.mjs';
import { listTemplateFiles } from '../core/lib/config.mjs';
import { decodeVleiCredential } from '../core/lib/credentials.mjs';
import { read } from '../core/actions/common.mjs';
import { loadEnv, resolveNetwork, sepoliaTopUp, topUpAmounts, SEPOLIA_EAS, DEFAULT_SEPOLIA_RPC } from './lib/network.mjs';
import { Recorder, RecordingError, SETUP, STORIES, demoTemplates, EXAMPLE_TEMPLATES, gitCommit, DEMO_PROVIDERS, DEMO_INSTITUTIONS, FORMAT } from './record.mjs';

export const SEPOLIA_OUT_DIR = path.join(ROOT, 'web', 'recordings');
const HOLDERS = ['northvale-treasury', 'larkmoor-treasury'];
const HOLDER_NAMES = { 'northvale-treasury': 'vLEI holder 1', 'larkmoor-treasury': 'vLEI holder 2' };

/**
 * Credential types the dIBD slot accepts on Sepolia. The local demo accepts LE (legal entity) only, but OnChainTrust's
 * live test credentials on Sepolia are ECR (engagement context role: a person acting in a role for the legal entity,
 * whose LEI the credential carries), so the Sepolia run also accepts ECR.
 */
export const SEPOLIA_CREDENTIAL_TYPES = Object.freeze(['LE', 'ECR']);

/** Copies the example templates into `dir`, with the vLEI templates accepting SEPOLIA_CREDENTIAL_TYPES. */
export function sepoliaExampleTemplates(dir, from = EXAMPLE_TEMPLATES) {
  const out = [];
  for (const file of listTemplateFiles([from])) {
    const t = JSON.parse(readFileSync(file, 'utf8'));
    if (t.eligibility?.source === 'vlei') t.eligibility = { ...t.eligibility, credentialTypes: [...SEPOLIA_CREDENTIAL_TYPES] };
    writeFileSync(path.join(dir, path.basename(file)), `${JSON.stringify(t, null, 2)}\n`);
    out.push(t);
  }
  return out;
}

/** Which inputs are missing. Pure: no network. */
export function sepoliaRequirements(env) {
  const missing = ['DEPLOYER_KEY', 'VLEI_HOLDER_KEYS', 'VLEI_HOLDER_UIDS'].filter((k) => !env[k]?.trim());
  const keys = (env.VLEI_HOLDER_KEYS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const uids = (env.VLEI_HOLDER_UIDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const problems = [];
  if (env.VLEI_HOLDER_KEYS && keys.length !== 2) problems.push('VLEI_HOLDER_KEYS must hold exactly two keys');
  if (env.VLEI_HOLDER_UIDS && (uids.length !== 2 || !uids.every((u) => /^0x[0-9a-fA-F]{64}$/.test(u)))) problems.push('VLEI_HOLDER_UIDS must hold exactly two 32-byte attestation UIDs');
  return { missing, problems, keys, uids };
}

/** Gas of the whole Sepolia recording, measured on a local chain: deploy about 34 million, stories D and E about 10 million. */
export const RECORDING_GAS = 45_000_000n;
/** Wallets the operator may top up during the recording (provider, two issuers, three investors, two vLEI holders). */
export const TOPPED_UP_WALLETS = 8n;

/** What the deployer needs before the first transaction, at the current gas price, with 4x headroom on gas. */
export function fundingNeeded({ gasPrice, topUp }) {
  return gasPrice * RECORDING_GAS * 4n + topUp * TOPPED_UP_WALLETS;
}

/** The main line of a story: forks replaced by the steps of the option the story continues with. */
export function mainLineOf(steps) {
  return steps.flatMap((x) => (x.fork ? x.fork.options.find((o) => o.continues).steps : [x]));
}

/** Stories D and E for Sepolia: E's local-bridge onboarding becomes registering the real attestations. */
export function sepoliaStories(uids) {
  const pick = (id) => STORIES.find((s) => s.id === id);
  const d = pick('dvp');
  const e = pick('vlei');
  const eSteps = mainLineOf(e.steps).map((s) => {
    if (s.id === 'E1' || s.id === 'E2') {
      const i = s.id === 'E1' ? 0 : 1;
      return { ...s, actor: 'operator', action: 'registerEntityCredential', params: { uid: uids[i] }, title: `The operator registers ${HOLDER_NAMES[HOLDERS[i]]}'s live attestation from OnChainTrust's bridge on dIBD` };
    }
    // The holders' wallets carry real institutions' test credentials, so they are not called by the fictional bank names.
    const title = s.title
      .replace('funds its treasury', `funds ${HOLDER_NAMES[HOLDERS[0]]}`)
      .replace(/Northvale Bank (pays|returns)|to Northvale Bank/g, (m) => m.replace('Northvale Bank', HOLDER_NAMES[HOLDERS[0]]))
      .replace(/Larkmoor Bank/g, HOLDER_NAMES[HOLDERS[1]]);
    return { ...s, title };
  });
  return [
    { ...d, steps: mainLineOf(d.steps) },
    { ...e, steps: eSteps, institution: 'Northvale Bank and two vLEI holders on Sepolia' },
  ];
}

/**
 * Replaces every occurrence of the given secrets (real names, LEIs) and throws if any is still present.
 * @returns {string} the JSON text, safe to write
 */
export function redactAndCheck(json, secrets) {
  let text = json;
  for (const s of secrets.filter((x) => typeof x === 'string' && x.length >= 3)) text = text.split(s).join('[withheld]');
  for (const s of secrets.filter((x) => typeof x === 'string' && x.length >= 3)) {
    if (text.toLowerCase().includes(s.toLowerCase())) throw new RecordingError('a real institution name or LEI is still in the Sepolia recording; nothing was written');
  }
  return text;
}

export async function recordSepolia({ env = loadEnv(), outDir = SEPOLIA_OUT_DIR, log = console.log, progress = () => {} } = {}) {
  const req = sepoliaRequirements(env);
  if (req.missing.length || req.problems.length) {
    throw new RecordingError(
      `the Sepolia recording needs ${[...req.missing, ...req.problems].join('; ')}. Nothing was sent. ` +
        'Set them as repository secrets for .github/workflows/record-sepolia.yml (never paste keys into chat or commit them).',
    );
  }
  ensureBuilt({ log: progress });
  const castKit = loadKitConfig();
  const demoKit = {
    ...castKit,
    attesters: castKit.attesters.map((a) => ({ ...a, name: DEMO_PROVIDERS[a.id]?.name ?? a.name })),
    institutions: castKit.institutions.map((i) => (HOLDER_NAMES[i.id] ? { ...i, name: HOLDER_NAMES[i.id], institution: HOLDER_NAMES[i.id] } : i)),
  };
  const settings = resolveNetwork({ env: { ...env, NETWORK: 'sepolia' }, kit: demoKit });
  const signers = { ...settings.accounts };
  HOLDERS.forEach((id, i) => (signers[id] = privateKeyToAccount(req.keys[i].startsWith('0x') ? req.keys[i] : `0x${req.keys[i]}`, { nonceManager })));
  const ctx = await createContext({
    rpcUrl: env.RPC_URL?.trim() || DEFAULT_SEPOLIA_RPC,
    cast: demoKit,
    signers,
    network: 'sepolia',
    expectedChainId: SEPOLIA_CHAIN_ID,
    publicEas: { ...SEPOLIA_EAS },
    vleiBridge: SEPOLIA_VLEI_BRIDGE,
    topUp: sepoliaTopUp,
    log: progress,
  });
  // Pre-flight: the deployer pays every transaction and every top-up. Say how much is missing before sending anything.
  const amounts = await topUpAmounts(ctx.publicClient);
  const needed = fundingNeeded(amounts);
  const operator = ctx.actors.operator.address;
  const balance = await ctx.publicClient.getBalance({ address: operator });
  log(`Deployer ${operator}: ${formatEther(balance)} Sepolia ETH; this run needs about ${formatEther(needed)} at the current gas price`);
  if (balance < needed) {
    throw new RecordingError(`send at least ${formatEther(needed - balance)} Sepolia ETH to the deployer ${operator}, then run again. Nothing was sent.`);
  }
  // The real identities behind the two attestations, read before anything is sent, only to make sure they are not
  // written. The slot is asked again at the end; both sources go into the redaction list.
  const secrets = [];
  const credTypes = [];
  for (const [i, uid] of req.uids.entries()) {
    const att = await read(ctx, SEPOLIA_EAS.eas, 'EAS', 'getAttestation', [uid]);
    if (att.recipient.toLowerCase() !== signers[HOLDERS[i]].address.toLowerCase()) {
      throw new RecordingError(`attestation ${i + 1} of VLEI_HOLDER_UIDS is not for the wallet of key ${i + 1} of VLEI_HOLDER_KEYS (same order expected). Nothing was sent.`);
    }
    if (att.revocationTime > 0n) throw new RecordingError(`attestation ${uid} is revoked. Nothing was sent.`);
    if (att.schema.toLowerCase() !== SEPOLIA_VLEI_BRIDGE.schemaUid.toLowerCase() || att.attester.toLowerCase() !== SEPOLIA_VLEI_BRIDGE.attester.toLowerCase()) {
      throw new RecordingError(`attestation ${uid} is not from OnChainTrust's bridge (schema or attester differs). Nothing was sent.`);
    }
    const v = decodeVleiCredential(att.data);
    if (!v) throw new RecordingError(`attestation ${uid} does not decode under the bridge schema. Nothing was sent.`);
    secrets.push(v.legalName, v.lei);
    credTypes.push(v.credType);
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'interlock-sepolia-'));
  try {
    const kitDir = path.join(tmp, 'kit');
    const exampleDir = path.join(tmp, 'examples');
    mkdirSync(kitDir);
    mkdirSync(exampleDir);
    demoTemplates(kitDir);
    sepoliaExampleTemplates(exampleDir);
    log('Deploying to Sepolia (this sends real testnet transactions)');
    await kit.deploy(ctx, { templateDirs: [kitDir, exampleDir], outFile: false });
    const names = Object.fromEntries(Object.values(ctx.actors).map((a) => [a.id, a.name]));
    const rec = new Recorder(ctx, names);
    rec.today = isoDate((await rec.latest()).timestamp);
    const setup = await rec.steps(SETUP.filter((s) => s.id !== 'S5'), 'setup', log);
    const baseline = { state: await rec.state(), audit: (await kit.auditTrail(ctx)).map(({ logIndex, ...e }) => e) };
    const stories = [];
    for (const story of sepoliaStories(req.uids)) {
      log(`Story ${story.letter}: ${story.title}`);
      const steps = await rec.steps(story.steps, `story ${story.letter}`, log);
      stories.push({ id: story.id, letter: story.letter, title: story.title, chapter: 'together', token: story.token, tokens: story.tokens, parties: story.parties ?? castKit.investors.map((i) => i.id), institution: story.institution, steps });
    }
    // The slot's view of the same identities, added to the redaction list.
    const ibd = ctx.deployment.tokens.find((t) => t.symbol === 'dIBD');
    for (const id of HOLDERS) {
      const who = await entityOf(ctx, ibd, ctx.actors[id].address);
      secrets.push(who.legalName, who.lei);
    }
    const d = ctx.deployment;
    const recording = {
      format: FORMAT,
      kit: 'eea-tokenization-starter-kit',
      recordedAt: new Date().toISOString(),
      commit: gitCommit(),
      network: 'sepolia',
      chainId: ctx.chainId,
      explorer: ctx.explorer,
      contracts: { eas: d.shared.eas, schemaRegistry: d.shared.schemaRegistry, trustedIssuerResolver: d.shared.resolver, identityProxy: d.shared.identityProxy, dvp: d.shared.dvp },
      realDataNotice: `Story E uses real test credentials from OnChainTrust's vLEI bridge on Sepolia (types ${[...new Set(credTypes)].join(', ')}; the slot accepts ${SEPOLIA_CREDENTIAL_TYPES.join(' and ')} here). The institutions they name are not shown; follow the attestation links to see the public test data.`,
      cast: {
        operator: { id: 'operator', name: names.operator },
        providers: castKit.attesters.map((a) => ({ id: a.id, name: names[a.id], note: DEMO_PROVIDERS[a.id]?.note ?? '', address: ctx.actors[a.id].address })),
        investors: castKit.investors.map((i) => ({ id: i.id, name: i.name, who: '', summary: i.summary, address: ctx.actors[i.id].address })),
        entities: HOLDERS.map((id, i) => ({ id, name: HOLDER_NAMES[id], institution: HOLDER_NAMES[id], monogram: null, credType: credTypes[i], lei: null, realTestData: true, attestation: `https://sepolia.easscan.org/attestation/view/${req.uids[i]}`, address: ctx.actors[id].address })),
        bridge: { id: 'vlei-bridge', name: "OnChainTrust's vLEI bridge", address: SEPOLIA_VLEI_BRIDGE.attester },
        institutions: [...new Map(Object.values(DEMO_INSTITUTIONS).map((x) => [x.institution, x])).values()].map((x) => ({ name: x.institution, monogram: x.monogram, signers: Object.fromEntries(Object.entries(x.roles).map(([role, id]) => [role, { id, name: names[id], address: ctx.actors[id].address }])) })),
        names,
      },
      tokens: d.tokens.map((t) => ({ id: t.id, symbol: t.symbol, name: t.name, address: t.address, institution: DEMO_INSTITUTIONS[t.id]?.institution ?? null, monogram: DEMO_INSTITUTIONS[t.id]?.monogram ?? null, requiredTopics: t.topics, country: t.country, accreditation: t.accreditation, labels: t.labels, roles: t.roles, eligibilitySource: t.eligibilitySource ?? 'shibui', vlei: t.vlei ?? null, templateFile: null, template: null })),
      setup,
      baseline,
      stories,
      interop: { interfaceId: '0x3edbb4c4', functions: [], setup: [], tokens: [] },
    };
    const json = redactAndCheck(JSON.stringify(recording, null, 2), secrets);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'sepolia.json'), `${json}\n`);
    writeFileSync(path.join(outDir, 'sepolia.js'), `// Generated by npm run record:sepolia. Real test data from OnChainTrust's bridge is not named here.\nwindow.DEMO_RECORDING_SEPOLIA = ${json};\n`);
    return JSON.parse(json);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const r = await recordSepolia({ progress: (m) => console.error(m) });
    console.log(`Recorded ${r.stories.length} stories on Sepolia -> web/recordings/sepolia.json. Review it before committing.`);
  } catch (e) {
    console.error(`\nnpm run record:sepolia stopped: ${e instanceof RecordingError ? e.message : e.shortMessage ?? e.message}`);
    process.exit(1);
  }
}
