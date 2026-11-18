// npm run conformance -- <suite> [options]: run Interlock's conformance suites against any contracts, read-only.
//
//   erc7943      --rpc <url> --token <address>                     an ERC-7943 fungible token
//   eligibility  --rpc <url> --slot <address> [--expect <file>]    an IEligibility slot; expect: {"0x..": true}
//   deployment   --rpc <url> --deployment <file>                   every token and slot of an Interlock deployment
//
// Exit status 0 when every check passes, 1 otherwise, 2 for bad arguments.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { erc7943, eligibility, report, clientFor, parseArgs } from './conformance.mjs';

const HELP = readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');

export async function main(argv, log = console.log) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    log(`${e.message}\n\n${HELP}`);
    return 2;
  }
  const { suite, opts } = a;
  if (!suite || suite === '--help' || !opts.rpc) {
    log(HELP);
    return suite === '--help' ? 0 : 2;
  }
  const client = clientFor(opts.rpc);
  let ok = true;
  if (suite === 'erc7943') {
    if (!opts.token) return log('--token is required'), 2;
    ok = report(`ERC-7943 ${opts.token}`, await erc7943(client, opts.token), log);
  } else if (suite === 'eligibility') {
    if (!opts.slot) return log('--slot is required'), 2;
    const expect = opts.expect ? JSON.parse(readFileSync(opts.expect, 'utf8')) : {};
    ok = report(`IEligibility ${opts.slot}`, await eligibility(client, opts.slot, expect), log);
  } else if (suite === 'deployment') {
    if (!opts.deployment) return log('--deployment is required'), 2;
    const d = JSON.parse(readFileSync(opts.deployment, 'utf8'));
    for (const t of d.tokens) {
      ok = report(`ERC-7943 ${t.symbol} ${t.address}`, await erc7943(client, t.address), log) && ok;
      ok = report(`IEligibility of ${t.symbol} (${t.eligibilitySource ?? 'shibui'}) ${t.eligibility}`, await eligibility(client, t.eligibility), log) && ok;
    }
  } else {
    log(`unknown suite "${suite}"\n\n${HELP}`);
    return 2;
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e.stack ?? e.message);
    process.exit(1);
  });
}
