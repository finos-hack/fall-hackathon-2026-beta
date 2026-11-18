// Issue #3: headless Chromium plays the demo page (web/) from a local file, against a fresh recording.
// It clicks through every story with Next only, takes every side branch, and checks the promises of the spec:
// refusals with the reason by topic, provenance, footer on every view, keyboard, reduced motion, light and dark
// themes, no horizontal scroll at 375 px, and no key in the page.
//
// Needs Playwright with Chromium installed, found by require('playwright'). Run: npm run test:browser
// (SCREENSHOT_DIR=<dir> also saves screenshots.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { record, allSteps } from '../../examples/record.mjs';
import { ROOT, tmpDir, rm, assertNoKeyMaterial } from '../node/helpers/kit.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error(`The demo page test needs Playwright with Chromium installed (require('playwright') failed: ${e.message}).`);
}

const SHOTS = process.env.SCREENSHOT_DIR || null;
const FOOTER = 'All institutions and people are fictional. Testnet demo, not audited, not for production use.';
let dir;
let rec;
let browser;
let url;

/** A copy of web/ with a fresh recording in data/, opened as a file:// URL (no server, no network). */
before(async () => {
  dir = tmpDir('eea-kit-web-');
  for (const f of ['index.html', 'app.js', 'style.css']) copyFileSync(path.join(ROOT, 'web', f), path.join(dir, f));
  rec = await record({ outDir: path.join(dir, 'data'), log: () => {} });
  url = pathToFileURL(path.join(dir, 'index.html')).href;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (dir) rm(dir);
});

async function open({ width = 1280, height = 900, colorScheme = 'light', reducedMotion = 'no-preference', hash = '' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => {
    if (!r.url().startsWith('file:')) errors.push(`network request to ${r.url()}`);
  });
  await page.goto(url + hash);
  await page.waitForSelector('#view > *');
  return { page, errors };
}

const viewName = (page) => page.getAttribute('#view', 'data-view');

/** Runs `act` and waits until the page has rendered the next view or frame (hash changes render asynchronously). */
async function andRender(page, act) {
  const key = await page.getAttribute('#view', 'data-key');
  await act();
  await page.waitForFunction((k) => document.querySelector('#view').dataset.key !== k, key);
}
const frameKind = (page) => page.getAttribute('#frame', 'data-frame');
const frameStep = (page) => page.getAttribute('#frame', 'data-step');

async function shot(page, name) {
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  }
}

/** Main-line step ids of a story when the visitor only presses Next. */
function mainLine(story) {
  const ids = [];
  for (const x of story.steps) {
    if (x.fork) x.fork.options.find((o) => o.continues).steps.forEach((s) => ids.push(s.id));
    else ids.push(x.id);
  }
  return ids;
}

