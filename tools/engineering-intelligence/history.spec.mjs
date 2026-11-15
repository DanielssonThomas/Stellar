import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { maintainDatabase, withDatabase } from './database.mjs';
import { diagnoseOutput } from './diagnostics.mjs';
import {
  evaluateIntervention,
  recordAllowance,
  recordBudget,
  recordIntervention,
  recordSkill,
  recordSkillActivation,
  recordSkillState,
} from './history.mjs';
import { inventorySkills } from './skill-inventory.mjs';
import { recordBatch } from './store.mjs';

const now = Date.parse('2026-11-11T20:00:00Z');
const minute = 60_000;
const stamp = (offset = 0) => new Date(now + offset * minute).toISOString();
const exec = promisify(execFile);
const marker = 'SYNTHETIC_SECRET_SHOULD_NEVER_BE_PERSISTED';
const rust = 'error[E0308]: mismatched types\nexpected `u32`, found `String`';

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'stellar-engineering-history-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, db: path.join(directory, 'history.sqlite') };
}

function session(id, issueNumber = 342, overrides = {}) {
  return {
    id,
    issueNumber,
    source: 'codex',
    agent: 'codex',
    startedAt: stamp(-20),
    model: 'gpt-6',
    provider: 'openai',
    reasoning: 'medium',
    ...overrides,
  };
}

function tokens(id, at, inputTokens, outputTokens, overrides = {}) {
  return {
    id,
    at,
    inputTokens,
    outputTokens,
    counterId: 'session',
    mode: 'cumulative',
    cachedTokens: Math.floor(inputTokens / 2),
    provenance: 'codex-rollout',
    ...overrides,
  };
}

function check(id, at, exitCode, output = rust, extras = {}) {
  return {
    id,
    at,
    exitCode,
    category: 'build',
    technology: 'rust',
    component: 'desktop',
    operationId: 'cargo-check-desktop',
    provenance: 'codex-thread-history',
    ...diagnoseOutput(output, {
      technology: 'rust',
      category: 'build',
      exitCode,
    }),
    ...extras,
  };
}

const revision = {
  revision: 1,
  recordedAt: stamp(-40),
  estimatedTokens: 100,
  allocatedTokens: 130,
  profile: 'Codex medium',
  confidence: 'low',
  evidence: [marker],
};

test('issue totals and original estimates survive replay, delayed samples and revisions', async (t) => {
  const { db } = await fixture(t);
  assert.equal(recordBudget(db, 342, [revision]), 1);
  const event = {
    session: session('main'),
    turns: [
      {
        id: 'turn-1',
        startedAt: stamp(-2),
        endedAt: stamp(-1),
        status: 'completed',
      },
    ],
    usage: [tokens('one', stamp(-3), 70, 10), tokens('two', stamp(-2), 80, 20)],
  };
  const main = recordBatch(db, event);
  assert.equal(recordBatch(db, event), main);
  recordBatch(db, {
    session: event.session,
    usage: [tokens('out-of-order', stamp(-4), 30, 4)],
  });
  recordBatch(db, {
    session: event.session,
    usage: [tokens('two', stamp(-2), 80, 20, { complete: true })],
  });
  recordBatch(db, {
    session: session('review', undefined, {
      issueNumber: undefined,
      parentId: 'main',
      agent: 'reviewer',
    }),
    usage: [
      tokens('review', stamp(-1), 25, 10, {
        complete: true,
        reasoningTokens: 6,
      }),
    ],
  });
  const next = {
    ...revision,
    revision: 2,
    recordedAt: stamp(-10),
    estimatedTokens: 120,
    allocatedTokens: 140,
  };
  assert.equal(recordBudget(db, 342, [revision, next]), 1);
  assert.equal(recordBudget(db, 342, [revision, next]), 0);
  assert.equal(
    recordBudget(db, 342, [revision], null, { allowHistoricalPrefix: true }),
    0,
  );
  assert.throws(
    () => recordBudget(db, 342, [{ ...revision, allocatedTokens: 99 }, next]),
    /immutable/,
  );
  assert.throws(() => recordBudget(db, 342, [revision]), /cannot be removed/);
  withDatabase(
    db,
    (db) => {
      const budget = db.prepare('SELECT * FROM engineering_budget').get();
      assert.equal(budget.observed_tokens, 135);
      assert.equal(budget.complete_sessions, 2);
      assert.equal(budget.session_count, 2);
      assert.equal(budget.baseline_variance, 35);
      assert.equal(budget.estimated_tokens, 120);
      assert.equal(budget.over_budget, 0);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM turns').get().count,
        1,
      );
      assert.equal(
        db
          .prepare('SELECT parent_id FROM sessions WHERE agent = ?')
          .get('reviewer').parent_id,
        main,
      );
    },
    { readOnly: true },
  );
  assert.equal((await readFile(db)).includes(marker), false);
});

