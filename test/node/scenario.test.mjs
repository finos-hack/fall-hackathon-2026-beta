// E1: the scripted scenario runs W1..W9 on its own fresh local chain and reports 8 of 8, one line per check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, CHECKS } from '../../examples/scenario.mjs';
import { requireArtifacts } from './helpers/kit.mjs';

test('E1 runScenario prints one PASS line per definition-of-done check and 8 of 8', async () => {
  requireArtifacts();
  const lines = [];
  const r = await runScenario({ log: (l) => lines.push(l), env: { NETWORK: 'local' } });
  const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.n}: ${c.detail}`);
  assert.deepEqual(failing, [], `failing checks:\n${failing.join('\n')}`);
  assert.equal(r.passed, 8);
  assert.equal(r.total, 8);
  assert.equal(lines.length, CHECKS.length + 1, 'exactly one line per check plus the summary');
  CHECKS.forEach(([n, title], i) => {
    const prefix = n === 8 ? `PASS 8 (partial) ${title}` : `PASS ${n} ${title}`;
    assert.ok(lines[i].startsWith(prefix), `line ${i + 1}: ${lines[i]}`);
  });
  assert.match(lines[7], /human/, 'check 8 must say the human dry run is out of reach of a script');
  assert.equal(lines[8], '8 of 8');
});
