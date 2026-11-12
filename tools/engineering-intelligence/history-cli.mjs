import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultDatabasePath,
  maintainDatabase,
  withDatabase,
} from './database.mjs';
import {
  evaluateIntervention,
  recordAllowance,
  recordBudget,
  recordIntervention,
  recordSkillActivation,
  recordSkillState,
} from './history.mjs';

const dbPath = defaultDatabasePath();
const repository = 'DanielssonThomas/Stellar';
const skillDirectory = fileURLToPath(
  new URL('../../.agents/skills', import.meta.url),
);

function numberArgument(value) {
  if (
    !/^\d{1,10}$/.test(value ?? '') ||
    Number(value) < 1 ||
    Number(value) > 2_147_483_647
  ) {
    throw new Error('Provide one valid GitHub issue number');
  }
  return Number(value);
}

function jsonFile(file) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 16_384)
    throw new Error('Provide a JSON file of at most 16 KiB');
  const raw = readFileSync(file);
  if (raw.length > 16_384) throw new Error('JSON file exceeds 16 KiB');
  return JSON.parse(raw);
}

async function syncBudget(arg, complexity) {
  const issueNumber = numberArgument(arg);
  const { readIssueBudget } = await import('../policy/issue-budget.mjs');
  const result = execFileSync(
    'gh',
    [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repository,
      '--json',
      'number,body',
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 128_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const issue = JSON.parse(result);
  if (issue.number !== issueNumber || typeof issue.body !== 'string')
    throw new Error('Unexpected GitHub issue');
  const revisions = readIssueBudget(issue.body)?.revisions ?? [];
  return {
    issue: issueNumber,
    appended: recordBudget(dbPath, issueNumber, revisions, complexity),
  };
}

async function run([command, arg, second, ...rest]) {
  if (rest.length || (second != null && command !== 'sync-budget'))
    throw new Error('Unexpected arguments');
  switch (command) {
    case 'sync-budget':
      return syncBudget(arg, second);
    case 'inventory': {
      if (arg) throw new Error('Inventory uses the checked-in skill directory');
      const { inventorySkills } = await import('./skill-inventory.mjs');
      return inventorySkills(dbPath, skillDirectory);
    }
    case 'skill-state':
      return { added: recordSkillState(dbPath, jsonFile(arg)) };
    case 'skill-activation':
      return { added: recordSkillActivation(dbPath, jsonFile(arg)) };
    case 'intervention':
      return { id: recordIntervention(dbPath, jsonFile(arg)) };
    case 'evaluate':
      return evaluateIntervention(dbPath, arg);
    case 'allowance':
      return { added: recordAllowance(dbPath, jsonFile(arg)) };
    case 'maintain':
      if (arg) throw new Error('Maintain accepts no arguments');
      return maintainDatabase(dbPath);
    case 'issue':
      return withDatabase(
        dbPath,
        (db) =>
          db
            .prepare(
              `SELECT * FROM engineering_budget
        WHERE issue_number = ?`,
            )
            .get(numberArgument(arg)) ?? null,
        { readOnly: true },
      );
    case 'patterns':
      if (arg) throw new Error('Patterns accepts no arguments');
      return withDatabase(
        dbPath,
        (db) =>
          db
            .prepare(
              `SELECT * FROM engineering_candidates
        ORDER BY occurrences DESC, fingerprint LIMIT 20`,
            )
            .all(),
        { readOnly: true },
      );
    default:
      throw new Error(
        'Usage: history-cli.mjs sync-budget <issue> [small|medium|large] | inventory | skill-state <json> | skill-activation <json> | intervention <json> | evaluate <id> | allowance <json> | maintain | issue <issue> | patterns',
      );
  }
}

try {
  process.stdout.write(
    `${JSON.stringify(await run(process.argv.slice(2)), null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Engineering history operation failed: ${error.code ? 'source or storage unavailable' : error.message}\n`,
  );
  process.exitCode = 1;
}
