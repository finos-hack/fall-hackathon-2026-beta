// X2 (optional; not part of `npm run test:node`): headless Chromium opens the console on a freshly seeded local kit,
// clicks through the guided story and ends on the scenario summary. It also checks the plan 3.7 promises a person
// sees: answers in words, refusals with the reason and topic, Etherscan links on Sepolia, phone width, no key.
//
// Needs Playwright with Chromium already installed, found by require('playwright'). Nothing is installed here.
// Run: npm run test:browser          (SCREENSHOT_DIR=<dir> also saves screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as kit from '../../core/actions/index.mjs';
import { startServer } from '../../examples/server.mjs';
import { chainAndContext, localKeyMaterial } from '../node/helpers/kit.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error(`X2 needs Playwright with Chromium installed (require('playwright') failed: ${e.message}). It is optional: npm run test:node does not use it.`);
}

const SHOTS = process.env.SCREENSHOT_DIR || null;
let env;
let srv;
let browser;
let page;
const pageErrors = [];
const bodyReads = [];

async function shot(name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Waits until a step has finished and the page is idle again; returns the result line. */
async function stepResult(n) {
  await page.waitForFunction(
    (sel) => /^Result: (as expected|not as expected)$/.test(document.querySelector(sel)?.textContent ?? ''),
    `#step-${n}-result`,
    { timeout: 120_000 },
  );
  await page.waitForFunction(() => !document.querySelector('#run-all').disabled, null, { timeout: 60_000 });
  return page.textContent(`#step-${n}-result`);
}

const cellText = (inv, sym) => page.textContent(`td[data-investor="${inv}"][data-token="${sym}"] .verdict`);

before(async () => {
  env = await chainAndContext();
  await kit.deploy(env.ctx, { outFile: false });
  await kit.seedDemo(env.ctx);
  srv = await startServer({ ctx: env.ctx, port: 0 });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.url().startsWith(srv.url)) bodyReads.push(r.text().catch(() => ''));
  });
  await page.goto(srv.url);
  await page.waitForSelector('td[data-investor="alice"][data-token="dPCN"]');
});

after(async () => {
  await browser?.close();
  await srv?.close();
  await env?.stop();
});

test('X2 the page shows the live kit: header, Act as, tokens and the matrix in words', async () => {
  assert.equal(await page.textContent('h1'), 'EEA Tokenization Starter Kit');
  assert.match(await page.textContent('#network'), /^Local chain · chain id 31337 · block \d+$/);
  const cast = await page.$$eval('#act-as option', (os) => os.map((o) => o.textContent));
  assert.deepEqual(cast, [
    'Operator', 'Issuer', 'Compliance officer', 'KYC Provider A', 'KYC Provider B', 'Alice', 'Bob', 'Carol', 'Dave',
    'Northvale Bank, issuer', 'Northvale Bank, compliance', 'Quillon Asset Management, issuer',
    'Quillon Asset Management, compliance', 'Saltmarsh Credit Partners, issuer', 'Saltmarsh Credit Partners, compliance',
    'Northvale Bank, treasury', 'Larkmoor Bank, treasury',
  ]);
  for (const sym of ['dDEP', 'dMMF', 'dPCN']) {
    const card = await page.textContent(`article.token[data-token="${sym}"]`);
    assert.match(card, /Active/);
    assert.match(card, /Required topics/);
  }
  // I1: the cast table, as text.
  assert.equal(await cellText('alice', 'dPCN'), 'no: accreditation');
  assert.equal(await cellText('bob', 'dPCN'), 'yes');
  assert.equal(await cellText('carol', 'dDEP'), 'no: KYC, sanctions');
  assert.equal(await cellText('dave', 'dMMF'), 'no: country');
  assert.equal(await cellText('dave', 'dDEP'), 'yes');
  await shot('01-loaded');
});

