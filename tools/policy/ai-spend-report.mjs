import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileSpendingLedger } from './ai-spend-ledger.mjs';

export async function main(argv = process.argv.slice(2)) {
  const month = argv[0];
  const path = process.env.STELLAR_AI_SPEND_LEDGER;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month ?? '') || !path)
    throw new Error(
      'Usage: STELLAR_AI_SPEND_LEDGER=<shared-absolute-path> node ai-spend-report.mjs YYYY-MM',
    );
  const report = await new FileSpendingLedger(path).report(month);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