test('delta partitions deduplicate and inconsistent or overlapping counters roll back', async (t) => {
  const { db } = await fixture(t);
  const event = (id, overrides = {}) =>
    tokens(id, stamp(), 15, 5, {
      counterId: 'model-a',
      mode: 'delta',
      ...overrides,
    });
  const source = session('partitioned');
  recordBatch(db, {
    session: source,
    usage: [event('one'), event('one'), event('two')],
  });
  assert.throws(
    () =>
      recordBatch(db, {
        session: source,
        usage: [event('invalid', { totalTokens: 1 })],
      }),
    /Inconsistent/,
  );
  assert.throws(
    () =>
      recordBatch(db, {
        session: source,
        usage: [
          event('duplicate', { counterId: 'session', mode: 'cumulative' }),
        ],
      }),
    /partitioned/,
  );
  const usage = withDatabase(
    db,
    (db) => db.prepare('SELECT * FROM engineering_usage').get(),
    { readOnly: true },
  );
  assert.equal(usage.observed_tokens, 40);
  assert.equal(usage.cached_tokens, 14);
  assert.equal(usage.uncached_tokens, 16);
});

test('Rust fingerprints retain unquoted type classes and isolate diagnostic blocks', () => {
  const diagnose = (output) =>
    diagnoseOutput(output, {
      technology: 'rust',
      category: 'build',
      exitCode: 101,
    });
  const boolean =
    'error[E0308]: mismatched types\n  |  ^^ expected `bool`, found integer';
  const float = boolean.replace('`bool`', '`f64`');
  const earlier = 'error[E0432]: unresolved import `foo`\n  | use foo;';
  assert.notEqual(
    diagnose(boolean).diagnosticHash,
    diagnose(float).diagnosticHash,
  );
  assert.equal(
    diagnose(earlier + '\n\n' + boolean).diagnosticHash,
    diagnose(earlier).diagnosticHash,
  );
  assert.equal(
    diagnose(boolean + '\n --> src/main.rs:1:5').diagnosticHash,
    diagnose(boolean).diagnosticHash,
  );
  assert.deepEqual(
    diagnose('\x1b[31m' + boolean + '\x1b[0m'),
    diagnose(boolean),
  );
});

test('repeated diagnostics preserve scope, intentional failures and observed resolution', async (t) => {
  const { db } = await fixture(t);
  const first = {
    session: session('first'),
    attempts: [
      check('one', stamp(-10), 101, rust + '\n --> ' + marker),
      check('two', stamp(-9), 101, rust),
      check('diagnostic', stamp(-8), 101, rust, { diagnostic: true }),
      check('different', stamp(-7), 101, rust.replace('String', 'bool')),
      check('resolved', stamp(-6), 0),
    ],
  };
  recordBatch(db, first);
  recordBatch(db, first);
  recordBatch(db, {
    session: session('second', 343),
    attempts: [check('other', stamp(-5), 101)],
  });
  const candidate = withDatabase(
    db,
    (db) => {
      const failures = db
        .prepare('SELECT * FROM engineering_failures ORDER BY at')
        .all();
      assert.equal(failures.length, 5);
      assert.equal(failures[0].fingerprint, failures[1].fingerprint);
      assert.notEqual(failures[0].fingerprint, failures[3].fingerprint);
      assert.equal(failures[1].retry, 1);
      assert.equal(failures[0].resolved, 1);
      assert.equal(failures[2].diagnostic, 1);
      assert.equal(failures[2].retry, null);
      assert.equal(failures[4].resolved, 0);
      return db.prepare('SELECT * FROM engineering_candidates').get();
    },
    { readOnly: true },
  );
  assert.equal(candidate.occurrences, 3);
  assert.equal(candidate.issues, 2);
  assert.equal(candidate.retries, 1);
  assert.equal((await readFile(db)).includes(marker), false);
});

