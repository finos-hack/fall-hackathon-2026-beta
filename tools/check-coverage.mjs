// Coverage gate for the kit contracts, read from an lcov report.
// Usage: node tools/check-coverage.mjs lcov.info <minLines> <minBranches> <minFunctions> file.sol [file.sol ...]
//
// Why lines are not held to 95%: coverage needs --ir-minimum (Shibui's sources hit "stack too deep" without
// via-IR), and its source maps report inline assembly and some internal calls (_pause, _requireNotPaused) as
// missed although every transfer and pause test executes them. Branches and functions are measured reliably
// and are held to the stricter bar. See docs/limits.md.
import { readFileSync } from 'node:fs';

const [file, minLines, minBranches, minFunctions, ...targets] = process.argv.slice(2);
const records = readFileSync(file, 'utf8').split('end_of_record');
const pct = (hit, found) => (found === 0 ? 100 : (100 * hit) / found);
const num = (rec, key) => Number(new RegExp(`^${key}:(\\d+)`, 'm').exec(rec)?.[1] ?? 0);
let failed = false;
for (const target of targets) {
  const rec = records.find((r) => r.includes(`SF:${target}\n`));
  if (!rec) {
    console.error(`FAIL ${target}: not in the coverage report`);
    failed = true;
    continue;
  }
  const checks = [
    ['lines', pct(num(rec, 'LH'), num(rec, 'LF')), Number(minLines)],
    ['branches', pct(num(rec, 'BRH'), num(rec, 'BRF')), Number(minBranches)],
    ['functions', pct(num(rec, 'FNH'), num(rec, 'FNF')), Number(minFunctions)],
  ];
  for (const [name, value, min] of checks) {
    const ok = value >= min;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${target} ${name}: ${value.toFixed(1)}% (minimum ${min}%)`);
  }
}
process.exit(failed ? 1 : 0);
