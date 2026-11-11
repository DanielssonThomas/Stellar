import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { classifyCommand } from './codex-collector.mjs';
import { collect } from './collector.mjs';
import { openDatabase } from './database.mjs';

const now = Date.parse('2026-11-11T20:00:00Z');
const timestamp = (at) => new Date(at).toISOString();
const sourceSecret = 'sk-source-secret-must-never-be-persisted';
const repoOrigin = 'https://github.com/example/stellar.git';
const budget = {
  revision: 1,
  recordedAt: timestamp(now - 360_000),
  estimatedTokens: 500,
  allocatedTokens: 800,
  profile: 'Fixture Codex',
  confidence: 'medium',
};
const fixtures = (parent, name) => {
  const directory = path.join(parent, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

function fixtureGit(repository, ...args) {
  execFileSync('git', ['-C', repository, ...args], { stdio: 'ignore' });
}

function setupRepository(root) {
  const repository = fixtures(root, 'repo');
  fixtureGit(repository, 'init', '-b', 'develop');
  fixtureGit(
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture',
  );
  fixtureGit(repository, 'remote', 'add', 'origin', repoOrigin);
  const claims = fixtures(repository, '.git/stellar-agent/claims');
  const worktrees = [342, 343].map((issue) => {
    const branch = `issue/${issue}-fixture`;
    const worktreePath = path.join(root, `issue-${issue}`);
    fixtureGit(repository, 'worktree', 'add', '-b', branch, worktreePath);
    writeFileSync(
      path.join(claims, `${issue}.json`),
      JSON.stringify({
        issue,
        branch,
        worktreePath,
        state: 'active',
        createdAt: timestamp(now - 300_000),
        expiresAt: timestamp(now + 300_000),
        budgetRevisions: [budget],
      }),
    );
    return { branch, worktreePath };
  });
  writeFileSync(
    path.join(claims, '344.json'),
    JSON.stringify({
      issue: 344,
      branch: 'issue/344-fixture',
      state: 'released',
      releasedAt: timestamp(now - 10_000),
      budgetRevisions: [budget],
    }),
  );
  return { repository, worktrees, claims };
}

function setupCodex(home, [first, second]) {
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  state.exec(`
    CREATE TABLE threads (
      id, cwd, git_branch, git_origin_url, created_at_ms, updated_at_ms, model, model_provider,
      reasoning_effort, rollout_path, history_mode, source
    );
    CREATE TABLE thread_spawn_edges (parent_thread_id, child_thread_id);
    INSERT INTO thread_spawn_edges VALUES ('root-first', 'child-first');
  `);
  history.exec(`
    CREATE TABLE thread_turns (thread_id, turn_id, status, started_at, completed_at);
    CREATE TABLE thread_items (thread_id, turn_id, item_id, item_type, created_at_ms, completed_at_ms, item_json);
  `);
  const rollouts = fixtures(home, 'sessions');
  for (const [id, cwd, branch, origin, command, output, exit, priorUsage] of [
    [
      'root-first',
      path.toNamespacedPath(first.worktreePath),
      first.branch,
      repoOrigin,
      'cargo check',
      'error[E0308]: mismatched types',
      1,
      100,
    ],
    [
      'child-first',
      home,
      null,
      null,
      'cargo test # stellar:diagnostic',
      'test fixture ... FAILED',
      101,
      20,
    ],
    [
      'root-second',
      second.worktreePath,
      second.branch,
      repoOrigin,
      'cargo check',
      'error[E0308]: mismatched types',
      1,
      40,
    ],
    [
      'incorrect-branch',
      first.worktreePath,
      'develop',
      repoOrigin,
      'cargo check',
      'error[E0308]: mismatched types',
      1,
      30,
    ],
    [
      'incorrect-origin',
      first.worktreePath,
      first.branch,
      'https://github.com/other/repo',
      'cargo check',
      'error[E0308]: mismatched types',
      1,
      30,
    ],
    [
      'path-lookalike',
      `${first.worktreePath}-other`,
      first.branch,
      repoOrigin,
      'cargo check',
      'error[E0308]: mismatched types',
      1,
      30,
    ],
  ]) {
    const rollout = path.join(rollouts, `rollout-fixture-${id}.jsonl`);
    state
      .prepare(
        'INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        cwd,
        branch,
        origin,
        now - 120_000,
        now - 1000,
        'gpt-fixture',
        'openai',
        'medium',
        rollout,
        'paginated',
        'exec',
      );
    const observedAt = now - 5000;
    const records = [priorUsage, priorUsage * 2].map((input, ordinal) => ({
      timestamp: timestamp(observedAt + ordinal * 1000),
      ordinal,
      type: 'token_usage_record',
      payload: {
        thread_id: id,
        thread_token_usage: {
          input_tokens: input,
          cached_input_tokens: input / 2,
          output_tokens: 4,
          reasoning_output_tokens: 1,
          cache_write_input_tokens: 0,
          total_tokens: input + 4,
        },
      },
    }));
    writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'response_item',
          payload: { content: sourceSecret },
        }),
        ...records.map((record) => JSON.stringify(record)),
        '',
      ].join('\n'),
    );
    history
      .prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)')
      .run(
        id,
        'fixture-turn',
        'completed',
        (now - 90_000) / 1000,
        (now - 2000) / 1000,
      );
    const result = {
      type: 'commandExecution',
      status: 'failed',
      exitCode: exit,
      cwd,
      commandActions: [{ type: 'unknown', command }],
      aggregatedOutput: `${output}\nAuthorization: ${sourceSecret}`,
    };
    history
      .prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        'fixture-turn',
        'fixture-call',
        'commandExecution',
        now - 7000,
        now - 6000,
        JSON.stringify(result),
      );
  }
  state.close();
  history.close();
}

