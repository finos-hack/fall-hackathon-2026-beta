// Fails when line coverage of the named files in an lcov report is below a threshold.
// Usage: node tools/check-coverage.mjs lcov.info 95 contracts/A.sol contracts/B.sol
import { readFileSync } from 'node:fs';

const [file, minArg, ...targets] = process.argv.slice(2);
const min = Number(minArg);
const records = readFileSync(file, 'utf8').split('end_of_record');
let failed = false;
for (const target of targets) {
  const rec = records.find((r) => r.includes(`SF:${target}`));
  if (!rec) {
    console.error(`FAIL ${target}: not in the coverage report`);
    failed = true;
    continue;
  }
  const found = Number(/LF:(\d+)/.exec(rec)?.[1] ?? 0);
  const hit = Number(/LH:(\d+)/.exec(rec)?.[1] ?? 0);
  const pct = found === 0 ? 100 : (100 * hit) / found;
  const ok = pct >= min;
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${target}: ${pct.toFixed(1)}% of ${found} lines (minimum ${min}%)`);
}
process.exit(failed ? 1 : 0);
