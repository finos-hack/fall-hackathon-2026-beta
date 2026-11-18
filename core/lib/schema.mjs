// JSON Schema validation of templates and casts against schemas/*.schema.json (Interlock spec v0.1).
// The loader runs its own checks first, for messages that name the file and the field in plain words, then the
// schema as the final authority. Rules that need other files (attester ids, unique ids) stay in the loader.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { ROOT } from './paths.mjs';

export const SCHEMA_DIR = path.join(ROOT, 'schemas');

let validators = null;

function compile() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  const load = (name) => JSON.parse(readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
  return {
    template: ajv.compile(load('template.schema.json')),
    cast: ajv.compile(load('kit-config.schema.json')),
  };
}

/** "/requiredTopics/1" -> "requiredTopics[1]"; a missing or extra property names that property. */
function fieldOf(err) {
  const parts = err.instancePath.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let field = '';
  for (const p of parts) field += /^\d+$/.test(p) ? `[${p}]` : field ? `.${p}` : p;
  const extra = err.params?.missingProperty ?? err.params?.additionalProperty;
  if (extra) field = field ? `${field}.${extra}` : extra;
  // A duplicate names its second occurrence, as the loader does.
  if (err.keyword === 'uniqueItems') field += `[${Math.max(err.params.i, err.params.j)}]`;
  return field || '(root)';
}

function messageOf(err) {
  if (err.keyword === 'additionalProperties') return 'unknown field (not in the Interlock schema)';
  if (err.keyword === 'required') return 'missing';
  if (err.keyword === 'false schema') return 'not used with this eligibility source';
  if (err.keyword === 'uniqueItems') return 'listed twice';
  if (err.keyword === 'enum') return `must be one of ${err.params.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
  return err.message ?? err.keyword;
}

/**
 * Validates `value` against the template or cast schema.
 * @param {'template'|'cast'} kind
 * @returns {Array<{field: string, message: string}>} empty when valid; the most specific errors first
 */
export function schemaErrors(kind, value) {
  validators ??= compile();
  const v = validators[kind];
  if (!v) throw new Error(`unknown schema kind ${kind}`);
  if (v(value)) return [];
  // Composite keywords (if/then/not/allOf) only say "something below failed"; report the concrete ones first.
  const composite = new Set(['if', 'then', 'else', 'not', 'allOf', 'anyOf', 'oneOf']);
  const errs = [...v.errors].sort((a, b) => Number(composite.has(a.keyword)) - Number(composite.has(b.keyword)));
  return errs.map((e) => ({ field: fieldOf(e), message: messageOf(e), keyword: e.keyword }));
}