function setupHermes(home, profile = 'ivy', worktree) {
  const database = new DatabaseSync(
    path.join(fixtures(home, `profiles/${profile}`), 'state.db'),
  );
  database.exec(`
    CREATE TABLE schema_version (version);
    INSERT INTO schema_version VALUES (32);
    CREATE TABLE sessions (
      id, parent_session_id, cwd, git_branch, git_repo_root, started_at, ended_at, end_reason,
      model, billing_provider, last_activity_at, prompt
    );
    CREATE TABLE session_model_usage (
      session_id, model, billing_provider, last_seen, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, api_call_count
    );
    CREATE TABLE messages (id, session_id, timestamp, tool_name, content);
  `);
  database
    .prepare(
      'INSERT INTO sessions VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      `${profile}-fixture`,
      worktree?.worktreePath ?? null,
      worktree?.branch ?? null,
      worktree?.worktreePath ?? null,
      (now - 60_000) / 1000,
      null,
      null,
      `${profile}-fixture-model`,
      'openai-codex',
      (now - 1000) / 1000,
      sourceSecret,
    );
  database
    .prepare(
      'INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      `${profile}-fixture`,
      `${profile}-fixture-model`,
      'openai-codex',
      (now - 1500) / 1000,
      10,
      4,
      3,
      2,
      1,
      1,
    );
  database.close();
}

