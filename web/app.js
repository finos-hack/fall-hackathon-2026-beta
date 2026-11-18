// Plays back web/data/demo.js (written by `npm run record`). Every result shown here comes from that recording:
// this file only lays it out. The texts it adds are labelled: the today-vs-on-chain lanes are illustrative, and the
// "not solved yet" and "build on it" sections are the project's own assessment.
//
// No framework, no build step, no network: a plain script, so the page also opens from a local file.
(function () {
  'use strict';

  // ?recording=sepolia plays web/recordings/sepolia.js (made by npm run record:sepolia) instead of the local one.
  const WANT_SEPOLIA = /(^|&)recording=sepolia(&|$)/.test(location.search.slice(1));
  let REC = WANT_SEPOLIA ? null : window.DEMO_RECORDING || null;
  const REPO = 'https://github.com/finos-hack/fall-hackathon-2026-beta';
  const CRED_TYPES = { LE: 'legal entity', ECR: 'engagement context role: a person acting in a role for a legal entity', OOR: 'official organisational role' };
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ============ Small DOM helpers (text only: recorded data never becomes HTML) ============

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const $ = (sel, root = document) => root.querySelector(sel);

  function fmtAmount(s) {
    const [i, f] = String(s).split('.');
    const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return f ? `${int}.${f}` : int;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `${day}, ${t} UTC`;
  }

  const short = (hash) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

  function txLink(hash) {
    if (REC && REC.explorer) return h('a', { href: `${REC.explorer}/tx/${hash}`, class: 'tx', rel: 'noopener', target: '_blank' }, short(hash));
    return h('code', { class: 'tx', title: hash }, short(hash));
  }

  // ============ The cast ============

  const names = () => (REC ? REC.cast.names : {});
  const nameOf = (id) => names()[id] || id;
  /** The three single-product stories' tokens (home cards), and every token (interoperability). */
  const PRODUCT_TOKENS = () => (REC ? REC.stories.filter((s) => s.chapter !== 'together').map((s) => s.token) : []);
  const ALL_TOKENS = () => (REC ? [...new Set([...PRODUCT_TOKENS(), ...REC.tokens.map((t) => t.symbol)])] : []);
  const storyTokens = (story) => story.tokens || PRODUCT_TOKENS();
  const storyParties = (story) => story.parties || investorIds();
  const isVlei = (sym) => tokenBySymbol(sym)?.eligibilitySource === 'vlei';
  const entityOf = (id) => (REC.cast.entities || []).find((e) => e.id === id) || null;
  const tokenBySymbol = (sym) => REC.tokens.find((t) => t.symbol === sym);
  const investorIds = () => REC.cast.investors.map((i) => i.id);

  function institutionOf(id) {
    for (const inst of REC.cast.institutions) {
      for (const [role, s] of Object.entries(inst.signers)) if (s.id === id) return { ...inst, role };
    }
    return null;
  }

  function avatar(id, size = '') {
    const inst = institutionOf(id);
    let text;
    let kind;
    const ent = entityOf(id);
    if (inst || (ent && ent.monogram)) {
      text = (inst || ent).monogram;
      kind = `inst inst-${text.toLowerCase()}`;
    } else if (REC.cast.bridge && REC.cast.bridge.id === id) {
      text = 'vL';
      kind = 'provider';
    } else if (REC.cast.providers.some((p) => p.id === id)) {
      text = nameOf(id).split(/\s+/).map((w) => w[0]).join('').slice(0, 2);
      kind = 'provider';
    } else if (id === 'operator') {
      text = 'OP';
      kind = 'operator';
    } else {
      text = nameOf(id).slice(0, 1);
      kind = 'investor';
    }
    return h('span', { class: `avatar ${kind} ${size}`, 'aria-hidden': 'true' }, text);
  }

  function who(id) {
    const inv = REC.cast.investors.find((i) => i.id === id);
    return h('span', { class: 'who' }, avatar(id, 'sm'), h('span', {}, nameOf(id), inv && inv.who ? h('span', { class: 'muted' }, ` · ${inv.who}`) : null));
  }

  // ============ Content that is not recorded (labelled on the page) ============

  const PRODUCT = {
    deposit: {
      rules: 'KYC and sanctions',
      today: [
        ['Payer', 'Orchard Logistics instructs its bank to pay Bramble'],
        ["Payer's bank", 'The payment waits for the next cut-off or batch run; on a weekend it waits for Monday'],
        ['Both banks', 'Each bank updates its own ledger'],
        ['Back offices', 'The two ledgers are reconciled afterwards'],
      ],
      chain: [
        ['Alice (Orchard Logistics)', 'Sends dDEP to Bob from her wallet, at any hour'],
        ['dDEP token', 'Asks the eligibility slot: are both holders eligible? (KYC, sanctions)'],
        ['Chain', 'Settles in the next block; there is one shared record'],
        ['Northvale Bank', 'The deposit is still a liability of the bank; it issues and redeems'],
      ],
      proves: [
        ['A payment between two eligible holders settles on a Saturday night.', ['A2']],
        ["A refusal names the topic: Carol has no credential yet, and Dave's revoked credential stops his next transfer.", ['A3', 'A5']],
        ['Issuance and redemption stay with the bank: Northvale mints on deposit and burns on withdrawal.', ['A1', 'A6']],
      ],
    },
    fund: {
      rules: 'KYC, AML and country',
      today: [
        ['Investor', 'Sends a subscription order to the transfer agent'],
        ['Transfer agent', 'Checks the investor and keeps the register'],
        ['Fund', 'Shares are issued at the next dealing cut-off'],
        ['Lender and agent', 'Using shares as collateral needs extra steps'],
      ],
      chain: [
        ['Quillon', 'Issues dMMF to the investor: the token is the register'],
        ['dMMF token', 'Checks eligibility on every transfer (KYC, AML, country)'],
        ['Alice and Bob', 'Shares move between eligible holders, e.g. as collateral'],
        ['Quillon compliance', 'Keeps pause, freeze and forced transfer for incidents'],
      ],
      proves: [
        ['Alice holds the fund with the credential she used for the deposit: no new onboarding.', ['B1']],
        ['Each product keeps its own rules: Dave is refused by country here, while he may hold the deposit.', ['B2']],
        ['Incident tools work: a pause stops transfers but not a forced transfer; a freeze can target one account instead.', ['B4', 'B5', 'B6']],
      ],
    },
    credit: {
      rules: 'KYC, accreditation and country',
      today: [
        ['Manager or administrator', 'Keeps the register, often by hand'],
        ['Compliance', 'Checks every secondary buyer manually'],
        ['Parties', 'Sign transfer documents; the register is updated afterwards'],
        ['Auditors', 'Evidence is assembled after the fact'],
      ],
      chain: [
        ['Saltmarsh', 'Issues dPCN at closing'],
        ['dPCN token', 'Enforces KYC, accreditation and country on every transfer'],
        ['Chain', 'Every action leaves an audit trail automatically'],
        ['Lawyers', 'Legal documents stay off-chain'],
      ],
      proves: [
        ['Accreditation is enforced on every secondary sale, and an updated credential is enough to change the answer.', ['C2']],
        ['A court order can be executed: freeze, a refusal above the unfrozen balance, then a forced transfer.', ['C3', 'C4', 'C5']],
        ['A KYC vendor can be replaced: holders drop out, are re-attested and return, and the audit trail shows who authorized whom.', ['C6']],
      ],
    },
  };

  PRODUCT.dvp = {
    rules: 'each leg keeps its own rules',
    today: [
      ['Buyer and seller', 'Agree the trade; each side instructs its own agent or bank'],
      ['Securities side', 'Delivers the shares through the register or a depository'],
      ['Cash side', 'Pays through the payment system, on its own timetable'],
      ['Both', 'Live with a window where one side has delivered and the other has not'],
    ],
    chain: [
      ['Back office', 'Captures the trade as a CDM TransferInstruction (security leg, cash leg)'],
      ['Interlock', 'Maps it to one DvPSettlement trade; the CDM hash is stored on chain'],
      ['dMMF and dDEP', 'Each token checks its own rules on its own leg, in the same transaction'],
      ['Back office', 'Receives the same instruction back, marked Settled, with the transaction hash'],
    ],
    proves: [
      ['Two instruments from two issuers settle against each other in one transaction: both legs or neither.', ['D3']],
      ["Each leg keeps its own rules: the fund refuses Dave by country, so the whole trade reverts and his deposit never moves.", ['D3b1']],
      ['The trade is described in the FINOS Common Domain Model on the way in and on the way out, validated with CDM\'s own tooling.', ['D3', 'D4']],
    ],
  };
  PRODUCT.vlei = {
    rules: 'a live vLEI credential that names its legal entity',
    today: [
      ['Paying bank', 'Onboards each counterparty bank bilaterally, with its own documents'],
      ['Receiving bank', 'Repeats the exercise for every relationship'],
      ['Both', 'Keep their own copies of each other\'s identity data'],
      ['Compliance', 'Re-checks when a counterparty\'s status changes'],
    ],
    chain: [
      ['vLEI bridge', 'Attests a bank\'s wallet from its GLEIF vLEI credential, with expiry and revocation'],
      ['dIBD token', 'Asks its slot, OnChainTrust\'s VleiEligibility: is this wallet a live legal entity?'],
      ['The two banks', 'Pay each other at once; a wallet without a vLEI credential is refused'],
      ['Bridge', 'Revokes when a credential or an LEI stops being valid, and the next transfer is refused'],
    ],
    proves: [
      ['The eligibility source is pluggable: the same token contract, with OnChainTrust\'s vLEI slot instead of Shibui, from one template setting.', ['E3', 'E4']],
      ['Entity identity is reused: a retail client without a vLEI credential is refused, with the reason by topic.', ['E5']],
      ['Revocation by the bridge takes effect on the next transfer.', ['E5b2']],
    ],
  };

  /** Section 1 of issue #5: what Interlock connects, and the state of each block. */
  const CONNECTS = [
    ['RegulatedToken (ERC-20 + ERC-7943)', 'The instrument: issue, redeem, transfer, freeze, forced transfer, pause', 'Built and tested', 'contracts/RegulatedToken.sol'],
    ['IEligibility slot', '"May this wallet hold it?"; the answer is pluggable', 'Two implementations, one conformance suite', 'contracts/interfaces/IEligibility.sol'],
    ['Shibui (EEA)', 'Eligibility rules per topic for investors: KYC, AML, sanctions, country, accreditation', 'Pinned, unmodified', 'https://github.com/EntEthAlliance/rnd-rwa-erc3643-eas'],
    ['Ethereum Attestation Service', 'Where KYC providers and the vLEI bridge issue and revoke credentials', 'Built and tested', 'https://attest.org'],
    ['OnChainTrust VleiEligibility', 'Eligibility for legal entities from GLEIF vLEI credentials', 'Pinned, unmodified; local test bridge in this recording', 'https://github.com/OnChainTrust/vlei-eas-contracts'],
    ['FINOS Common Domain Model 7.10.0', 'Settlement driven by a CDM instruction; every movement exported to CDM', 'Validated with finos-cdm in CI', 'docs/cdm-mapping.md'],
    ['FINOS CALM 1.3 (architecture as code)', 'The architecture, its flows and its controls as a model, validated with the FINOS CALM CLI', 'Validated in CI, strict mode', 'architecture/README.md'],
    ['DvPSettlement', 'Two instruments settle in one transaction', 'Built and tested (generic, never holds tokens)', 'contracts/DvPSettlement.sol'],
    ['Interlock core', 'Deployer and action library, bring your own signer, conformance suites', 'Built and tested', 'core/index.mjs'],
  ];

  const LIMITS = [
    'Not a standard, not production code, not audited. Ethereum testnets only; Ethereum mainnet is refused.',
    'Not legal settlement: DvP proves atomic exchange of two tokens, not legal finality. The cash leg is a fictional bank\'s deposit token, not central bank money.',
    'Not a trust framework: who may attest, removal and disputes are human decisions; the code enforces the list it is given.',
    'Not private: on a public chain, balances and credential fields are visible.',
    'CDM coverage is a subset (TransferInstruction for movements and settlement); see docs/cdm-mapping.md.',
    'Upstream research code: Shibui v0.4.0 and the OnChainTrust prototype are pinned as published.',
    'One chain: no cross-chain messaging. Networks other than a local Ethereum node and Sepolia are untested.',
  ];

  const UNSOLVED = [
    ['KYC reliance', 'coordination', 'Rules allowing Bank B to rely on KYC done by provider A, with liability defined', 'Regulators, banks, KYC providers'],
    ['Trust framework', 'coordination', 'Who decides which attesters are trusted, how they are removed, how disputes work (vLEI is an existing example: GLEIF and its accredited issuers)', 'An industry body or consortium'],
    ['Shared meaning of credentials', 'coordination', "One schema, the same topic numbers, the same validity rules. Found during this hackathon: Shibui's vLEI policy treats verifiedAt as a freshness signal, while the OnChainTrust bridge does not refresh it. Two good-faith components disagree", 'Standards body (EEA)'],
    ['Legal finality', 'coordination', 'The token register must be recognised as the legal record, and on-chain settlement as final', 'Lawyers, regulators'],
    ['Network choice', 'coordination', 'Public chain, permissioned network (e.g. Besu) or both, and how they connect', 'Consortium'],
    ['Cash leg', 'both', 'Paying for a fund share or note needs settlement money on-chain (tokenized deposits across banks, central bank money, or a link to payment systems)', 'Central banks, payment systems, banks'],
    ['Privacy', 'both', 'On a public chain, credential fields (country, accreditation) and balances are visible. Needs a permissioned network or zero-knowledge credentials', 'Data protection authorities, banks'],
    ['Messaging and core banking', 'technical', 'Map on-chain events to ISO 20022 messages (e.g. payments pacs.008/pacs.009, statements camt.053, fund orders setr.010/setr.004) and post them to core banking, so there is one source of truth, not two', "Each bank's operations and vendors"],
    ['Custody and keys', 'technical', 'Who holds investor keys (custodian, HSM/MPC), and recovery', 'Custodians, regulators'],
    ['Reporting and accounting', 'technical', 'Regulatory reporting and accounting from on-chain data', 'Firms, auditors'],
  ];

  const WORKS_TODAY = [
    'Three products from three config files, with no product-specific code',
    'One credential checked the same way by every product, each with its own rules',
    'Refusals with the reason by topic',
    'Revocation, attester replacement and an on-chain audit trail',
    'Issuer controls: pause, freeze, forced transfer',
    'The same ERC-7943 answers for any app that asks',
  ];

  const PORTING = [
    ['Local Ethereum node / Sepolia', 'Your Ethereum network: a Cancun-enabled permissioned or public chain', 'examples/lib/network.mjs'],
    ['Public test keys', 'Custody: HSM, MPC or custodian', 'docs/limits.md'],
    ['Fictional KYC providers', 'Real attesters under a trust framework', 'docs/architecture.md'],
    ['templates/*.json', 'Your products: one file each', 'docs/add-a-product.md'],
    ['core/actions', 'Your backend, behind your own API and authentication', 'core/actions/index.mjs'],
    ['Recorded audit trail', 'Your reporting and ISO 20022 integration', 'core/actions/state.mjs'],
    ['Quickstart test keys', 'Your own signer (HSM, MPC, custodian) through the core, or unsigned transactions in prepare mode', 'core/index.mjs'],
    ['Interlock\'s own tokens and slots', 'Yours: check them with the conformance suites (npm run conformance)', 'core/conformance.mjs'],
    ['CDM TransferInstruction in and out', 'Your post-trade systems, through the documented mapping', 'docs/cdm-mapping.md'],
  ];

  const codeUrl = (p) => `${REPO}/${p.endsWith('/') || !/\.\w+$/.test(p) ? 'tree' : 'blob'}/${(REC && REC.commit && !REC.commit.dirty && REC.commit.sha) || 'main'}/${p}`;

  // ============ Story playback model ============

  /** Frames for a story given the fork choices: steps, forks, and the "back at the fork" frame after a side branch. */
  function buildFrames(story, choices) {
    const frames = [];
    let mainStep = null; // last main-line step: the chain state a rewound side branch returns to
    for (const item of story.steps) {
      if (!item.fork) {
        frames.push({ type: 'step', step: item, main: true });
        mainStep = item;
        continue;
      }
      const f = item.fork;
      const main = f.options.find((o) => o.continues);
      const chosen = f.options.find((o) => o.id === choices[f.id]);
      frames.push({ type: 'fork', fork: f, chosen: chosen || null, atStep: mainStep });
      if (!chosen) return { frames, complete: false };
      if (!chosen.continues) {
        chosen.steps.forEach((s) => frames.push({ type: 'step', step: s, main: false, branch: chosen, fork: f }));
        frames.push({ type: 'rejoin', fork: f, side: chosen, main, atStep: mainStep });
      }
      main.steps.forEach((s) => {
        frames.push({ type: 'step', step: s, main: true, branch: main, fork: f });
        mainStep = s;
      });
    }
    frames.push({ type: 'end' });
    return { frames, complete: true };
  }

  /** The steps whose effects are on the chain at frame i (side-branch steps drop out once the chain is rewound). */
  function effectiveSteps(frames, i) {
    const out = [];
    for (let k = 0; k <= i && k < frames.length; k++) {
      const fr = frames[k];
      if (fr.type === 'step') out.push(fr.step);
      if (fr.type === 'rejoin') {
        const sideIds = new Set(fr.side.steps.map((s) => s.id));
        for (let j = out.length - 1; j >= 0; j--) if (sideIds.has(out[j].id)) out.splice(j, 1);
      }
    }
    return out;
  }

  function stateAt(frames, i) {
    const eff = effectiveSteps(frames, i);
    return eff.length ? eff[eff.length - 1].state : REC.baseline.state;
  }

  // ============ Router and tour ============

  const ui = {
    route: null,
    play: {}, // per story: {choices, frame}
    prevState: null,
  };

  function storyById(id) {
    return REC.stories.find((s) => s.id === id);
  }

  function tour() {
    const t = [{ path: '/' }];
    for (const s of REC.stories) for (const tab of ['meet', 'today', 'play', 'proves']) t.push({ path: `/story/${s.id}/${tab}` });
    t.push({ path: '/interop' }, { path: '/connects' }, { path: '/unsolved' }, { path: '/build' });
    return t;
  }

  function parseRoute() {
    const raw = (location.hash || '#/').slice(1) || '/';
    const m = /^\/story\/([a-z]+)\/(meet|today|play|proves)$/.exec(raw);
    if (m && storyById(m[1])) return { path: raw, view: 'story', story: m[1], tab: m[2] };
    if (['/interop', '/connects', '/unsolved', '/build'].includes(raw)) return { path: raw, view: raw.slice(1) };
    return { path: '/', view: 'home' };
  }

  function go(path, { frame } = {}) {
    if (frame !== undefined) {
      const r = /^\/story\/([a-z]+)\/play$/.exec(path);
      if (r) playState(r[1]).frame = frame;
    }
    if (location.hash === `#${path}`) render();
    else location.hash = path;
  }

  function playState(id) {
    ui.play[id] = ui.play[id] || { choices: {}, frame: 0 };
    return ui.play[id];
  }

  function framesFor(id) {
    const ps = playState(id);
    return buildFrames(storyById(id), ps.choices).frames;
  }

  function next() {
    const r = ui.route;
    if (r.view === 'story' && r.tab === 'play') {
      const ps = playState(r.story);
      const frames = framesFor(r.story);
      const fr = frames[ps.frame];
      if (fr && fr.type === 'fork' && !fr.chosen) {
        choose(r.story, fr.fork.id, fr.fork.options.find((o) => o.continues).id);
        return;
      }
      if (ps.frame < frames.length - 1) {
        ps.frame += 1;
        render();
        return;
      }
    }
    const t = tour();
    const i = t.findIndex((x) => x.path === r.path);
    if (i >= 0 && i < t.length - 1) {
      const target = t[i + 1].path;
      const m = /^\/story\/([a-z]+)\/play$/.exec(target);
      go(target, m ? { frame: 0 } : {});
    }
  }

  function back() {
    const r = ui.route;
    if (r.view === 'story' && r.tab === 'play') {
      const ps = playState(r.story);
      if (ps.frame > 0) {
        ps.frame -= 1;
        render();
        return;
      }
    }
    const t = tour();
    const i = t.findIndex((x) => x.path === r.path);
    if (i > 0) {
      const target = t[i - 1].path;
      const m = /^\/story\/([a-z]+)\/play$/.exec(target);
      go(target, m ? { frame: framesFor(m[1]).length - 1 } : {});
    }
  }

  function choose(storyId, forkId, optionId) {
    const ps = playState(storyId);
    const frames = framesFor(storyId);
    const at = frames.findIndex((f) => f.type === 'fork' && f.fork.id === forkId);
    // A new choice at a fork replaces it and every later choice.
    const story = storyById(storyId);
    const forkIds = [];
    const collect = (list) => list.forEach((x) => x.fork && forkIds.push(x.fork.id));
    collect(story.steps);
    const keep = {};
    for (const id of forkIds) {
      if (id === forkId) break;
      if (ps.choices[id]) keep[id] = ps.choices[id];
    }
    keep[forkId] = optionId;
    ps.choices = keep;
    ps.frame = at + 1;
    render();
  }

  function navButtons(extraNext) {
    const t = tour();
    const r = ui.route;
    const i = t.findIndex((x) => x.path === r.path);
    const atStart = i <= 0 && !(r.view === 'story' && r.tab === 'play' && playState(r.story).frame > 0);
    const atEnd = i === t.length - 1;
    return h(
      'div',
      { class: 'pager' },
      h('button', { type: 'button', id: 'back', class: 'ghost', disabled: atStart, onclick: back }, '← Back'),
      h('button', { type: 'button', id: 'next', class: 'primary', disabled: atEnd, onclick: next }, extraNext || 'Next →'),
    );
  }

  // ============ Views ============

  function renderProvenance() {
    const p = $('#provenance');
    if (!REC) {
      p.textContent = 'No recording found.';
      return;
    }
    const c = REC.commit || {};
    const where = REC.network === 'sepolia' ? 'Sepolia testnet' : `a local chain (chain id ${REC.chainId})`;
    const commit = c.sha ? h('a', { href: `${REPO}/commit/${c.sha}` }, h('code', {}, c.short)) : h('code', {}, 'unknown');
    p.replaceChildren(
      'Recorded from the contracts at commit ',
      commit,
      c.dirty ? ' (with local changes)' : '',
      ` on ${REC.recordedAt.slice(0, 10)}, on ${where}. Every result below is played back from that recording.`,
      REC.realDataNotice ? h('span', { class: 'notice' }, ` ${REC.realDataNotice}`) : '',
      ' ',
      REC.network === 'sepolia' ? h('a', { href: location.pathname }, 'Local recording') : h('a', { href: '?recording=sepolia' }, 'Sepolia recording'),
    );
  }

  function viewMissing() {
    if (WANT_SEPOLIA) {
      return h('section', { class: 'card' },
        h('h1', {}, 'No Sepolia recording yet'),
        h('p', {}, 'The Sepolia recording is made by hand by the maintainers (.github/workflows/record-sepolia.yml), reviewed, then committed to web/recordings/. Until then, the local recording is the demo.'),
        h('p', {}, h('a', { href: location.pathname }, 'Open the local recording')));
    }
    return h(
      'section',
      { class: 'card' },
      h('h1', {}, 'No recording yet'),
      h('p', {}, 'This page plays back a recording of the real contracts. Make one from a checkout of the repository:'),
      h('pre', {}, 'npm install\nnpm run record'),
      h('p', {}, 'Then reload this page. The recording is written to web/data/demo.js and web/data/demo.json.'),
    );
  }

  function tokenCard(t) {
    const story = REC.stories.find((s) => s.token === t.symbol);
    const st = REC.baseline.state.tokens[t.symbol];
    return h(
      'article',
      { class: 'product card', 'data-token': t.symbol },
      h('div', { class: 'product-head' }, h('span', { class: `avatar inst inst-${(t.monogram || 'x').toLowerCase()} lg`, 'aria-hidden': 'true' }, t.monogram || '?'), h('div', {}, h('h3', {}, story ? `${story.letter} · ${story.title}` : t.name), h('p', { class: 'muted' }, t.institution || ''))),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Token'), h('dd', {}, `${t.symbol} · ${t.name}`),
        h('dt', {}, 'Who may hold it'), h('dd', {}, t.requiredTopics.map(topicWord).join(', ')),
        h('dt', {}, 'Status'), h('dd', {}, h('span', { class: 'live' }, st && st.paused ? 'Paused' : 'Live'), ` · supply ${fmtAmount(st ? st.totalSupply : '0')}`),
      ),
      story ? h('a', { class: 'button', href: `#/story/${story.id}/meet` }, `Open story ${story.letter}`) : null,
    );
  }

  function topicWord(t) {
    return { KYC: 'KYC', AML: 'AML', COUNTRY: 'country', ACCREDITATION: 'accreditation', SANCTIONS: 'sanctions' }[t] || t.toLowerCase().replace(/_/g, ' ');
  }

  function viewHome() {
    const tokens = PRODUCT_TOKENS().map(tokenBySymbol).filter(Boolean);
    return h(
      'section',
      { class: 'home' },
      h('div', { class: 'hero' },
        h('p', { class: 'eyebrow' }, 'Interlock · a reference implementation for interoperable regulated tokens on Ethereum'),
        h('h1', {}, 'Verify once, hold anywhere the rules allow, settle across instruments.'),
        h('p', { class: 'lead' }, 'Interlock is open-source code showing how regulated tokens from different institutions can work together on Ethereum. An investor or a bank is verified once, and every instrument checks that same credential under its own rules. Any app can ask any token the same three questions through ERC-7943. Two instruments settle against each other in one transaction, from a trade described in the FINOS Common Domain Model. It is not a standard: it is one tested way to connect existing ones.'),
        h('div', { class: 'actions' }, h('a', { class: 'button primary', id: 'start', href: '#/story/deposit/meet' }, 'Start the tour'), h('a', { class: 'button', href: '#/connects' }, 'What it connects'), h('a', { class: 'button', href: '#/unsolved' }, "What's not solved yet")),
      ),
      h('section', { class: 'card film', 'aria-labelledby': 'film-title' },
        h('div', {},
          h('h2', { id: 'film-title' }, 'The Second Gate'),
          h('p', { class: 'muted' }, 'A 61-second animated introduction to shared investor credentials and issuer rules.'),
          h('a', { href: 'media/the-second-gate.mp4', download: 'the-second-gate.mp4' }, 'Download the MP4'),
        ),
        h('video', {
          'aria-labelledby': 'film-title', controls: true, playsinline: true, preload: 'none',
          poster: 'media/the-second-gate.jpg', src: 'media/the-second-gate.mp4', width: 1280, height: 720,
        }),
      ),
      tokens.length ? h('h2', {}, 'Three instruments') : null,
      tokens.length ? h('div', { class: 'grid3' }, tokens.map(tokenCard)) : null,
      h('h2', {}, 'Instruments that work together'),
      h('div', { class: 'grid2' }, REC.stories.filter((x) => x.chapter === 'together').map((st) => h('article', { class: 'card product', 'data-story': st.id },
        h('h3', {}, `${st.letter} · ${st.title}`),
        h('p', { class: 'muted' }, st.institution),
        h('p', {}, st.id === 'dvp' ? 'A fund share against a tokenized deposit, from a CDM trade instruction, in one transaction.' : 'An interbank deposit token whose holders are recognised by their GLEIF vLEI credential, through OnChainTrust.'),
        h('a', { class: 'button', href: `#/story/${st.id}/meet` }, `Open story ${st.letter}`)))),
      h('section', { class: 'card', id: 'what-you-get' },
        h('h2', {}, 'What you get'),
        h('div', { class: 'scroll' }, h('table', { class: 'data' }, h('tbody', {}, [
          ['A bank, fund manager or issuer', 'Your product as one config file, issuer controls, an audit trail, and settlement against another institution\'s instrument'],
          ['A KYC or identity provider', 'One credential many issuers rely on; revocation that takes effect at once; vLEI for entities'],
          ['A developer or vendor', 'A core library with your own signer, and conformance suites to test your token or eligibility check'],
          ['An architect or risk team', 'A written spec, decision records, a threat model, and a plain list of limits'],
          ['A post-trade or operations team', 'A reference mapping between on-chain events and FINOS CDM'],
        ].map(([a, b]) => h('tr', {}, h('th', { scope: 'row' }, a), h('td', {}, b))))))),
      h('section', { class: 'card' },
        h('h2', {}, 'The cast'),
        h('p', { class: 'muted' }, 'All fictional.'),
        h('ul', { class: 'cast' },
          REC.cast.institutions.map((i) => h('li', {}, avatar(i.signers.issuer.id), h('span', {}, h('strong', {}, i.name), h('span', { class: 'muted' }, ` · issuer and compliance of ${REC.tokens.find((t) => t.institution === i.name)?.symbol || '?'}`)))),
          REC.cast.providers.map((p) => h('li', {}, avatar(p.id), h('span', {}, h('strong', {}, p.name), h('span', { class: 'muted' }, ` · ${p.note}`)))),
          REC.cast.investors.map((i) => h('li', {}, avatar(i.id), h('span', {}, h('strong', {}, i.name), h('span', { class: 'muted' }, ` · ${i.who}. ${i.summary}`)))),
          (REC.cast.entities || []).filter((e) => e.institution === 'Larkmoor Bank').map((e) => h('li', {}, avatar(e.id), h('span', {}, h('strong', {}, e.institution), h('span', { class: 'muted' }, ` · a second bank, recognised by its vLEI credential (test LEI ${e.lei})`)))),
        ),
      ),
      h('section', { class: 'card' },
        h('h2', {}, 'How this page works'),
        h('p', {}, 'A recorder script deployed the product templates on a fresh Ethereum chain and ran every story through Interlock\'s action library, the same code its tests, command line and console use. At each fork it took a chain snapshot, recorded the other branch, and rewound. This page only plays that recording back; each step shows its transaction hash and, where it applies, its FINOS CDM view.'),
        h('details', {}, h('summary', {}, `Setup before every story (${REC.setup.length} steps, all recorded)`), h('ol', { class: 'setup' }, REC.setup.map((s) => h('li', {}, `${s.title} — `, h('strong', {}, s.result.ok ? 'accepted' : 'refused'), ' ', s.txs.length ? txLink(s.txs[0]) : '')))),
      ),
      navButtons('Start the tour →'),
    );
  }

  function storyTabs(story, tab) {
    const tabs = [['meet', 'Meet'], ['today', 'Today vs on-chain'], ['play', 'Play'], ['proves', 'What this proves']];
    return h('nav', { class: 'tabs', 'aria-label': `Story ${story.letter}` },
      tabs.map(([id, label]) => h('a', { href: `#/story/${story.id}/${id}`, 'aria-current': id === tab ? 'page' : null }, label)));
  }

  function storyHeader(story) {
    const t = tokenBySymbol(story.token);
    const syms = storyTokens(story).length <= 2 && story.chapter === 'together' ? storyTokens(story).join(story.id === 'dvp' ? ' ⇄ ' : ' · ') : t.symbol;
    return h('div', { class: 'story-head' },
      h('span', { class: `avatar inst inst-${(t.monogram || 'x').toLowerCase()} lg`, 'aria-hidden': 'true' }, t.monogram),
      h('div', {}, h('p', { class: 'eyebrow' }, `Story ${story.letter} · ${syms}`), h('h1', {}, `${story.title}: ${story.institution}`)));
  }

  function tokenRules(t) {
    if (t.eligibilitySource === 'vlei') {
      const types = (t.vlei && t.vlei.credentialTypes) || ['LE'];
      return [
        h('li', {}, `Eligibility: OnChainTrust's VleiEligibility slot, not Shibui. A holder needs a live attestation from the vLEI bridge, of credential type ${types.map((x) => `${x} (${CRED_TYPES[x] || 'vLEI credential'})`).join(' or ')}.`),
        REC.network === 'sepolia'
          ? h('li', {}, 'In this recording the bridge is OnChainTrust\'s live bridge on Sepolia, with real test credentials; the institutions they name are not shown.')
          : h('li', {}, 'In this recording the bridge is a local test instance under the same schema as OnChainTrust\'s live bridge; the banks and their LEIs are fictional.'),
        h('li', {}, `${t.labels.issue} creates tokens, ${t.labels.redeem.toLowerCase()} burns them.`),
      ];
    }
    const rules = [h('li', {}, `Required topics: ${t.requiredTopics.map(topicWord).join(', ')}. Every holder needs a live credential from a trusted KYC provider that passes each topic's policy.`)];
    if (t.country) rules.push(h('li', {}, `Country: ${t.country.mode === 'allow' ? 'only' : 'not'} ${t.country.codes.join(', ')} (ISO 3166-1 numeric).`));
    if (t.accreditation) rules.push(h('li', {}, `Accreditation types accepted: ${t.accreditation.allowedTypes.join(', ')} (2 accredited, 3 qualified purchaser, 4 institutional).`));
    rules.push(h('li', {}, `${t.labels.issue} creates tokens, ${t.labels.redeem.toLowerCase()} burns them.`));
    return rules;
  }

  function viewMeetTogether(story) {
    const base = REC.baseline.state;
    const syms = storyTokens(story);
    return h('section', {},
      storyHeader(story), storyTabs(story, 'meet'),
      h('div', { class: 'grid2' }, syms.map((sym) => {
        const t = tokenBySymbol(sym);
        return h('section', { class: 'card', 'data-token': sym },
          h('h2', {}, `${sym} · ${t.institution}`),
          h('ul', {}, tokenRules(t)),
          t.template ? h('details', {}, h('summary', {}, `The whole product definition (${t.templateFile})`), h('pre', { class: 'json' }, JSON.stringify(t.template, null, 2))) : null);
      })),
      story.id === 'dvp' ? h('section', { class: 'card' },
        h('h2', {}, 'How the settlement works'),
        h('ol', {},
          h('li', {}, 'The trade arrives as a FINOS CDM TransferInstruction: a security leg (dMMF) and a cash leg (dDEP).'),
          h('li', {}, 'Each party approves its own leg for DvPSettlement, a generic contract that never holds tokens.'),
          h('li', {}, 'The seller proposes the trade with the hash of the CDM instruction; the buyer affirms it.'),
          h('li', {}, 'The affirmation moves both legs in one transaction. Each token checks its own sender and recipient, so any refusal reverts both legs.'),
          h('li', {}, 'The back office receives the same CDM instruction, marked Settled, with the transaction hash.'))) : null,
      story.id === 'vlei' ? h('section', { class: 'card' },
        h('h2', {}, 'The banks'),
        (REC.cast.entities || []).some((e) => e.realTestData)
          ? h('p', { class: 'muted' }, 'Wallets holding real test credentials from OnChainTrust\'s bridge on Sepolia. Those credentials name real institutions, so the names are not shown: follow each link to the public test data.')
          : h('p', { class: 'muted' }, 'Fictional banks with test LEIs that belong to no real entity. OnChainTrust\'s real Sepolia credentials name real institutions, so they are never shown here.'),
        h('ul', { class: 'cast' }, (REC.cast.entities || []).map((e) => h('li', {}, avatar(e.id), h('span', {}, h('strong', {}, e.name),
          e.realTestData
            ? h('span', { class: 'muted' }, ' · ', h('a', { href: e.attestation, rel: 'noopener', target: '_blank' }, "test data from OnChainTrust's bridge"), ' (the institution is not named here)')
            : h('span', { class: 'muted' }, ` · vLEI ${e.credType} credential, test LEI ${e.lei}`)))))) : null,
      h('section', { class: 'card' },
        h('h2', {}, 'Who may hold what at the start'),
        h('div', { class: 'scroll' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Holder'), syms.map((sym) => h('th', { scope: 'col' }, sym)))),
          h('tbody', {}, storyParties(story).map((id) => h('tr', {}, h('th', { scope: 'row' }, who(id)), syms.map((sym) => h('td', {}, verdict(base.matrix[id][sym])))))),
        )),
      ),
      navButtons(),
    );
  }

  function viewMeet(story) {
    if (story.chapter === 'together') return viewMeetTogether(story);
    const t = tokenBySymbol(story.token);
    const inst = REC.cast.institutions.find((i) => i.name === story.institution);
    const base = REC.baseline.state;
    const rules = [];
    rules.push(h('li', {}, `Required topics: ${t.requiredTopics.map(topicWord).join(', ')}. Every holder needs a live credential from a trusted KYC provider that passes each topic's policy.`));
    if (t.country) rules.push(h('li', {}, `Country: ${t.country.mode === 'allow' ? 'only' : 'not'} ${t.country.codes.join(', ')} (ISO 3166-1 numeric).`));
    if (t.accreditation) rules.push(h('li', {}, `Accreditation types accepted: ${t.accreditation.allowedTypes.join(', ')} (2 accredited, 3 qualified purchaser, 4 institutional).`));
    rules.push(h('li', {}, `${t.labels.issue} creates tokens, ${t.labels.redeem.toLowerCase()} burns them.`));
    return h('section', {},
      storyHeader(story), storyTabs(story, 'meet'),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' },
          h('h2', {}, 'The institution'),
          h('p', {}, `${story.institution} is the issuer and the compliance officer of ${t.symbol}. Each role signs with its own key:`),
          h('ul', { class: 'cast' }, Object.entries(inst.signers).map(([role, s]) => h('li', {}, avatar(s.id), h('span', {}, h('strong', {}, s.name), h('span', { class: 'muted' }, role === 'issuer' ? ' · issues and redeems' : ' · pauses, freezes, forces transfers'))))),
          h('h3', {}, 'Who may hold this'),
          h('ul', {}, rules),
        ),
        h('section', { class: 'card' },
          h('h2', {}, 'The whole product definition'),
          h('p', { class: 'muted' }, `${t.templateFile}, as deployed for this recording (the recorder adds the "roles" line). No product-specific code.`),
          h('pre', { class: 'json' }, JSON.stringify(t.template, null, 2)),
        ),
      ),
      h('section', { class: 'card' },
        h('h2', {}, 'The investors at the start'),
        h('div', { class: 'scroll' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Investor'), h('th', { scope: 'col' }, 'Credential'), h('th', { scope: 'col' }, `May hold ${t.symbol}?`))),
          h('tbody', {}, REC.cast.investors.map((i) => h('tr', {}, h('th', { scope: 'row' }, who(i.id)), h('td', {}, i.summary), h('td', {}, verdict(base.matrix[i.id][t.symbol]))))),
        )),
      ),
      navButtons(),
    );
  }

  function verdict(cell) {
    if (!cell) return '';
    if (cell.eligible) return h('span', { class: 'verdict yes' }, 'yes');
    const topics = [...new Set(cell.reasons.map((r) => r.text.split(':')[0]))];
    return h('span', { class: 'verdict no', title: cell.reasons.map((r) => r.text).join(', ') }, `no: ${topics.join(', ')}`);
  }

  function viewToday(story) {
    const p = PRODUCT[story.id];
    const lane = (title, rows, cls) =>
      h('section', { class: `lane card ${cls}` }, h('h2', {}, title), h('ol', {}, rows.map(([party, text]) => h('li', {}, h('span', { class: 'party' }, party), h('span', {}, text)))));
    return h('section', {},
      storyHeader(story), storyTabs(story, 'today'),
      h('p', { class: 'badge-line' }, h('span', { class: 'badge' }, 'Illustrative'), ' Process steps and parties only; no timings or costs are claimed.'),
      h('div', { class: 'grid2' }, lane('Today', p.today, 'today'), lane('On-chain with the kit', p.chain, 'chain')),
      h('p', { class: 'callout' }, 'Across all three products: one identity credential, checked the same way by every product, instead of onboarding per product.'),
      navButtons(),
    );
  }

  function viewProves(story) {
    const p = PRODUCT[story.id];
    const all = [];
    const walk = (list) => list.forEach((x) => (x.fork ? x.fork.options.forEach((o) => walk(o.steps)) : all.push(x)));
    walk(story.steps);
    const evidence = (ids) =>
      ids.map((id) => all.find((s) => s.id === id)).filter(Boolean).map((s) => h('li', {}, h('strong', {}, `${s.id} `), s.title, ' — ', h('span', { class: s.result.ok ? 'ok' : 'no' }, s.result.ok ? 'accepted' : `refused${s.result.reasons && s.result.reasons.length ? `: ${s.result.reasons.map((r) => r.text).join(', ')}` : ''}`), ' ', s.txs.length ? txLink(s.txs[0]) : ''));
    return h('section', {},
      storyHeader(story), storyTabs(story, 'proves'),
      h('ul', { class: 'proves' }, p.proves.map(([text, ids]) => h('li', { class: 'card' }, h('p', { class: 'claim' }, text), h('ul', { class: 'evidence' }, evidence(ids))))),
      navButtons(),
    );
  }

  // ---- Play ----

  const TOKEN_STOP_TEXT = {
    EnforcedPause: 'paused',
    ExpectedPause: 'not paused',
    ERC7943InsufficientUnfrozenBalance: 'frozen: unfrozen balance too low',
    ERC20InsufficientBalance: 'balance too low',
  };
  const EAS_STATUSES = new Set(['NOT_REGISTERED', 'REVOKED', 'EXPIRED']);

  function diagramStates(step) {
    const s = {};
    const chips = {};
    const add = (node, text) => (chips[node] = chips[node] || []).push(text);
    const r = step.result;
    const nodes = ['actor', 'token', 'check', 'shibui', 'eas', 'result'];
    nodes.forEach((n) => (s[n] = 'idle'));
    s.actor = 'pass';
    if (step.kind === 'credential') {
      s.eas = 'pass';
      if (step.action !== 'revokeCredential') s.shibui = 'pass';
      if (step.action === 'onboardInvestor') { add('eas', 'credential issued'); add('shibui', 'registered per token and topic'); }
      if (step.action === 'revokeCredential') add('eas', 'credential revoked');
      if (step.action === 'authorizeProvider') { add('eas', 'authorization attested'); add('shibui', 'attester trusted'); }
      if (step.action === 'replaceAttester') { add('shibui', 'old attester removed, new one trusted'); add('eas', 'new credentials issued'); }
      if (step.action === 'onboardEntity') { add('eas', 'vLEI credential issued'); add('shibui', `registered on ${(step.result.registrations || []).join(', ')}`); }
      if (step.action === 'revokeEntity') { s.shibui = 'idle'; add('eas', 'vLEI credential revoked'); }
    } else {
      s.token = 'pass';
      if ((step.kind === 'token' || step.kind === 'settlement') && step.checks.length) {
        s.check = 'pass';
        s.shibui = 'pass';
        s.eas = 'pass';
        if (step.kind === 'settlement' && r.ok) add('token', 'both legs settled in one transaction');
      } else {
        add('token', step.kind === 'control' ? 'issuer control: no eligibility check' : 'redeem: no eligibility check');
      }
    }
    if (!r.ok) {
      if (step.stoppedAt === 'eligibility') {
        s.check = 'fail';
        for (const reason of r.reasons) {
          const node = EAS_STATUSES.has(reason.status) ? 'eas' : 'shibui';
          s[node] = 'fail';
          add(node, reason.text);
        }
        if (s.eas !== 'fail' && s.shibui === 'fail') s.eas = 'pass';
        if (s.shibui !== 'fail' && s.eas === 'fail') s.shibui = 'pass';
      } else if (step.stoppedAt === 'token') {
        s.token = 'fail';
        s.check = s.shibui = s.eas = 'idle';
        delete chips.token;
        add('token', TOKEN_STOP_TEXT[r.error] || (r.role ? `missing ${r.role}` : r.error));
      } else {
        s.actor = 'fail';
        add('actor', r.role ? `missing ${r.role}` : r.error || 'refused');
      }
    }
    s.result = r.ok ? 'pass' : 'fail';
    return { s, chips };
  }

  function diagram(step) {
    const t = step.token ? tokenBySymbol(step.token) : null;
    const { s, chips } = diagramStates(step);
    const vlei = (step.tokens || []).some(isVlei) || ['onboardEntity', 'revokeEntity'].includes(step.action);
    const settlement = step.kind === 'settlement';
    const label = {
      actor: [nameOf(step.actor), 'signs the transaction'],
      token: settlement ? [step.tokens.join(' ⇄ '), 'DvPSettlement: both legs or neither'] : [t ? t.symbol : 'Token', t ? 'ERC-20 + ERC-7943' : 'not involved'],
      check: ['Eligibility check', settlement ? 'each token asks its own slot' : 'the token asks its slot'],
      shibui: vlei ? ['VleiEligibility', 'OnChainTrust slot: a live vLEI bridge attestation'] : ['Shibui', 'verifier, trusted attesters, topic policies'],
      eas: vlei ? ['EAS', 'vLEI bridge attestations'] : ['EAS', 'credentials and revocations'],
      result: [step.result.ok ? 'Accepted' : 'Refused', step.result.ok ? 'on chain' : 'nothing changes'],
    };
    const order = ['actor', 'token', 'check', 'shibui', 'eas', 'result'];
    const words = { pass: 'passed', fail: 'failed here', idle: 'not involved' };
    return h('ol', { class: 'diagram', 'aria-label': 'Operation path' },
      order.map((n, i) => h('li', { class: `node ${s[n]}`, 'data-node': n, style: `--i:${i}` },
        h('span', { class: 'node-title' }, label[n][0]),
        h('span', { class: 'node-sub' }, label[n][1]),
        h('span', { class: 'sr-only' }, ` (${words[s[n]]})`),
        chips[n] ? h('span', { class: 'chips' }, chips[n].map((c) => h('span', { class: `chip ${s[n] === 'fail' ? 'bad' : ''}` }, c))) : null,
      )));
  }

  function resultBlock(step) {
    const r = step.result;
    const parts = [];
    parts.push(h('p', { class: `outcome ${r.ok ? 'ok' : 'no'}`, id: 'step-result' }, h('strong', {}, r.ok ? 'Accepted' : 'Refused'), r.ok ? '' : `: ${r.message.replace(/^Refused: /, '')}`));
    if (!r.ok && r.reasons && r.reasons.length) parts.push(h('p', { class: 'reasons' }, 'Reason by topic: ', r.reasons.map((x) => h('span', { class: 'chip bad' }, x.text))));
    if (r.credential) {
      parts.push(h('p', { class: 'muted' }, `Credential: KYC ${r.credential.kycStatus === 1 ? 'verified' : r.credential.kycStatus}, AML ${r.credential.amlStatus === 0 ? 'clear' : r.credential.amlStatus}, sanctions ${r.credential.sanctionsStatus === 0 ? 'clear' : r.credential.sanctionsStatus}, country ${r.credential.countryCode}, accreditation: ${r.credential.accreditation}. Registered for ${r.registrations.length} token topics.`));
    }
    if (r.eligibility) parts.push(rotationTable(r));
    if (r.entity) {
      const until = new Date(r.entity.expiresAt * 1000).toISOString().slice(0, 10);
      parts.push(h('p', { class: 'muted' }, REC.network === 'sepolia'
        ? `vLEI ${r.entity.credType} credential from OnChainTrust's bridge: real test data, so the institution and its LEI are not shown here. Valid until ${until}. Registered on ${(r.registrations || []).join(', ')}.`
        : `vLEI ${r.entity.credType} credential of ${r.entity.legalName}, test LEI ${r.entity.lei} (fictional), valid until ${until}. Registered on ${(r.registrations || []).join(', ')}.`));
    }
    if (r.trade && step.kind === 'settlement') {
      parts.push(h('ol', { class: 'trade-steps', 'aria-label': 'Settlement steps' }, r.trade.steps.map((x) => h('li', { class: x.ok ? 'ok' : 'no' }, `${x.what}: ${x.ok ? 'done' : `refused (${x.error})`}`, ' ', x.txHash ? txLink(x.txHash) : ''))));
      if (r.trade.ref) parts.push(h('p', { class: 'muted' }, 'On-chain reference of the trade = keccak256 of the CDM instruction: ', h('code', { class: 'tx', title: r.trade.ref }, short(r.trade.ref))));
    }
    return parts;
  }

  /** Story F: the FINOS CDM view of a step, as recorded (validated with finos-cdm in CI). */
  function cdmBlock(step) {
    if (!step.cdm || (!step.cdm.in && !step.cdm.out)) return null;
    const part = (title, obj) => (obj ? h('div', {}, h('h3', {}, title), h('pre', { class: 'json' }, JSON.stringify(obj, null, 2))) : null);
    const status = (o) => (o && o.transferState && o.transferState[0] ? o.transferState[0].transferStatus : '');
    return h('details', { class: 'cdm', id: 'cdm-view' },
      h('summary', {}, `CDM view · FINOS Common Domain Model ${step.cdm.out ? step.cdm.out['@version'] : step.cdm.in['@version']}`),
      h('p', { class: 'muted' }, step.cdm.in ? 'The trade arrives as a CDM TransferInstruction and leaves as the same instruction, Settled. Both validated with CDM\'s own tooling.' : 'The movement as a CDM TransferInstruction, Settled, as a back office would receive it.'),
      part(`In: TransferInstruction (${status(step.cdm.in)})`, step.cdm.in),
      step.cdm.in && !step.cdm.out ? h('p', { class: 'no' }, 'Nothing settled, so there is no Settled answer.') : null,
      part(`Out: TransferInstruction (${status(step.cdm.out)})`, step.cdm.out));
  }

  function rotationTable(r) {
    const phases = [['before', 'Before'], ['afterRemoval', 'Old provider removed'], ['after', 'New provider re-attested']];
    const tokens = r.removedFrom;
    return h('div', { class: 'scroll' }, h('table', { class: 'data rotation' },
      h('caption', {}, `Who may hold ${tokens.join(', ')} during the vendor change (read from the chain at each phase)`),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Investor'), phases.map(([, l]) => h('th', { scope: 'col' }, l)))),
      h('tbody', {}, investorIds().map((id) => h('tr', {}, h('th', { scope: 'row' }, nameOf(id)), phases.map(([k]) => h('td', {}, tokens.map((sym) => (r.eligibility[k][id][sym] ? h('span', { class: 'verdict yes' }, 'yes') : h('span', { class: 'verdict no' }, 'no')))))))),
    ));
  }

  function checksBlock(step) {
    if (!step.checks.length) return null;
    return h('ul', { class: 'checks' }, step.checks.map((c) => h('li', {},
      h('strong', {}, `${nameOf(c.party)} (${c.role}${c.token && !/ d[A-Z]/.test(` ${c.role}`) && (step.tokens || []).length > 1 ? `, ${c.token}` : ''})`), ': ',
      c.topics.map((t) => h('span', { class: `chip ${t.status === 'OK' ? 'good' : 'bad'}` }, t.text)))));
  }

  function matrixTable(state, prev, story) {
    const syms = storyTokens(story);
    return h('table', { class: 'data matrix', id: 'matrix' },
      h('caption', {}, 'Who may hold what'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Holder'), syms.map((s) => h('th', { scope: 'col' }, s)))),
      h('tbody', {}, storyParties(story).map((id) => h('tr', {}, h('th', { scope: 'row' }, nameOf(id)), syms.map((sym) => {
        const cell = state.matrix[id][sym];
        const was = prev && prev.matrix[id][sym];
        const changed = was && (was.eligible !== cell.eligible || JSON.stringify(was.reasons) !== JSON.stringify(cell.reasons));
        return h('td', { 'data-investor': id, 'data-token': sym, class: changed ? 'changed' : null }, verdict(cell));
      })))));
  }

  function balancesTable(state, prev, story) {
    const syms = storyTokens(story);
    return h('table', { class: 'data balances', id: 'balances' },
      h('caption', {}, 'Balances'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Holder'), syms.map((s) => h('th', { scope: 'col' }, s)))),
      h('tbody', {},
        storyParties(story).map((id) => h('tr', {}, h('th', { scope: 'row' }, nameOf(id)), syms.map((sym) => {
          const b = state.balances[id][sym];
          const was = prev && prev.balances[id][sym];
          const changed = was && (was.balance !== b.balance || was.frozen !== b.frozen);
          const num = h('span', { class: 'num', 'data-from': changed ? was.balance : null, 'data-to': b.balance }, fmtAmount(b.balance));
          return h('td', { 'data-investor': id, 'data-token': sym, class: changed ? 'changed' : null }, num, Number(b.frozen) > 0 ? h('span', { class: 'frozen' }, ` (${fmtAmount(b.frozen)} frozen)`) : null);
        }))),
        h('tr', { class: 'total' }, h('th', { scope: 'row' }, 'Supply'), syms.map((sym) => h('td', {}, fmtAmount(state.tokens[sym].totalSupply), state.tokens[sym].paused ? h('span', { class: 'chip bad' }, 'paused') : null))),
      ));
  }

  function animateNumbers(root) {
    if (reducedMotion()) return;
    root.querySelectorAll('.num[data-from]').forEach((el) => {
      const from = Number(el.dataset.from);
      const to = Number(el.dataset.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
      const t0 = performance.now();
      const dur = 600;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
        el.textContent = fmtAmount(k < 1 ? String(Math.round(v)) : el.dataset.to);
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function auditBlock(frames, i) {
    const eff = effectiveSteps(frames, i);
    const rows = eff.flatMap((s) => s.audit.map((e) => ({ ...e, step: s.id })));
    const row = (e) => h('tr', {}, h('td', {}, e.step || 'setup'), h('td', {}, e.actor || ''), h('td', {}, e.action), h('td', { class: 'detail' }, e.detail), h('td', {}, txLink(e.txHash)));
    return h('section', { class: 'card audit' },
      h('h2', {}, 'Audit trail'),
      h('p', { class: 'muted' }, 'Rebuilt from on-chain events after each step.'),
      h('div', { class: 'scroll' }, h('table', { class: 'data', id: 'audit' },
        h('thead', {}, h('tr', {}, ['Step', 'Who', 'Action', 'Detail', 'Transaction'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, rows.length ? rows.map(row) : h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Nothing yet in this story. Press Next.'))),
      )),
      h('details', {}, h('summary', {}, `Setup before the story (${REC.baseline.audit.length} entries)`), h('div', { class: 'scroll' }, h('table', { class: 'data' }, h('tbody', {}, REC.baseline.audit.map(row))))),
    );
  }

  function trail(story, frames, i) {
    return h('ol', { class: 'trail', 'aria-label': 'Steps so far' }, frames.slice(0, i + 1).map((fr, k) => {
      let text;
      let cls = '';
      if (fr.type === 'step') {
        text = `${fr.step.id} ${fr.step.title}`;
        cls = fr.step.result.ok ? 'ok' : 'no';
        if (!fr.main) cls += ' side';
      } else if (fr.type === 'fork') text = fr.chosen ? `You chose: ${fr.chosen.chose}` : 'Fork: choose what happens';
      else if (fr.type === 'rejoin') text = `Back at the fork: the chain is rewound; the story continues with "${fr.main.label}"`;
      else text = 'End of the story';
      return h('li', { class: `${cls} ${k === i ? 'current' : ''}` },
        h('button', { type: 'button', class: 'link', 'aria-current': k === i ? 'step' : null, onclick: () => { playState(story.id).frame = k; render(); } }, text));
    }));
  }

  function frameCard(story, frames, i) {
    const fr = frames[i];
    if (fr.type === 'fork') {
      return h('section', { class: 'card frame fork', id: 'frame', 'data-frame': 'fork' },
        h('p', { class: 'eyebrow' }, 'Your choice'),
        h('h2', {}, fr.fork.question),
        h('div', { class: 'choices' }, fr.fork.options.map((o) => h('button', {
          type: 'button',
          class: `choice ${fr.chosen && fr.chosen.id === o.id ? 'chosen' : ''} ${o.continues ? 'main' : ''}`,
          'data-option': o.id,
          'aria-pressed': fr.chosen && fr.chosen.id === o.id ? 'true' : 'false',
          onclick: () => choose(story.id, fr.fork.id, o.id),
        }, o.label, o.continues ? h('span', { class: 'muted' }, ' (the story continues this way)') : null))),
        h('p', { class: 'muted' }, 'Next takes the way the story continues. Both branches were recorded on the chain: the recorder took a snapshot here, played the other branch, and rewound.'),
      );
    }
    if (fr.type === 'rejoin') {
      return h('section', { class: 'card frame', id: 'frame', 'data-frame': 'rejoin' },
        h('p', { class: 'eyebrow' }, 'Back at the fork'),
        h('h2', {}, `That was "${fr.side.label}"`),
        h('p', {}, `The recorder rewound the chain to the fork (evm_revert). The story continues with: ${fr.main.label}. The tables show the chain as it was at the fork.`),
      );
    }
    if (fr.type === 'end') {
      return h('section', { class: 'card frame', id: 'frame', 'data-frame': 'end' },
        h('p', { class: 'eyebrow' }, `End of story ${story.letter}`),
        h('h2', {}, 'That is the whole story.'),
        h('p', {}, 'Next shows what it proves. You can also pick any step in the list to replay it, or go back to a fork and choose the other way.'),
      );
    }
    const step = fr.step;
    const inst = institutionOf(step.actor);
    return h('section', { class: `card frame step ${step.result.ok ? 'step-ok' : 'step-no'}`, id: 'frame', 'data-frame': 'step', 'data-step': step.id },
      h('p', { class: 'eyebrow' }, `Step ${step.id}${fr.branch && !fr.main ? ` · branch: ${fr.branch.chose}` : ''} · ${fmtTime(step.time)}`),
      h('div', { class: 'step-head' }, avatar(step.actor, 'lg'), h('div', {}, h('p', { class: 'muted' }, actorLine(step.actor, inst)), h('h2', {}, step.title))),
      diagram(step),
      h('p', { class: 'expect' }, `Expected: ${step.expected}. `, h('span', {}, `Result: ${step.result.ok ? 'accepted' : 'refused'}`), step.asExpected ? ' — as expected.' : ' — NOT as expected.'),
      resultBlock(step),
      checksBlock(step),
      cdmBlock(step),
      h('p', { class: 'txs' }, step.txs.length ? [`Transaction${step.txs.length > 1 ? `s (${step.txs.length})` : ''}: `, step.txs.slice(0, 3).map((t) => [txLink(t), ' ']), step.txs.length > 3 ? `and ${step.txs.length - 3} more` : ''] : 'No transaction: the call was refused in simulation, so nothing was sent.'),
    );
  }

  function actorLine(id, inst) {
    if (inst) return `${inst.name} · ${inst.role === 'issuer' ? 'issuer: issues and redeems' : 'compliance: pauses, freezes, forces transfers'}`;
    const p = REC.cast.providers.find((x) => x.id === id);
    if (p) return `${p.name} · KYC provider`;
    const inv = REC.cast.investors.find((x) => x.id === id);
    if (inv) return `${inv.name} · ${inv.who}`;
    const ent = entityOf(id);
    if (ent) return `${ent.institution} · its own wallet, recognised by its vLEI ${ent.credType} credential`;
    if (REC.cast.bridge && REC.cast.bridge.id === id) return `${REC.cast.bridge.name} · attests legal entities from their vLEI credentials, under OnChainTrust's bridge schema`;
    return `${nameOf(id)} · runs the kit and authorizes KYC providers`;
  }

  function viewPlay(story) {
    const ps = playState(story.id);
    const frames = framesFor(story.id);
    ps.frame = Math.max(0, Math.min(ps.frame, frames.length - 1));
    const i = ps.frame;
    const state = stateAt(frames, i);
    const prev = i > 0 ? stateAt(frames, i - 1) : null;
    const fr = frames[i];
    const nextLabel = fr.type === 'fork' && !fr.chosen ? 'Continue the story →' : fr.type === 'end' ? 'What this proves →' : 'Next →';
    const el = h('section', { class: 'play' },
      storyHeader(story), storyTabs(story, 'play'),
      h('div', { class: 'play-grid' },
        h('div', { class: 'play-main' }, frameCard(story, frames, i), navButtons(nextLabel)),
        h('aside', { class: 'play-side' },
          h('section', { class: 'card' }, h('div', { class: 'scroll' }, matrixTable(state, prev, story))),
          h('section', { class: 'card' }, h('div', { class: 'scroll' }, balancesTable(state, prev, story))),
          h('section', { class: 'card' }, h('h2', {}, 'Steps'), trail(story, frames, i)),
        ),
      ),
      auditBlock(frames, i),
    );
    requestAnimationFrame(() => animateNumbers(el));
    return el;
  }

  // ---- Interoperability, not solved, build on it ----

  function viewInterop() {
    const io = REC.interop;
    const yes = (b) => h('span', { class: `verdict ${b ? 'yes' : 'no'}` }, b ? 'true' : 'false');
    return h('section', {},
      h('h1', {}, 'One standard, three issuers'),
      h('p', { class: 'lead' }, 'A third-party app (a wallet, a lending desk, an exchange) knows nothing about Interlock. It only knows ERC-7943. It asks the same three questions of every issuer\'s token, Shibui-checked or vLEI-checked, and gets consistent answers, recorded from the chain.'),
      h('pre', { class: 'json' }, `// All the app needs: the ERC-7943 interface (id ${io.interfaceId})\n${io.functions.map((f) => `function ${f} view returns (bool)`).join('\n')}`),
      h('p', { class: 'muted' }, `Set up for this view: ${io.setup.map((s) => s.title).join('; ')}.`),
      h('div', { class: 'grid2' }, ALL_TOKENS().map((sym) => {
        const t = io.tokens.find((x) => x.symbol === sym);
        const tok = tokenBySymbol(sym);
        return h('section', { class: 'card', 'data-interop': sym },
          h('h2', {}, `${sym} · ${tok.institution}`),
          h('p', {}, 'supportsInterface(', h('code', {}, io.interfaceId), '): ', yes(t.supportsErc7943)),
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Wallet'), h('th', { scope: 'col' }, 'canSend'), h('th', { scope: 'col' }, 'canReceive'))),
            h('tbody', {}, investorIds().map((id) => h('tr', {}, h('th', { scope: 'row' }, nameOf(id)), h('td', {}, yes(t.parties[id].canSend)), h('td', {}, yes(t.parties[id].canReceive)))))),
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, `canTransfer(Bob → …, ${t.transferAmount})`), h('th', { scope: 'col' }, 'Answer'))),
            h('tbody', {}, Object.entries(t.transfers).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, `Bob → ${nameOf(k.split('->')[1])}`), h('td', {}, yes(v)))))),
        );
      })),
      h('p', { class: 'callout' }, 'Where the answers differ, it is because the products\' own rules differ (country lists, accreditation), not because the app asks differently. The question is the same for every issuer; only the data changes.'),
      navButtons(),
    );
  }

  function viewConnects() {
    const link = (p) => h('a', { href: /^https?:/.test(p) ? p : codeUrl(p) }, /^https?:/.test(p) ? `${new URL(p).hostname}${new URL(p).pathname.replace(/\/$/, '')}` : p);
    return h('section', {},
      h('h1', {}, 'What Interlock connects'),
      h('p', { class: 'lead' }, 'Interlock is a reference implementation, not a standard: one tested way to connect existing standards and models on Ethereum. The contracts target the Ethereum Virtual Machine (Cancun) and run on a local Ethereum node or the Sepolia testnet; Ethereum mainnet is refused by design. Other Ethereum-compatible networks are expected to work but are not tested.'),
      h('ol', { class: 'flow', 'aria-label': 'How the blocks connect' },
        ['A trade or a payment, described in FINOS CDM', 'Interlock core: one action library, your signer', 'RegulatedToken (ERC-20 + ERC-7943)', 'IEligibility slot: Shibui for investors, OnChainTrust vLEI for banks', 'EAS: credentials and their revocation', 'Settled on Ethereum; the answer back in CDM'].map((x) => h('li', {}, x))),
      h('section', { class: 'card' }, h('div', { class: 'scroll' }, h('table', { class: 'data', id: 'connects' },
        h('thead', {}, h('tr', {}, ['Block', 'Role', 'State in this recording', 'Where'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, CONNECTS.map(([block, role, state, where]) => h('tr', {}, h('th', { scope: 'row' }, block), h('td', {}, role), h('td', {}, state), h('td', {}, link(where))))),
      ))),
      h('p', { class: 'callout' }, 'Every claim on this page is backed by a test in the repository and by the recording you are playing.'),
      navButtons(),
    );
  }

  function viewUnsolved() {
    const order = { coordination: 0, both: 1, technical: 2 };
    const rows = UNSOLVED.slice().sort((a, b) => order[a[1]] - order[b[1]]);
    const col = (title, items, cls) => h('section', { class: `card col ${cls}` }, h('h2', {}, title), h('ul', {}, items.map((x) => h('li', {}, x))));
    return h('section', {},
      h('h1', {}, "Limits, and what's not solved yet"),
      h('section', { class: 'card', id: 'limits' }, h('h2', {}, 'Limits'), h('ul', {}, LIMITS.map((x) => h('li', {}, x)))),
      h('p', { class: 'lead' }, 'Most of what stands between this demo and production is agreement between institutions, not technology.'),
      h('div', { class: 'grid3' },
        col('Works today in this demo', WORKS_TODAY, 'works'),
        col('Institutions must agree', rows.filter((r) => r[1] !== 'technical').map((r) => `${r[0]} (${r[1]})`), 'agree'),
        col('You still need to build', rows.filter((r) => r[1] !== 'coordination').map((r) => `${r[0]} (${r[1]})`), 'build'),
      ),
      h('section', { class: 'card' },
        h('div', { class: 'scroll' }, h('table', { class: 'data unsolved', id: 'unsolved' },
          h('thead', {}, h('tr', {}, ['Topic', 'Type', 'What is needed', 'Who must agree'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', {}, rows.map(([topic, type, need, agree]) => h('tr', { 'data-type': type }, h('th', { scope: 'row' }, topic), h('td', {}, h('span', { class: `tag ${type}` }, type === 'both' ? 'coordination and technical' : type)), h('td', {}, need), h('td', {}, agree)))),
        )),
      ),
      h('p', { class: 'callout' }, 'The technology in this demo works today. Adoption depends mostly on agreements between institutions.'),
      navButtons(),
    );
  }

  function viewBuild() {
    return h('section', {},
      h('h1', {}, 'Build on it'),
      h('p', { class: 'lead' }, 'Everything in the demo maps onto a piece you would replace in a real deployment.'),
      h('section', { class: 'card' }, h('div', { class: 'scroll' }, h('table', { class: 'data', id: 'porting' },
        h('thead', {}, h('tr', {}, ['In the demo', 'In a real deployment', 'Where to look'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, PORTING.map(([demo, real, p]) => h('tr', {}, h('th', { scope: 'row' }, demo), h('td', {}, real), h('td', {}, h('a', { href: codeUrl(p) }, p))))),
      ))),
      h('section', { class: 'card' },
        h('h2', {}, 'Run the console yourself'),
        h('p', {}, 'You need Node 20 or later and git. The console lets you act as any member of the cast.'),
        h('pre', {}, 'git clone https://github.com/finos-hack/fall-hackathon-2026-beta.git\ncd fall-hackathon-2026-beta\ngit submodule update --init\nnpm install\nnpm start'),
        h('p', {}, 'Then open http://localhost:3000. To make this page from your own checkout: ', h('code', {}, 'npm run record'), ', then open ', h('code', {}, 'web/index.html'), '.'),
        h('p', {}, h('a', { href: REPO }, 'Source code'), ' · ', h('a', { href: codeUrl('README.md') }, 'README'), ' · ', h('a', { href: codeUrl('docs/limits.md') }, 'Limits')),
      ),
      navButtons(),
    );
  }

  // ============ Render ============

  function render() {
    ui.route = parseRoute();
    const r = ui.route;
    const view = $('#view');
    let el;
    if (!REC) el = viewMissing();
    else if (r.view === 'home') el = viewHome();
    else if (r.view === 'interop') el = viewInterop();
    else if (r.view === 'unsolved') el = viewUnsolved();
    else if (r.view === 'build') el = viewBuild();
    else if (r.view === 'connects') el = viewConnects();
    else {
      const story = storyById(r.story);
      el = { meet: viewMeet, today: viewToday, play: viewPlay, proves: viewProves }[r.tab](story);
    }
    const prevKey = view.dataset.key;
    const key = r.view === 'story' ? `${r.path}#${r.tab === 'play' ? playState(r.story).frame : ''}` : r.path;
    view.replaceChildren(el);
    view.dataset.key = key;
    view.dataset.view = r.view === 'story' ? `${r.story}-${r.tab}` : r.view;
    document.querySelectorAll('#nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === (r.view === 'story' ? r.story : r.view) ? 'page' : 'false'));
    if (prevKey && prevKey.split('#')[0] !== key.split('#')[0]) {
      window.scrollTo(0, 0);
      view.focus({ preventScroll: true });
    }
    document.title = `${r.view === 'story' ? `${storyById(r.story).title} · ` : ''}Interlock demo`;
  }

  // ============ Theme ============

  const THEMES = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const b = $('#theme');
    b.textContent = `Theme: ${t}`;
    b.setAttribute('aria-label', `Colour theme: ${t === 'auto' ? 'automatic' : t}. Change`);
  }
  function initTheme() {
    let t = 'auto';
    try {
      t = localStorage.getItem('demo-theme') || 'auto';
    } catch {
      // storage unavailable: keep automatic
    }
    if (!THEMES.includes(t)) t = 'auto';
    applyTheme(t);
    $('#theme').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'auto';
      const nt = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      applyTheme(nt);
      try {
        localStorage.setItem('demo-theme', nt);
      } catch {
        // ignore
      }
    });
  }

  // ============ Start ============

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !REC) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(tag)) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    }
  });
  window.addEventListener('hashchange', () => REC !== undefined && render());
  initTheme();
  const start = () => {
    renderProvenance();
    render();
  };
  if (WANT_SEPOLIA) {
    const sc = document.createElement('script');
    sc.src = 'recordings/sepolia.js';
    sc.onload = () => {
      REC = window.DEMO_RECORDING_SEPOLIA || null;
      start();
    };
    sc.onerror = () => start();
    document.head.append(sc);
  } else {
    start();
  }
})();