test('tracks skill versions, estimates, actual activation and observational comparisons', async (t) => {
  const { db, directory } = await fixture(t);
  const skills = path.join(directory, 'skills');
  const skill = path.join(skills, 'rust-checks');
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '# Rust checks\nRun cargo check before tests.\n',
  );
  const [first] = inventorySkills(db, skills, stamp(-30));
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '# Rust checks\nRun cargo check and clippy before tests.\n',
  );
  const [second] = inventorySkills(db, skills, stamp(-15));
  assert.notEqual(first.version, second.version);
  assert.ok(second.staticTokens > first.staticTokens);
  assert.throws(
    () =>
      recordSkill(db, {
        ...first,
        contentHash: 'f'.repeat(64),
        recordedAt: stamp(),
        tokenizer: 'o200k_base/js-tiktoken-1.0.21',
      }),
    /immutable/,
  );
  recordSkillState(db, {
    ...second,
    state: 'experimental',
    recordedAt: stamp(-15),
  });
  recordBatch(db, {
    session: session('before'),
    attempts: [check('failure', stamp(-11), 101)],
    usage: [tokens('before', stamp(-11), 45, 7)],
  });
  const activation = {
    id: 'load',
    source: 'codex',
    sessionId: 'before',
    ...second,
    at: stamp(-12),
    loadedTokens: 12,
    referenceTokens: 5,
    provenance: 'controlled-fixture',
  };
  assert.equal(recordSkillActivation(db, activation), 1);
  assert.equal(recordSkillActivation(db, activation), 0);
  const fingerprint = withDatabase(
    db,
    (db) => db.prepare('SELECT fingerprint FROM failures').get().fingerprint,
  );
  recordIntervention(db, {
    id: 'rust-checks-1',
    kind: 'existing-skill',
    version: second.version,
    startedAt: stamp(-10),
    fingerprints: [fingerprint],
    expectedImprovement: 'Fewer mismatched-type failures',
    implementationRef: 'Fixture change',
    model: 'gpt-6',
    reasoning: 'medium',
    windowDays: 7,
  });
  let [comparison] = evaluateIntervention(db, 'rust-checks-1', stamp(-9));
  assert.equal(comparison.evidence_status, 'incomplete');
  assert.equal(comparison.after_failures, null);
  recordBatch(db, {
    session: session('after'),
    attempts: [check('success', stamp(-2), 0)],
    usage: [tokens('after', stamp(-2), 21, 4)],
  });
  [comparison] = evaluateIntervention(db, 'rust-checks-1', stamp(-1));
  assert.equal(comparison.evidence_status, 'limited');
  assert.equal(comparison.before_failure_rate, 1);
  assert.equal(comparison.after_failure_rate, 0);
  assert.equal(comparison.after_observed_tokens, 25);
  withDatabase(
    db,
    (db) => {
      const row = db
        .prepare('SELECT * FROM engineering_skills WHERE version = ?')
        .get(second.version);
      assert.equal(row.activations, 1);
      assert.equal(row.loaded_tokens, 12);
      assert.equal(row.discovery_tokens, null);
      assert.equal(row.state, 'experimental');
      assert.equal(
        db
          .prepare('SELECT COUNT(*) AS count FROM intervention_evaluations')
          .get().count,
        2,
      );
    },
    { readOnly: true },
  );
});

test('retention removes detail and retains issue rollups without replay inflation', async (t) => {
  const { db } = await fixture(t);
  recordBudget(db, 342, [revision]);
  const event = {
    session: session('retained'),
    usage: [tokens('usage', stamp(), 40, 10, { complete: true })],
  };
  recordBatch(db, event);
  recordAllowance(db, {
    source: 'codex-account',
    usedPercent: 44.5,
    windowMinutes: 300,
    observedAt: stamp(),
    resetsAt: stamp(100),
  });
  const retentionClock = new Date(now + 181 * 86_400_000);
  assert.equal(maintainDatabase(db, retentionClock).sessions, 1);
  assert.equal(recordBatch(db, event), null);
  withDatabase(
    db,
    (db) => {
      const budget = db.prepare('SELECT * FROM engineering_budget').get();
      assert.equal(budget.session_count, 1);
      assert.equal(budget.observed_tokens, 50);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM allowance_observations').get()
          .count,
        0,
      );
    },
    { readOnly: true },
  );
});

test('simultaneous collectors use atomic migrations and deduplicate the same source', async (t) => {
  const { db } = await fixture(t);
  const batch = {
    session: session('parallel'),
    usage: [tokens('usage', stamp(), 100, 50)],
  };
  const module = new URL('./store.mjs', import.meta.url).href;
  const writer = `import { recordBatch } from ${JSON.stringify(module)};
    import { setTimeout } from 'node:timers/promises';
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        recordBatch(process.argv[1], JSON.parse(process.argv[2]));
        break;
      } catch (error) {
        if (attempt === 7 || !/locked|busy/i.test(error.message)) throw error;
        await setTimeout(15);
      }
    }`;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      exec(
        process.execPath,
        ['--input-type=module', '-e', writer, db, JSON.stringify(batch)],
        { windowsHide: true, timeout: 10_000 },
      ),
    ),
  );
  withDatabase(
    db,
    (db) => {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(
        db.prepare('SELECT observed_tokens FROM engineering_budget').get()
          .observed_tokens,
        150,
      );
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    },
    { readOnly: true },
  );
});