test('collector links claimed work, preserves split counters and retries safely', (t) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'stellar-engineering-collector-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const { repository, worktrees, claims } = setupRepository(root);
  const codexHome = fixtures(root, 'codex');
  const hermesHome = fixtures(root, 'hermes');
  const dbPath = path.join(root, 'engineering.sqlite');
  const options = { repository, codexHome, hermesHome, dbPath, now };
  setupCodex(codexHome, worktrees);
  setupHermes(hermesHome);
  const first = collect(options);
  assert.equal(first.written, 4);
  assert.equal(first.budgetsWritten, 3);
  assert.equal(first.writeFailures, 0);
  const replay = collect(options);
  assert.equal(replay.written, 4);
  assert.equal(replay.budgetsWritten, 0);

  const database = openDatabase(dbPath, { readOnly: true });
  try {
    const sessions = database
      .prepare(
        'SELECT agent, issue_number, parent_id FROM sessions ORDER BY agent, issue_number',
      )
      .all();
    assert.deepEqual(
      sessions.map(({ agent, issue_number }) => [agent, issue_number]),
      [
        ['codex', 342],
        ['codex', 343],
        ['codex-subagent', 342],
        ['ivy', null],
      ],
    );
    assert.ok(sessions[2].parent_id);
    const usage = database
      .prepare(
        `
      SELECT s.agent, s.issue_number, u.input_tokens, u.cached_tokens, u.cache_write_tokens, u.total_tokens
      FROM usage_observations u JOIN sessions s ON u.session_id = s.id ORDER BY s.agent, s.issue_number
    `,
      )
      .all()
      .map((row) => Object.values(row));
    assert.deepEqual(usage, [
      ['codex', 342, 200, 100, 0, 204],
      ['codex', 343, 80, 40, 0, 84],
      ['codex-subagent', 342, 40, 20, 0, 44],
      ['ivy', null, 15, 3, 2, 19],
    ]);
    const attempts = database
      .prepare(
        'SELECT category, fingerprint, exit_code, diagnostic FROM attempts ORDER BY category, exit_code',
      )
      .all();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].exit_code, 1);
    assert.ok(attempts[0].fingerprint);
    assert.equal(attempts[0].fingerprint, attempts[1].fingerprint);
    assert.notEqual(attempts[1].fingerprint, attempts[2].fingerprint);
    assert.equal(attempts[2].diagnostic, 1);
    assert.deepEqual(
      database
        .prepare(
          'SELECT issue_number FROM budget_revisions ORDER BY issue_number',
        )
        .all()
        .map(({ issue_number }) => issue_number),
      [342, 343, 344],
    );
  } finally {
    database.close();
  }
  assert.ok(!readFileSync(dbPath).includes(sourceSecret));

  const ivyState = new DatabaseSync(
    path.join(hermesHome, 'profiles/ivy/state.db'),
  );
  ivyState
    .prepare("UPDATE sessions SET ended_at = ?, end_reason = 'agent_close'")
    .run((now - 500) / 1000);
  ivyState.close();
  assert.equal(collect(options).written, 4);
  const closedDatabase = openDatabase(dbPath, { readOnly: true });
  try {
    const closure = closedDatabase
      .prepare(
        `
      SELECT u.complete, u.total_tokens FROM usage_observations u
      JOIN sessions s ON u.session_id = s.id WHERE s.agent = 'ivy' ORDER BY u.at
    `,
      )
      .all();
    assert.deepEqual(
      closure.map((row) => Object.values(row)),
      [
        [0, 19],
        [1, 19],
      ],
    );
  } finally {
    closedDatabase.close();
  }

  const activeClaimPath = path.join(claims, '342.json');
  const activeClaim = JSON.parse(readFileSync(activeClaimPath, 'utf8'));
  activeClaim.budgetRevisions[0].estimatedTokens = 900;
  writeFileSync(activeClaimPath, JSON.stringify(activeClaim));
  const conflictingBudget = collect(options);
  assert.equal(conflictingBudget.budgetFailures, 1);
  assert.equal(conflictingBudget.written, 4);

  const corrupted = path.join(root, 'corrupted.sqlite');
  writeFileSync(corrupted, 'bad SQLite fixture');
  assert.doesNotThrow(() => collect({ ...options, dbPath: corrupted }));
  assert.equal(collect({ ...options, dbPath: corrupted }).writeFailures, 4);
  assert.equal(readFileSync(corrupted, 'utf8'), 'bad SQLite fixture');
});

