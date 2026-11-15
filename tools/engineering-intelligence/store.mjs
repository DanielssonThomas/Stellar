import { defaultDatabasePath, transaction, withDatabase } from './database.mjs';
import { digest, failureSignature } from './diagnostics.mjs';
import {
  choice,
  identifier,
  integer,
  opaqueId,
  statuses,
  timestamp,
  tokenCount,
} from './values.mjs';

export { defaultDatabasePath } from './database.mjs';

const sources = ['codex', 'hermes'];
const categories = ['build', 'test', 'lint', 'check', 'tool', 'ci'];

function eventRows(rows = []) {
  if (!Array.isArray(rows) || rows.length > 500)
    throw new Error('Too many engineering observations');
  return rows;
}

export function sessionId(source, id) {
  return digest(
    choice(source, 'session source', sources),
    'session',
    opaqueId(id, 'session ID'),
  ).slice(0, 32);
}

function insertSession(db, session, seenAt) {
  const source = choice(session.source, 'session source', sources);
  const id = sessionId(source, session.id);
  const parent =
    session.parentId == null ? null : sessionId(source, session.parentId);
  if (parent === id) throw new Error('Session cannot be its own parent');
  const inheritedIssue =
    parent == null
      ? null
      : db.prepare('SELECT issue_number FROM sessions WHERE id = ?').get(parent)
          ?.issue_number;
  const issue = integer(
    session.issueNumber ?? inheritedIssue,
    'issue number',
    1,
    2_147_483_647,
    true,
  );
  const existing = db
    .prepare('SELECT issue_number, parent_id FROM sessions WHERE id = ?')
    .get(id);
  if (
    (existing?.issue_number != null &&
      issue != null &&
      existing.issue_number !== issue) ||
    (existing?.parent_id != null &&
      parent != null &&
      existing.parent_id !== parent) ||
    (session.issueNumber != null &&
      inheritedIssue != null &&
      session.issueNumber !== inheritedIssue)
  ) {
    throw new Error('Conflicting session attribution');
  }
  if (issue != null)
    db.prepare(
      'INSERT INTO issues(number) VALUES (?) ON CONFLICT DO NOTHING',
    ).run(issue);
  db.prepare(
    `INSERT INTO sessions
    (id, source, agent, issue_number, parent_id, model, provider, reasoning,
     started_at, ended_at, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      issue_number = COALESCE(sessions.issue_number, excluded.issue_number),
      parent_id = COALESCE(sessions.parent_id, excluded.parent_id),
      model = COALESCE(sessions.model, excluded.model),
      provider = COALESCE(sessions.provider, excluded.provider),
      reasoning = COALESCE(sessions.reasoning, excluded.reasoning),
      started_at = COALESCE(MIN(sessions.started_at, excluded.started_at), sessions.started_at, excluded.started_at),
      ended_at = COALESCE(MAX(sessions.ended_at, excluded.ended_at), sessions.ended_at, excluded.ended_at),
      status = CASE WHEN excluded.ended_at IS NOT NULL AND
        (sessions.ended_at IS NULL OR excluded.ended_at >= sessions.ended_at)
        THEN COALESCE(excluded.status, sessions.status)
        ELSE COALESCE(sessions.status, excluded.status) END,
      last_seen_at = MAX(sessions.last_seen_at, excluded.last_seen_at)`,
  ).run(
    id,
    source,
    identifier(session.agent, 'agent'),
    issue,
    parent,
    identifier(session.model, 'model', true),
    identifier(session.provider, 'provider', true),
    identifier(session.reasoning, 'reasoning', true),
    timestamp(session.startedAt, true),
    timestamp(session.endedAt, true),
    seenAt,
    choice(session.status, 'session status', statuses, true),
  );
  if (issue != null) {
    db.prepare(
      'UPDATE sessions SET issue_number = ? WHERE parent_id = ? AND issue_number IS NULL',
    ).run(issue, id);
  }
  return id;
}

function turnId(session, id) {
  return digest(session, 'turn', opaqueId(id, 'turn ID')).slice(0, 32);
}

function insertTurn(db, session, turn) {
  db.prepare(
    `INSERT INTO turns (session_id, id, started_at, ended_at, status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET
      started_at = COALESCE(turns.started_at, excluded.started_at),
      ended_at = COALESCE(turns.ended_at, excluded.ended_at),
      status = CASE WHEN turns.ended_at IS NULL
        THEN COALESCE(excluded.status, turns.status) ELSE turns.status END`,
  ).run(
    session,
    turnId(session, turn.id),
    timestamp(turn.startedAt, true),
    timestamp(turn.endedAt, true),
    choice(turn.status, 'turn status', statuses, true),
  );
}