test('X2 clicking through the guided story ends on "7 of 7 steps as expected"', async () => {
  // Step 1 by keyboard: focus the button and press Enter.
  await page.focus('button[data-step="1"]');
  await page.keyboard.press('Enter');
  assert.equal(await stepResult(1), 'Result: as expected', await page.textContent('#step-1-detail'));
  for (let n = 2; n <= 7; n++) {
    await page.click(`button[data-step="${n}"]`);
    assert.equal(await stepResult(n), 'Result: as expected', `step ${n}: ${await page.textContent(`#step-${n}-detail`)}`);
  }
  assert.equal(await page.textContent('#story-summary-text'), '7 of 7 steps as expected.');
  const list = await page.$$eval('#story-summary-list li', (ls) => ls.map((l) => l.textContent));
  assert.equal(list.length, 7);
  assert.ok(list.every((l) => l.endsWith(': as expected')), list.join(' | '));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'story-summary', 'focus ends on the summary');

  // What the person saw on the way: step 3's refusal by topic, and the matrix after the revocation.
  assert.match(await page.textContent('#step-3-detail'), /topic ACCREDITATION: “accreditation: policy rejected”/);
  assert.match(await cellText('alice', 'dDEP'), /^no: KYC/);
  assert.ok(!/\b(null|undefined|NaN)\b|\[object/.test(await page.textContent('main')), 'no placeholder text leaks onto the page');
  await shot('02-story-done');
});

test('X2 an action from the form: a refusal shows the plain reason and every topic', async () => {
  await page.selectOption('#act-as', 'issuer');
  await page.selectOption('#f-action', 'issue');
  await page.selectOption('#f-token', 'dPCN');
  await page.selectOption('#f-to', 'carol');
  await page.fill('#f-amount', '1');
  await page.click('#f-submit');
  await page.waitForFunction(() => /Refused/.test(document.querySelector('#result')?.textContent ?? ''));
  const result = await page.textContent('#result');
  assert.match(result, /Refused: Carol may not receive dPCN/);
  for (const t of ['KYC', 'ACCREDITATION', 'COUNTRY']) assert.match(result, new RegExp(`Topic ${t} — `), `topic ${t} shown`);

  // "Act as" is the signer: Alice cannot issue, and the console says which role is missing.
  await page.selectOption('#act-as', 'alice');
  assert.equal(await page.textContent('#f-submit'), 'Send as Alice');
  await page.selectOption('#f-to', 'bob');
  await page.click('#f-submit');
  await page.waitForFunction(() => /ISSUER_ROLE/.test(document.querySelector('#result')?.textContent ?? ''));
  assert.match(await page.textContent('#result'), /Refused: Alice does not hold ISSUER_ROLE on dPCN/);
  assert.match(await page.textContent('#history-list'), /Carol may not receive dPCN/, 'the earlier result moved to the history');

  // And an accepted one, from the right person.
  await page.click('#f-usual button');
  assert.equal(await page.inputValue('#act-as'), 'issuer');
  await page.click('#f-submit');
  await page.waitForFunction(() => /Accepted: Issuer issued 1 dPCN to Bob/.test(document.querySelector('#result')?.textContent ?? ''));
  await page.waitForFunction(() => !document.querySelector('#f-submit').disabled); // idle: the state is re-read
  await shot('03-form');
});

test('X2 audit trail newest first; at phone width nothing scrolls sideways', async () => {
  const rows = await page.$$eval('#audit-body tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.ok(rows.length > 20, `audit rows: ${rows.length}`);
  assert.deepEqual(rows[0].slice(1, 4), ['Issuer', 'Issued', 'dPCN'], 'the issue from the form is on top');
  assert.ok(rows.some((r) => r[2] === 'Attester removed' && r[1] === 'Operator'));
  assert.ok(rows.some((r) => r[2] === 'Credential revoked' && r[1] === 'KYC Provider A'));

  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(100);
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(scroll <= inner, `page is ${scroll}px wide in a ${inner}px viewport`);
  await shot('04-phone');
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('X2 on Sepolia every transaction hash links to sepolia.etherscan.io', async () => {
  // Same chain, but the state says Sepolia: the page must build every link from it.
  await page.route('**/api/state', async (route) => {
    try {
      const res = await route.fetch();
      const json = await res.json();
      Object.assign(json, { network: 'sepolia', chainId: 11155111, explorer: 'https://sepolia.etherscan.io' });
      await route.fulfill({ response: res, json });
    } catch {
      // the request was dropped by the reload below; nothing to answer
    }
  });
  await page.reload();
  await page.waitForSelector('#audit-body tr');
  assert.match(await page.textContent('#network'), /^Sepolia testnet · chain id 11155111/);
  const rows = await page.$$eval('#audit-body tr', (trs) => trs.length);
  const hrefs = await page.$$eval('#audit-body a.hash', (as) => as.map((a) => a.href));
  assert.equal(hrefs.length, rows, 'one link per audit entry');
  for (const h of hrefs) assert.match(h, /^https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}$/);

  await page.selectOption('#act-as', 'issuer');
  await page.selectOption('#f-action', 'issue');
  await page.selectOption('#f-token', 'dDEP');
  await page.selectOption('#f-to', 'bob');
  await page.fill('#f-amount', '1');
  await page.click('#f-submit');
  await page.waitForSelector('#result .txs a');
  const resultLinks = await page.$$eval('#result .txs a', (as) => as.map((a) => a.href));
  assert.equal(resultLinks.length, 1);
  assert.match(resultLinks[0], /^https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}$/);
  await page.waitForFunction(() => !document.querySelector('#f-submit').disabled);
  await page.unrouteAll({ behavior: 'wait' });
});

test('X2 no key ever reaches the browser, and the page logged no error', async () => {
  const material = localKeyMaterial();
  const texts = [...(await Promise.all(bodyReads)), await page.content()];
  assert.ok(texts.length > 30, `responses seen: ${texts.length}`);
  for (const t of texts) {
    const lower = t.toLowerCase();
    for (const k of material.keys) assert.ok(!lower.includes(k), 'a private key reached the browser');
    assert.ok(!lower.includes(material.mnemonic), 'the mnemonic reached the browser');
  }
  assert.deepEqual(pageErrors, [], 'console errors or CSP violations on the page');
});
