// S10 (issue #5): the documents that describe the code stay in step with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { render, FILE } from '../../tools/cdm/gen-mapping.mjs';
import { ROOT } from './helpers/kit.mjs';

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('docs/cdm-mapping.md is generated from the mapping table in core/lib/cdm.mjs', () => {
  assert.equal(readFileSync(FILE, 'utf8'), render(), 'run: node tools/cdm/gen-mapping.mjs');
});

test('docs/openapi.yaml documents exactly the console server\'s API routes, with their methods', () => {
  const api = JSON.parse(read('docs/openapi.yaml')); // JSON is valid YAML 1.2
  const server = read('examples/server.mjs');
  const routes = [...server.matchAll(/url\.pathname === '(\/api\/[a-z]+)'\) \{\n\s+if \(req\.method !== '([A-Z]+)'/g)].map((m) => [m[1], m[2].toLowerCase()]);
  assert.deepEqual(routes.map(([p]) => p).sort(), Object.keys(api.paths).sort());
  for (const [p, method] of routes) assert.ok(api.paths[p][method], `${method.toUpperCase()} ${p} is not documented`);
  const actions = api.paths['/api/actions'].post.requestBody.content['application/json'].schema.properties.action.description;
  for (const a of ['settle', 'onboardEntity', 'registerEntityCredential', 'issue', 'replaceAttester']) assert.match(actions, new RegExp(`\\b${a}\\b`));
});

test('every decision record is listed in docs/adr/README.md', () => {
  const index = read('docs/adr/README.md');
  for (const f of readdirSync(path.join(ROOT, 'docs', 'adr')).filter((x) => /^\d{4}-.*\.md$/.test(x))) assert.ok(index.includes(`(${f})`), f);
});

test('relative links in the README and docs/ point to files that exist; no stale app/ paths', () => {
  const files = ['README.md', ...readdirSync(path.join(ROOT, 'docs')).filter((x) => x.endsWith('.md')).map((x) => `docs/${x}`), ...readdirSync(path.join(ROOT, 'docs', 'adr')).map((x) => `docs/adr/${x}`)];
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /`app\/|\(app\/|\bapp\/(actions|lib|public)\b/, `${f} mentions the old app/ directory`);
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      assert.ok(existsSync(path.join(ROOT, path.dirname(f), target)), `${f} links to missing ${target}`);
    }
  }
});

test('the spec names the pinned upstreams that lib/ actually pins', () => {
  const spec = read('docs/spec.md');
  const modules = read('.gitmodules');
  for (const repo of ['rnd-rwa-erc3643-eas', 'vlei-eas-contracts', 'eas-contracts', 'openzeppelin-contracts']) assert.match(modules, new RegExp(repo));
  for (const pin of ['4414538', 'f036d82', '7.10.0']) assert.ok(spec.includes(pin), pin);
});
