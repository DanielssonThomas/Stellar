import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readCodexBatches } from './codex-collector.mjs';
import { readClaims } from './collector-claims.mjs';
import { readHermesBatches } from './hermes-collector.mjs';
import { recordBudget } from './history.mjs';
import { defaultDatabasePath, recordBatch } from './store.mjs';

const defaultRepository = path.resolve(import.meta.dirname, '../..');
const watchIntervalMs = 30_000;
const maxWriteFailures = 4;
const maxRememberedBatches = 800;

export function collect({
  repository = defaultRepository,
  dbPath = defaultDatabasePath(),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  hermesHome = process.env.STELLAR_HERMES_ROOT ||
    (process.platform === 'win32'
      ? 'D:\\Hermes'
      : path.join(os.homedir(), '.hermes')),
  now = Date.now(),
  previous = new Map(),
} = {}) {
  const result = {
    written: 0,
    unchanged: 0,
    budgetsWritten: 0,
    budgetFailures: 0,
    unavailable: 0,
    writeFailures: 0,
  };
  let claims = [];
  let budgets = [];
  try {
    ({ claims, budgets } = readClaims(repository));
  } catch {
    result.unavailable++;
  }
  for (const budget of budgets) {
    const key = `budget:${budget.issue}`;
    const hash = hashObservation(budget);
    if (previous.get(key) === hash) continue;
    try {
      result.budgetsWritten += recordBudget(
        dbPath,
        budget.issue,
        budget.revisions,
        budget.complexity,
        { allowHistoricalPrefix: true },
      );
      remember(previous, key, hash);
    } catch (error) {
      result.budgetFailures++;
      if (error?.errcode || /engineering database/.test(error?.message ?? ''))
        break;
    }
  }
  const sources = [
    readCodexBatches({ home: codexHome, claims, now }),
    readHermesBatches({
      home: hermesHome,
      claims,
      now,
      onUnavailable: () => result.unavailable++,
    }),
  ];
  for (const source of sources) {
    try {
      for (const batch of source) {
        if (result.writeFailures >= maxWriteFailures) return result;
        const key = `${batch.session.source}:${batch.session.id}`;
        const hash = hashObservation(batch);
        if (previous.get(key) === hash) {
          result.unchanged++;
          continue;
        }
        try {
          recordBatch(dbPath, batch);
          remember(previous, key, hash);
          result.written++;
        } catch {
          // A bad source row, lock, or damaged history store must never affect the agent.
          result.writeFailures++;
        }
      }
    } catch {
      result.unavailable++;
    }
  }
  return result;
}

function hashObservation(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function remember(previous, key, hash) {
  previous.delete(key);
  previous.set(key, hash);
  if (previous.size > maxRememberedBatches)
    previous.delete(previous.keys().next().value);
}

async function main([mode]) {
  if (mode === '--once') {
    process.stdout.write(`${JSON.stringify(collect())}\n`);
    return;
  }
  if (mode !== '--watch') {
    process.stderr.write(
      'Usage: node tools/engineering-intelligence/collector.mjs --once | --watch\n',
    );
    process.exitCode = 2;
    return;
  }
  const previous = new Map();
  let health;
  while (true) {
    const { unavailable, writeFailures, budgetFailures } = collect({
      previous,
    });
    const nextHealth = JSON.stringify({
      unavailable,
      writeFailures,
      budgetFailures,
    });
    if (health !== nextHealth) {
      process.stdout.write(`${nextHealth}\n`);
      health = nextHealth;
    }
    await setTimeout(watchIntervalMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2));