function insertUsage(db, session, usage) {
  const stream = digest(
    session,
    'usage-stream',
    opaqueId(usage.counterId, 'usage counter'),
  ).slice(0, 32);
  const aggregate = digest(session, 'usage-stream', 'session').slice(0, 32);
  if (
    db
      .prepare(
        `SELECT 1 FROM usage_streams WHERE session_id = ?
    AND ((id = ? AND ? <> ?) OR (id <> ? AND ? = ?)) LIMIT 1`,
      )
      .get(session, aggregate, stream, aggregate, aggregate, stream, aggregate)
  )
    throw new Error(
      'Cannot combine whole-session totals with partitioned token counters',
    );
  const mode = choice(usage.mode, 'usage mode', ['delta', 'cumulative']);
  const provenance = identifier(usage.provenance, 'usage provenance');
  const model = identifier(usage.model, 'usage model', true);
  const provider = identifier(usage.provider, 'usage provider', true);
  const existing = db
    .prepare('SELECT * FROM usage_streams WHERE session_id = ? AND id = ?')
    .get(session, stream);
  if (
    existing &&
    (existing.mode !== mode ||
      existing.provenance !== provenance ||
      existing.model !== model ||
      existing.provider !== provider)
  ) {
    throw new Error('Conflicting token counter identity');
  }
  if (!existing) {
    db.prepare(
      `INSERT INTO usage_streams (session_id, id, mode, model, provider, provenance)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(session, stream, mode, model, provider, provenance);
  }
  const input = tokenCount(usage.inputTokens, 'input tokens');
  const output = tokenCount(usage.outputTokens, 'output tokens');
  const total = tokenCount(usage.totalTokens ?? input + output, 'total tokens');
  if (total !== input + output) throw new Error('Inconsistent token totals');
  db.prepare(
    `INSERT INTO usage_observations
    (session_id, stream_id, id, at, input_tokens, output_tokens, cached_tokens,
     cache_write_tokens, reasoning_tokens, total_tokens, complete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, stream_id, id) DO UPDATE SET
      complete = MAX(usage_observations.complete, excluded.complete)
    WHERE usage_observations.at = excluded.at
      AND usage_observations.input_tokens = excluded.input_tokens
      AND usage_observations.output_tokens = excluded.output_tokens
      AND usage_observations.cached_tokens IS excluded.cached_tokens
      AND usage_observations.cache_write_tokens IS excluded.cache_write_tokens
      AND usage_observations.reasoning_tokens IS excluded.reasoning_tokens
      AND usage_observations.total_tokens = excluded.total_tokens`,
  ).run(
    session,
    stream,
    digest(session, stream, opaqueId(usage.id, 'usage event ID')),
    timestamp(usage.at),
    input,
    output,
    tokenCount(usage.cachedTokens, 'cached tokens', true),
    tokenCount(usage.cacheWriteTokens, 'cache write tokens', true),
    tokenCount(usage.reasoningTokens, 'reasoning tokens', true),
    total,
    Number(usage.complete === true),
  );
}

function insertAttempt(db, session, attempt) {
  const technology = identifier(attempt.technology, 'technology', true);
  const exit = integer(
    attempt.exitCode,
    'exit status',
    -2_147_483_648,
    4_294_967_295,
    true,
  );
  const signature =
    exit == null || exit === 0
      ? null
      : failureSignature({ ...attempt, technology });
  if (signature) {
    db.prepare(
      `INSERT INTO failures (fingerprint, technology, code, description)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(
      signature.fingerprint,
      technology,
      attempt.code,
      signature.description,
    );
  }
  const operation = opaqueId(attempt.operationId, 'operation ID', true);
  db.prepare(
    `INSERT INTO attempts
    (session_id, id, turn_id, at, category, technology, component,
     operation_id, exit_code, diagnostic, fingerprint, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(
    session,
    digest(session, 'attempt', opaqueId(attempt.id, 'attempt ID')),
    attempt.turnId == null ? null : turnId(session, attempt.turnId),
    timestamp(attempt.at),
    choice(attempt.category, 'attempt category', categories),
    technology,
    identifier(attempt.component, 'component', true),
    operation == null ? null : digest('operation', operation),
    exit,
    Number(attempt.diagnostic === true),
    signature?.fingerprint ?? null,
    identifier(attempt.provenance, 'attempt provenance'),
  );
}

export function recordBatch(
  dbPath = defaultDatabasePath(),
  { session, turns, usage, attempts },
) {
  const turnRows = eventRows(turns);
  const usageRows = eventRows(usage);
  const attemptRows = eventRows(attempts);
  const observedAt = [
    session.startedAt,
    session.endedAt,
    session.observedAt,
    ...turnRows.flatMap((turn) => [turn.startedAt, turn.endedAt]),
    ...usageRows.map((observation) => observation.at),
    ...attemptRows.map((attempt) => attempt.at),
  ]
    .filter((value) => value != null)
    .map((value) => timestamp(value))
    .sort()
    .at(-1);
  if (!observedAt) throw new Error('Missing source timestamp');
  return withDatabase(dbPath, (db) =>
    transaction(db, () => {
      const stableId = sessionId(session.source, session.id);
      if (
        db.prepare('SELECT 1 FROM retired_sessions WHERE id = ?').get(stableId)
      )
        return null;
      const id = insertSession(db, session, observedAt);
      for (const turn of turnRows) insertTurn(db, id, turn);
      for (const observation of usageRows) insertUsage(db, id, observation);
      for (const attempt of attemptRows) insertAttempt(db, id, attempt);
      return id;
    }),
  );
}