test('command attribution requires a simple recognized operation and explicit diagnostics', () => {
  const cwd = path.resolve('fixture-a');
  const rust = classifyCommand('cargo clippy --all-targets', cwd);
  assert.equal(rust.category, 'lint');
  assert.equal(rust.technology, 'rust');
  assert.equal(
    classifyCommand('cargo clippy --all-targets # stellar:diagnostic', cwd)
      .operationId,
    rust.operationId,
  );
  assert.notEqual(
    classifyCommand('cargo clippy --all-targets', path.resolve('fixture-b'))
      .operationId,
    rust.operationId,
  );
  assert.equal(classifyCommand('cargo test -- --ignored').diagnostic, false);
  assert.ok(
    !classifyCommand('cargo test --filter "fixture # stellar:diagnostic"')
      .diagnostic,
  );
  assert.equal(classifyCommand('pnpm nx affected -t e2e').category, 'test');
  assert.equal(classifyCommand('pnpm exec tsc --noEmit').category, 'check');
  assert.equal(classifyCommand('cargo test; exit 1').category, undefined);
});

test('claim expiry caps a subsequently released session’s events and cumulative usage', (t) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'stellar-engineering-collector-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const { repository, worktrees, claims } = setupRepository(root);
  const codexHome = fixtures(root, 'codex');
  const hermesHome = fixtures(root, 'hermes');
  const dbPath = path.join(root, 'engineering.sqlite');
  setupCodex(codexHome, worktrees);
  setupHermes(hermesHome, 'architect', worktrees[0]);

  const claimFile = path.join(claims, '342.json');
  const claim = JSON.parse(readFileSync(claimFile, 'utf8'));
  writeFileSync(
    claimFile,
    JSON.stringify({
      ...claim,
      state: 'released',
      expiresAt: timestamp(now - 3500),
      releasedAt: timestamp(now - 2500),
    }),
  );
  appendFileSync(
    path.join(codexHome, 'sessions', 'rollout-fixture-root-first.jsonl'),
    `${JSON.stringify({
      timestamp: timestamp(now - 3000),
      ordinal: 2,
      type: 'token_usage_record',
      payload: {
        thread_id: 'root-first',
        thread_token_usage: {
          input_tokens: 300,
          output_tokens: 4,
          total_tokens: 304,
        },
      },
    })}\n`,
  );
  const codexHistory = new DatabaseSync(
    path.join(codexHome, 'thread_history_1.sqlite'),
  );
  codexHistory
    .prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      'root-first',
      'fixture-turn',
      'late-command',
      'commandExecution',
      now - 4500,
      now - 3000,
      null,
    );
  codexHistory.close();
  const hermesState = new DatabaseSync(
    path.join(hermesHome, 'profiles/architect/state.db'),
  );
  hermesState
    .prepare("UPDATE sessions SET ended_at = ?, end_reason = 'agent_close'")
    .run((now - 2000) / 1000);
  hermesState
    .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
    .run(1, 'architect-fixture', (now - 3000) / 1000, 'terminal', sourceSecret);
  hermesState.close();

  const result = collect({ repository, codexHome, hermesHome, dbPath, now });
  assert.equal(result.written, 4);
  assert.equal(result.writeFailures, 0);
  const database = openDatabase(dbPath, { readOnly: true });
  try {
    const observations = database
      .prepare(
        `
      SELECT s.agent, u.total_tokens, s.ended_at
      FROM sessions s LEFT JOIN usage_observations u ON s.id = u.session_id
      WHERE s.issue_number = 342 ORDER BY s.agent
    `,
      )
      .all();
    assert.deepEqual(
      observations.map((row) => Object.values(row)),
      [
        ['architect', null, null],
        ['codex', 204, null],
        ['codex-subagent', 44, null],
      ],
    );
    assert.equal(
      database.prepare('SELECT count(*) AS count FROM attempts').get().count,
      3,
    );
    assert.equal(
      database
        .prepare(
          `
      SELECT count(*) AS count FROM turns t JOIN sessions s ON t.session_id = s.id
      WHERE s.issue_number = 342 AND t.ended_at IS NOT NULL
    `,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});