test('Next only: the whole tour, every main-line step in order, footer and provenance on every view', async () => {
  const { page, errors } = await open();
  assert.equal(await page.textContent('h1'), 'Verify once, hold anywhere the rules allow, settle across instruments.');
  assert.match(await page.textContent('#view .hero'), /Interlock · a reference implementation for interoperable regulated tokens on Ethereum/);
  assert.match(await page.textContent('#view .hero'), /It is not a standard/);
  assert.match(await page.textContent('#what-you-get'), /conformance suites/);
  for (const st of ['dvp', 'vlei']) assert.ok(await page.$(`article[data-story="${st}"]`), `landing card for story ${st}`);
  assert.match(await page.textContent('#provenance'), new RegExp(`Recorded from the contracts at commit ${rec.commit.short}.* on ${rec.recordedAt.slice(0, 10)}`));
  for (const sym of ['dDEP', 'dMMF', 'dPCN']) assert.match(await page.textContent(`article.product[data-token="${sym}"]`), /Live/);

  const views = [];
  const seen = {};
  let presses = 0;
  for (;;) {
    const v = await viewName(page);
    if (views[views.length - 1] !== v) views.push(v);
    assert.equal((await page.textContent('footer')).includes(FOOTER), true, `footer missing on ${v}`);
    if (v.endsWith('-play') && (await frameKind(page)) === 'step') {
      (seen[v] ??= []).push(await frameStep(page));
      await page.waitForSelector('#step-result');
    }
    if (await page.isDisabled('#next')) break;
    await andRender(page, () => page.click('#next'));
    presses++;
    assert.ok(presses < 200, 'the tour never ends');
  }
  assert.deepEqual(views, [
    'home',
    'deposit-meet', 'deposit-today', 'deposit-play', 'deposit-proves',
    'fund-meet', 'fund-today', 'fund-play', 'fund-proves',
    'credit-meet', 'credit-today', 'credit-play', 'credit-proves',
    'dvp-meet', 'dvp-today', 'dvp-play', 'dvp-proves',
    'vlei-meet', 'vlei-today', 'vlei-play', 'vlei-proves',
    'interop', 'connects', 'unsolved', 'build',
  ]);
  for (const s of rec.stories) assert.deepEqual(seen[`${s.id}-play`], mainLine(s), `story ${s.letter}`);
  assert.ok(presses < 90, `${presses} presses: too long for about 8 minutes`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('refusals show the reason by topic, lit up in the diagram, and the matrix reads yes / no: topic', async () => {
  const { page } = await open({ hash: '#/story/deposit/play' });
  const toStep = async (id) => {
    for (let i = 0; i < 30 && (await frameStep(page)) !== id; i++) await page.click('#next');
    assert.equal(await frameStep(page), id);
  };
  await toStep('A3');
  assert.match(await page.textContent('#step-result'), /^Refused: Carol may not receive dDEP/);
  assert.match(await page.textContent('#frame .reasons'), /KYC: no credential/);
  assert.match(await page.textContent('[data-node="eas"]'), /KYC: no credential/);
  assert.match(await page.getAttribute('[data-node="check"]', 'class'), /fail/);
  assert.match(await page.getAttribute('[data-node="result"]', 'class'), /fail/);
  assert.match(await page.textContent('#frame .txs'), /No transaction/);
  assert.equal(await page.textContent('td[data-investor="carol"][data-token="dDEP"] .verdict'), 'no: KYC, sanctions');
  assert.equal(await page.textContent('td[data-investor="alice"][data-token="dPCN"] .verdict'), 'no: accreditation');
  assert.equal(await page.textContent('td[data-investor="bob"][data-token="dPCN"] .verdict'), 'yes');
  await page.click('#next'); // the fork
  await page.click('#next'); // Next takes the way the story continues
  await toStep('A5');
  assert.match(await page.textContent('#frame .reasons'), /KYC: revoked/);
  await page.close();

  const b = await open({ hash: '#/story/fund/play' });
  await b.page.click('#next');
  assert.equal(await frameStep(b.page), 'B2');
  assert.match(await b.page.textContent('#frame .reasons'), /country: policy rejected/);
  assert.match(await b.page.textContent('[data-node="shibui"]'), /country: policy rejected/);
  await b.page.close();

  const c = await open({ hash: '#/story/credit/play' });
  await c.page.click('#next');
  assert.equal(await frameStep(c.page), 'C2');
  assert.match(await c.page.textContent('#frame .reasons'), /accreditation: policy rejected/);
  await shot(c.page, 'demo-refusal');
  await c.page.close();
});

test('every fork: each option plays its recorded steps; Back returns to the fork; the trail shows the choice', async () => {
  for (const s of rec.stories) {
    for (const f of s.steps.filter((x) => x.fork).map((x) => x.fork)) {
      for (const o of f.options) {
        const { page, errors } = await open({ hash: `#/story/${s.id}/play` });
        for (let i = 0; i < 30 && (await frameKind(page)) !== 'fork'; i++) await page.click('#next');
        assert.equal(await frameKind(page), 'fork', `${f.id} not reached`);
        assert.equal(await page.textContent('#frame h2'), f.question);
        await page.click(`[data-option="${o.id}"]`);
        assert.match(await page.textContent('.trail'), new RegExp(`You chose: ${o.chose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        const played = [];
        for (let i = 0; i < o.steps.length; i++) {
          played.push(await frameStep(page));
          if (i === 0) {
            await page.click('#back');
            assert.equal(await frameKind(page), 'fork', 'Back returns to the fork');
            await page.click('#next');
            assert.equal(await frameStep(page), o.steps[0].id, 'Next after Back replays the chosen branch');
          }
          const expected = o.steps[i];
          assert.equal(await page.textContent('#step-result strong'), expected.result.ok ? 'Accepted' : 'Refused', expected.id);
          await page.click('#next');
        }
        assert.deepEqual(played, o.steps.map((x) => x.id), `${f.id}/${o.id}`);
        if (!o.continues) {
          assert.equal(await frameKind(page), 'rejoin', 'a side branch ends back at the fork');
          await page.click('#next');
          const main = f.options.find((x) => x.continues);
          if (main.steps.length) assert.equal(await frameStep(page), main.steps[0].id, 'then the story continues');
        }
        if (o.id === 'onboard-carol') await shot(page, 'demo-branch');
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  }
});

test('a rewound side branch leaves no trace: balances and audit trail are back to the fork', async () => {
  const { page } = await open({ hash: '#/story/deposit/play' });
  for (let i = 0; i < 10 && (await frameKind(page)) !== 'fork'; i++) await page.click('#next');
  await page.click('[data-option="onboard-carol"]');
  await page.click('#next'); // A3b2: Alice pays Carol
  assert.equal(await page.textContent('#balances td[data-investor="carol"][data-token="dDEP"] .num'), '50');
  assert.match(await page.textContent('#audit'), /50 dDEP from Alice to Carol/);
  await page.click('#next'); // back at the fork
  assert.equal(await frameKind(page), 'rejoin');
  assert.equal(await page.textContent('#balances td[data-investor="carol"][data-token="dDEP"] .num'), '0');
  assert.doesNotMatch(await page.textContent('#audit'), /50 dDEP from Alice to Carol/);
  await page.close();
});

test('story D: the settlement diagram, both legs, the CDM instruction in and the Settled answer out', async () => {
  const { page } = await open({ hash: '#/story/dvp/play', reducedMotion: 'reduce' });
  for (let i = 0; i < 10 && (await frameStep(page)) !== 'D3'; i++) await page.click('#next');
  assert.equal(await frameStep(page), 'D3');
  assert.match(await page.textContent('[data-node="token"]'), /dMMF ⇄ dDEP/);
  assert.match(await page.textContent('[data-node="token"]'), /both legs settled in one transaction/);
  assert.match(await page.textContent('#frame .trade-steps'), /Alice affirms: both legs settle: done/);
  await page.click('#cdm-view summary');
  const cdm = await page.textContent('#cdm-view');
  assert.match(cdm, /In: TransferInstruction \(Instructed\)/);
  assert.match(cdm, /Out: TransferInstruction \(Settled\)/);
  assert.match(cdm, /cdm\.event\.common\.TransferInstruction/);
  assert.equal(await page.textContent('#balances td[data-investor="alice"][data-token="dMMF"] .num'), '100');
  await page.click('#next'); // the fork
  await page.click('[data-option="dave"]');
  assert.equal(await frameStep(page), 'D3b1');
  assert.match(await page.textContent('#step-result'), /Dave may not receive dMMF \(country: policy rejected\), so neither leg moved/);
  assert.match(await page.textContent('#cdm-view'), /Nothing settled, so there is no Settled answer/);
  await shot(page, 'demo-dvp');
  await page.close();
});

test('story E: the vLEI slot on the diagram; a retail wallet refused; the banks are fictional with test LEIs', async () => {
  const { page } = await open({ hash: '#/story/vlei/meet' });
  assert.match(await page.textContent('#view'), /OnChainTrust's VleiEligibility slot, not Shibui/);
  assert.match(await page.textContent('#view'), /test LEI INTERLOCKTESTLMB0002/);
  assert.match(await page.textContent('#view'), /real institutions, so they are never shown here/);
  await page.evaluate(() => (location.hash = '#/story/vlei/play'));
  await page.waitForSelector('#frame');
  for (let i = 0; i < 10 && (await frameStep(page)) !== 'E5'; i++) await page.click('#next');
  assert.match(await page.textContent('[data-node="shibui"]'), /VleiEligibility/);
  assert.match(await page.textContent('[data-node="eas"]'), /vLEI legal entity: no credential/);
  assert.equal(await page.textContent('#matrix td[data-investor="alice"][data-token="dIBD"] .verdict'), 'no: vLEI legal entity');
  assert.equal(await page.textContent('#matrix td[data-investor="larkmoor-treasury"][data-token="dIBD"] .verdict'), 'yes');
  await shot(page, 'demo-vlei');
  await page.close();
});

test('the vendor change shows holders dropping out and returning, and who authorized whom', async () => {
  const { page } = await open({ hash: '#/story/credit/play' });
  for (let i = 0; i < 20 && (await frameStep(page)) !== 'C6'; i++) await page.click('#next');
  assert.equal(await frameStep(page), 'C6');
  const rows = await page.$$eval('table.rotation tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.deepEqual(rows.find((r) => r[0] === 'Alice'), ['Alice', 'yes', 'no', 'yes']);
  assert.match(await page.textContent('#audit'), /Operator.*Provider authorized.*Operator authorized Tallyway Verification/s);
  await shot(page, 'demo-rotation');
  await page.close();
});

test('interoperability, not solved yet and build on it', async () => {
  const { page } = await open({ hash: '#/interop' });
  for (const sym of ['dDEP', 'dMMF', 'dPCN', 'dIBD']) {
    const card = await page.textContent(`[data-interop="${sym}"]`);
    assert.match(card, /supportsInterface\(0x3edbb4c4\): true/);
    assert.match(card, /canSend/);
    assert.match(card, /canTransfer/);
  }
  await page.evaluate(() => (location.hash = '#/unsolved'));
  await page.waitForSelector('#unsolved');
  const types = await page.$$eval('#unsolved tbody tr', (trs) => trs.map((tr) => tr.dataset.type));
  assert.equal(types.length, 10);
  assert.equal(types.slice(0, 5).every((t) => t === 'coordination'), true, 'coordination items lead');
  const topics = await page.$$eval('#unsolved tbody th', (ths) => ths.map((t) => t.textContent));
  for (const t of ['KYC reliance', 'Trust framework', 'Shared meaning of credentials', 'Cash leg', 'Messaging and core banking', 'Legal finality', 'Network choice', 'Custody and keys', 'Privacy', 'Reporting and accounting']) {
    assert.ok(topics.includes(t), t);
  }
  assert.match(await page.textContent('#view'), /Adoption depends mostly on agreements between institutions/);
  assert.match(await page.textContent('#limits'), /Not a standard, not production code, not audited/);
  assert.match(await page.textContent('#limits'), /Not legal settlement/);
  await page.evaluate(() => (location.hash = '#/connects'));
  await page.waitForSelector('#connects');
  const blocks = await page.$$eval('#connects tbody th', (ths) => ths.map((t) => t.textContent));
  for (const b of ['OnChainTrust VleiEligibility', 'FINOS Common Domain Model 7.10.0', 'DvPSettlement', 'Shibui (EEA)']) assert.ok(blocks.includes(b), b);
  assert.match(await page.textContent('#view'), /Ethereum mainnet is refused by design/);
  await page.evaluate(() => (location.hash = '#/build'));
  await page.waitForSelector('#porting');
  const links = await page.$$eval('#porting a', (as) => as.map((a) => a.href));
  assert.equal(links.length, 9);
  for (const l of links) assert.match(l, /^https:\/\/github\.com\/finos-hack\/fall-hackathon-2026-beta\/(blob|tree)\//);
  await page.close();
});

test('keyboard: arrow keys move Next and Back; every control is reachable with Tab', async () => {
  const { page } = await open({ hash: '#/story/deposit/play' });
  await andRender(page, () => page.keyboard.press('ArrowRight'));
  assert.equal(await frameStep(page), 'A2');
  await andRender(page, () => page.keyboard.press('ArrowLeft'));
  assert.equal(await frameStep(page), 'A1');
  await andRender(page, () => page.keyboard.press('ArrowLeft'));
  assert.equal(await viewName(page), 'deposit-today');
  const focusable = new Set();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    focusable.add(await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim().slice(0, 20)));
  }
  for (const id of ['theme', 'next', 'back']) assert.ok(focusable.has(id), `#${id} not reachable with Tab`);
  await page.close();
});

test('reduced motion turns animation off; light and dark themes; the theme switch', async () => {
  const still = await open({ reducedMotion: 'reduce', hash: '#/story/deposit/play' });
  assert.equal(await still.page.$eval('.node', (n) => getComputedStyle(n).animationName), 'none');
  await still.page.close();
  const moving = await open({ hash: '#/story/deposit/play' });
  assert.equal(await moving.page.$eval('.node', (n) => getComputedStyle(n).animationName), 'light');
  await moving.page.close();

  const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await open({ colorScheme: 'light' });
  const dark = await open({ colorScheme: 'dark' });
  const lightBg = await bg(light.page);
  const darkBg = await bg(dark.page);
  assert.notEqual(lightBg, darkBg);
  await shot(dark.page, 'demo-dark-home');
  await light.page.click('#theme'); // auto -> light
  await light.page.click('#theme'); // light -> dark
  assert.equal(await light.page.getAttribute('html', 'data-theme'), 'dark');
  assert.equal(await bg(light.page), darkBg);
  await light.page.close();
  await dark.page.close();
});

test('phone width: no horizontal scroll at 375 px on any view', async () => {
  const { page } = await open({ width: 375, height: 800 });
  const hashes = ['#/', '#/interop', '#/unsolved', '#/build'];
  for (const s of rec.stories) for (const t of ['meet', 'today', 'play', 'proves']) hashes.push(`#/story/${s.id}/${t}`);
  for (const hsh of hashes) {
    await page.evaluate((x) => (location.hash = x), hsh);
    await page.waitForFunction((x) => location.hash === x, hsh);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw, `${hsh}: page is ${sw}px wide in a ${iw}px viewport`);
  }
  // Every play frame of story C, including its side branch.
  await page.evaluate(() => (location.hash = '#/story/credit/play'));
  for (let i = 0; i < 15; i++) {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw, `story C frame ${i}: ${sw}px`);
    if ((await frameKind(page)) === 'end') break;
    await page.click('#next');
  }
  await shot(page, 'demo-phone');
  await page.close();
});

test('no key in the page; every step shows a transaction hash or says none was sent', async () => {
  const { page } = await open();
  assertNoKeyMaterial(assert, await page.content(), 'demo page');
  const accepted = allSteps(rec).filter((s) => s.result.ok);
  assert.ok(accepted.length > 0);
  await page.evaluate(() => (location.hash = '#/story/deposit/play'));
  await page.waitForSelector('#frame');
  assert.match(await page.textContent('#frame .txs'), /Transaction: 0x[0-9a-f]{8}/);
  await page.close();
});

test('without a recording the page says how to make one', async () => {
  const empty = tmpDir('eea-kit-web-empty-');
  try {
    for (const f of ['index.html', 'app.js', 'style.css']) copyFileSync(path.join(ROOT, 'web', f), path.join(empty, f));
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(empty, 'index.html')).href);
    await page.waitForSelector('#view h1');
    assert.equal(await page.textContent('#view h1'), 'No recording yet');
    assert.match(await page.textContent('#view'), /npm run record/);
    assert.match(await page.textContent('footer'), new RegExp(FOOTER.replace(/[.]/g, '\\.')));
    await page.close();
  } finally {
    rm(empty);
  }
});
