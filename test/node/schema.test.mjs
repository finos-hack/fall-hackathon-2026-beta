// S2 (issue #5): schemas/template.schema.json and schemas/kit-config.schema.json are the published form of the
// Interlock spec v0.1. Every shipped and fixture file validates; every invalid case is refused by the schema AND by
// the loader, naming the same field. Rules that need another file (attester ids, duplicates) are the loader's alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { schemaErrors } from '../../core/lib/schema.mjs';
import { validateTemplate, validateCast, ConfigError } from '../../core/lib/config.mjs';
import { loadKitConfig } from '../../examples/lib/config.mjs';
import { readJson, ROOT, TEMPLATES, FIXTURES } from './helpers/kit.mjs';

const kit = loadKitConfig();
const base = () => readJson(path.join(TEMPLATES, 'private-credit-note.json'));

test('every shipped and fixture template, and the demo cast, validate against the schemas', () => {
  for (const dir of [TEMPLATES, FIXTURES]) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      assert.deepEqual(schemaErrors('template', readJson(path.join(dir, f))), [], f);
    }
  }
  assert.deepEqual(schemaErrors('cast', readJson(path.join(ROOT, 'kit.config.json'))), [], 'kit.config.json');
});

const TEMPLATE_CASES = [
  ['unknown topic', (t) => (t.requiredTopics = ['KYC', 'KYCC']), 'requiredTopics[1]'],
  ['topic listed twice', (t) => (t.requiredTopics = ['KYC', 'KYC', 'ACCREDITATION', 'COUNTRY']), 'requiredTopics[1]'],
  ['empty symbol', (t) => (t.symbol = ''), 'symbol'],
  ['missing symbol', (t) => delete t.symbol, 'symbol'],
  ['missing id', (t) => delete t.id, 'id'],
  ['decimals above 18', (t) => (t.decimals = 19), 'decimals'],
  ['fractional decimals', (t) => (t.decimals = 2.5), 'decimals'],
  ['COUNTRY without country', (t) => delete t.country, 'country'],
  ['COUNTRY with no codes', (t) => (t.country.codes = []), 'country.codes'],
  ['ACCREDITATION without allowedTypes', (t) => (t.accreditation = {}), 'accreditation.allowedTypes'],
  ['ACCREDITATION without accreditation', (t) => delete t.accreditation, 'accreditation'],
  ['unknown field', (t) => (t.colour = 'blue'), 'colour'],
  ['unknown eligibility source', (t) => (t.eligibility = { source: 'magic' }), 'eligibility.source'],
  ['vlei source with Shibui topics', (t) => (t.eligibility = { source: 'vlei' }), 'requiredTopics'],
];

for (const [name, mutate, field] of TEMPLATE_CASES) {
  test(`template: ${name} is refused by the schema and the loader, both naming ${field}`, () => {
    const t = base();
    mutate(t);
    const errs = schemaErrors('template', t);
    assert.ok(errs.length > 0, 'the schema accepted it');
    assert.ok(errs.some((e) => e.field === field), `schema fields: ${errs.map((e) => e.field).join(', ')}`);
    assert.throws(() => validateTemplate(t, 'case.json', kit), (e) => e instanceof ConfigError && e.field === field);
  });
}

test('template: a vLEI template validates (no Shibui topics, only the vLEI settings)', () => {
  const t = { id: 'interbank-deposit', name: 'Demo Interbank Deposit', symbol: 'dIBD', decimals: 6, eligibility: { source: 'vlei', credentialTypes: ['LE'] } };
  assert.deepEqual(schemaErrors('template', t), []);
  const v = validateTemplate(t, 'ibd.json', kit);
  assert.deepEqual(v.eligibility, { source: 'vlei', credentialTypes: ['LE'], topic: 15 });
  assert.deepEqual(v.requiredTopics, []);
});

test('template: rules that need the cast are the loader\'s alone (the schema cannot know the attesters)', () => {
  const t = base();
  t.trustedAttesters = ['nobody'];
  assert.deepEqual(schemaErrors('template', t), []);
  assert.throws(() => validateTemplate(t, 'case.json', kit), (e) => e.field === 'trustedAttesters[0]' && /unknown attester/.test(e.message));
});

const CAST_CASES = [
  ['missing operator role', (c) => delete c.roles.operator, 'roles.operator'],
  ['unknown topic for an attester', (c) => c.attesters[0].authorizedTopics.push('NOPE'), `attesters[0].authorizedTopics[${8}]`],
  ['unknown credential field', (c) => (c.investors[0].credential.shoeSize = 42), 'investors[0].credential.shoeSize'],
  ['institution without its institution name', (c) => delete c.institutions[0].institution, 'institutions[0].institution'],
  ['unknown top-level field', (c) => (c.secrets = {}), 'secrets'],
];

for (const [name, mutate, field] of CAST_CASES) {
  test(`cast: ${name} is refused by the schema and the loader, both naming ${field}`, () => {
    const c = readJson(path.join(ROOT, 'kit.config.json'));
    mutate(c);
    const errs = schemaErrors('cast', c);
    assert.ok(errs.some((e) => e.field === field), `schema fields: ${errs.map((e) => e.field).join(', ')}`);
    assert.throws(() => validateCast(c, 'case.json'), (e) => e instanceof ConfigError && e.field === field);
  });
}
