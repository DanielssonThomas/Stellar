import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findClaim,
  isoAt,
  maxSessions,
  observationWindowMs,
  pathKey,
  readBounded,
  sourceFile,
  sourceLabel,
} from './collector-claims.mjs';
import { diagnoseOutput } from './diagnostics.mjs';

const source = 'codex-thread-history';
const rolloutSource = 'codex-rollout';
const rolloutBytes = 512 * 1024;
const commandBytes = 64 * 1024;
const maxCommandPayloads = 16;

const threadColumns =
  'id, cwd, git_branch, git_origin_url, created_at_ms, updated_at_ms, model, model_provider, reasoning_effort, rollout_path, history_mode, source';
const identity = /^[a-zA-Z0-9._:/-]{1,128}$/;
const projectedTools = [
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
];

const statuses = new Map([
  ['inProgress', 'active'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['interrupted', 'interrupted'],
]);

const safeIdentity = (value) =>
  typeof value === 'string' && identity.test(value) ? value : undefined;

function usageAt(record, threadId, start, stop) {
  if (
    record?.type !== 'token_usage_record' ||
    record.payload?.thread_id !== threadId ||
    !Number.isSafeInteger(record.ordinal) ||
    record.ordinal < 0
  )
    return undefined;
  const observed = Date.parse(record.timestamp);
  if (observed < start || observed > stop) return undefined;
  const at = isoAt(observed);
  const usage = record.payload.thread_token_usage;
  if (
    !at ||
    !usage ||
    ![usage.input_tokens, usage.output_tokens, usage.total_tokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return undefined;
  return {
    id: `rollout:${record.ordinal}:${at}`,
    at,
    mode: 'cumulative',
    counterId: 'session',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
    totalTokens: usage.total_tokens,
    complete: false,
    provenance: rolloutSource,
  };
}

function readUsage(home, thread, start, stop) {
  if (
    thread.history_mode !== 'paginated' ||
    typeof thread.rollout_path !== 'string'
  )
    return [];
  const relative = path.relative(home, thread.rollout_path);
  if (
    !/^(?:archived_sessions|sessions)[\\/]/.test(relative) ||
    !path.basename(relative).endsWith(`-${thread.id}.jsonl`)
  )
    return [];
  try {
    const file = sourceFile(home, relative);
    const lines = readBounded(file, rolloutBytes).split('\n');
    for (const line of lines.reverse()) {
      if (
        !/^\{"timestamp":"[^"]{20,35}","ordinal":\d+,"type":"token_usage_record","payload":/.test(
          line,
        )
      )
        continue;
      try {
        const usage = usageAt(JSON.parse(line), thread.id, start, stop);
        if (usage) return [usage];
      } catch {
        // Ignore a partial final line while Codex is appending.
      }
    }
  } catch {
    // A missing, inaccessible, or rotated rollout leaves usage unavailable.
  }
  return [];
}

export function classifyCommand(command, cwd) {
  if (
    typeof command !== 'string' ||
    command.length > 2048 ||
    /[\r\n;&|]/.test(command)
  )
    return {};
  const invocation = command.trim();
  // An explicit trailing shell comment is accepted only on a simple unquoted command.
  const marked = /^([^"'\x60#]+) # stellar:diagnostic$/.exec(invocation);
  const text = marked?.[1].trim() ?? invocation;
  if (/[^ ]#| \S*#/.test(text)) return {};
  const directory = pathKey(cwd);
  const match =
    /^(?:pnpm (?:exec )?|npm exec -- |npx )?(cargo|rustc|nx|vitest|playwright|tsc)\b(?:\s+([\w:-]+))?/.exec(
      text,
    );
  const executable = match?.[1];
  const verb = match?.[2];
  let category;
  let technology;
  if (executable === 'cargo' || executable === 'rustc') {
    technology = 'rust';
    if (executable === 'rustc' || ['build', 'run'].includes(verb))
      category = 'build';
    else if (['test', 'nextest'].includes(verb)) category = 'test';
    else if (verb === 'clippy') category = 'lint';
    else if (['check', 'fmt'].includes(verb)) category = 'check';
  } else if (executable === 'nx') {
    technology = 'nx';
    const target =
      /(?:\s--targets?=?\s*|\s-t=?\s*|\s[\w-]+:)(test|build|lint|check|e2e|typecheck)\b/.exec(
        text,
      )?.[1] ?? verb;
    if (target === 'e2e') category = 'test';
    else if (target === 'typecheck') category = 'check';
    else if (['test', 'build', 'lint', 'check'].includes(target))
      category = target;
  } else if (executable === 'vitest' || executable === 'playwright') {
    technology = executable;
    if (executable === 'vitest' || verb === 'test') category = 'test';
  } else if (executable === 'tsc') {
    technology = 'typescript';
    category = 'check';
  }
  return {
    category,
    technology,
    operationId:
      category && directory
        ? createHash('sha256')
            .update(JSON.stringify([directory, text]))
            .digest('hex')
        : undefined,
    diagnostic: Boolean(marked),
  };
}

function commandAttempt(item) {
  if (!item.item_json) return {};
  try {
    const payload = JSON.parse(item.item_json);
    if (
      payload?.type !== 'commandExecution' ||
      !['completed', 'failed', 'declined'].includes(payload.status)
    )
      return {};
    const command =
      payload.commandActions?.length === 1
        ? payload.commandActions[0]?.command
        : null;
    const classified = classifyCommand(command, payload.cwd);
    const exitCode = Number.isSafeInteger(payload.exitCode)
      ? payload.exitCode
      : undefined;
    return {
      ...classified,
      exitCode,
      ...diagnoseOutput(payload.aggregatedOutput, { ...classified, exitCode }),
    };
  } catch {
    return {};
  }
}

function selectedThreads(state, claims, cutoff) {
  const cwdExpression = "replace(cwd, char(92), '/')";
  const windowsPath = `lower(${cwdExpression})`;
  const cwd =
    process.platform === 'win32'
      ? `(CASE
    WHEN substr(${windowsPath}, 1, 8) = '//?/unc/' THEN '//' || substr(${windowsPath}, 9)
    WHEN substr(${windowsPath}, 1, 4) = '//?/' THEN substr(${windowsPath}, 5)
    ELSE ${windowsPath} END)`
      : cwdExpression;
  const recent = state
    .prepare(
      `
    SELECT ${threadColumns} FROM threads
    WHERE updated_at_ms >= ? AND EXISTS (
      SELECT 1 FROM json_each(?) worktree WHERE ${cwd} = worktree.value
      OR instr(${cwd}, worktree.value || '/') = 1
    ) ORDER BY updated_at_ms DESC LIMIT ?
  `,
    )
    .all(
      cutoff,
      JSON.stringify(claims.map(({ worktreePath }) => worktreePath)),
      maxSessions,
    );
  const selected = new Map();
  for (const thread of recent) {
    if (!thread.git_branch || !thread.git_origin_url) continue;
    const claim = findClaim(claims, {
      cwd: thread.cwd,
      branch: thread.git_branch,
      origin: thread.git_origin_url,
      started: thread.created_at_ms,
    });
    if (claim && safeIdentity(thread.id))
      selected.set(thread.id, { thread, claim });
  }
  const children = state.prepare(
    'SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ? LIMIT ?',
  );
  const parentOf = state.prepare(
    'SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ? LIMIT 2',
  );
  const byId = state.prepare(
    `SELECT ${threadColumns} FROM threads WHERE id = ? AND updated_at_ms >= ?`,
  );
  for (const { thread, claim } of selected.values()) {
    if (selected.size >= maxSessions) break;
    for (const { child_thread_id: childId } of children.all(
      thread.id,
      maxSessions - selected.size,
    )) {
      if (selected.has(childId) || !safeIdentity(childId)) continue;
      const parents = parentOf.all(childId);
      if (parents.length !== 1 || parents[0].parent_thread_id !== thread.id)
        continue;
      const child = byId.get(childId, cutoff);
      if (
        !child ||
        child.created_at_ms < claim.start ||
        child.created_at_ms > claim.stop
      )
        continue;
      selected.set(childId, { thread: child, claim, parentId: thread.id });
    }
  }
  // Independently matched children may already be in the set when traversing spawn edges.
  for (const { thread, claim, parentId: priorParent } of selected.values()) {
    if (priorParent) continue;
    const parents = parentOf.all(thread.id);
    const parentId = parents.length === 1 ? parents[0].parent_thread_id : null;
    const parent = selected.get(parentId);
    if (parent?.claim.issue === claim.issue && parentId !== thread.id)
      selected.get(thread.id).parentId = parentId;
  }
  return selected.values();
}

function readHistory(history, threadId, cutoff, start, stop, claimOpen) {
  const turns = history
    .prepare(
      `
    SELECT turn_id, status, started_at, completed_at FROM thread_turns
    WHERE thread_id = ? AND coalesce(completed_at, started_at) >= ?
      AND started_at BETWEEN ? AND ?
    ORDER BY started_at DESC LIMIT 80
  `,
    )
    .all(threadId, cutoff / 1000, Math.floor(start / 1000), stop / 1000)
    .filter((turn) => safeIdentity(turn.turn_id))
    .map((turn) => {
      const ended =
        turn.completed_at != null && turn.completed_at * 1000 <= stop;
      const live =
        turn.completed_at == null && turn.status === 'inProgress' && claimOpen;
      return {
        id: turn.turn_id,
        startedAt: isoAt(turn.started_at * 1000),
        endedAt: ended ? isoAt(turn.completed_at * 1000) : undefined,
        status: ended || live ? statuses.get(turn.status) : undefined,
      };
    });
  const turnIds = new Set(turns.map(({ id }) => id));
  const attempts = history
    .prepare(
      `
    WITH recent AS (
      SELECT turn_id, item_id, item_type, created_at_ms, completed_at_ms
      FROM thread_items
      WHERE thread_id = ? AND created_at_ms >= ?
        AND coalesce(completed_at_ms, created_at_ms) BETWEEN ? AND ?
        AND item_type IN (SELECT value FROM json_each(?))
      ORDER BY created_at_ms DESC LIMIT 160
    ), commands AS (
      SELECT turn_id, item_id,
        CASE WHEN length(CAST(item_json AS BLOB)) <= ? THEN item_json END AS item_json
      FROM thread_items
      WHERE thread_id = ? AND item_type = 'commandExecution'
        AND created_at_ms >= ? AND completed_at_ms BETWEEN ? AND ?
      ORDER BY completed_at_ms DESC LIMIT ?
    )
    SELECT recent.*, commands.item_json FROM recent
    LEFT JOIN commands USING (turn_id, item_id)
  `,
    )
    .all(
      threadId,
      start,
      cutoff,
      stop,
      JSON.stringify(projectedTools),
      commandBytes,
      threadId,
      start,
      cutoff,
      stop,
      maxCommandPayloads,
    )
    .filter((item) => safeIdentity(item.item_id) && turnIds.has(item.turn_id))
    .flatMap((item) => {
      const at = isoAt(item.completed_at_ms ?? item.created_at_ms);
      if (
        !at ||
        (item.item_type === 'commandExecution' && !item.completed_at_ms)
      )
        return [];
      const itemKey = JSON.stringify([item.turn_id, item.item_id]);
      const details = commandAttempt(item);
      return [
        {
          ...details,
          id: createHash('sha256').update(itemKey).digest('hex'),
          at,
          turnId: item.turn_id,
          category: details.category ?? 'tool',
          provenance: source,
        },
      ];
    });
  return { turns, attempts };
}

export function* readCodexBatches({ home, claims, now = Date.now() }) {
  if (!claims.length) return;
  const state = new DatabaseSync(sourceFile(home, 'state_5.sqlite'), {
    readOnly: true,
  });
  let history;
  try {
    state.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=25;');
    history = new DatabaseSync(sourceFile(home, 'thread_history_1.sqlite'), {
      readOnly: true,
    });
    history.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=25;');
    const cutoff = now - observationWindowMs;
    for (const { thread, claim, parentId } of selectedThreads(
      state,
      claims,
      cutoff,
    )) {
      const stop = Math.min(now, claim.stop);
      const { turns, attempts } = readHistory(
        history,
        thread.id,
        cutoff,
        claim.start,
        stop,
        now < claim.stop,
      );
      const metadataCurrent = thread.updated_at_ms <= stop;
      yield {
        session: {
          id: thread.id,
          source: 'codex',
          agent: parentId
            ? 'codex-subagent'
            : thread.source === '{"subagent":"review"}'
              ? 'codex-review'
              : 'codex',
          parentId,
          issueNumber: claim.issue,
          model: metadataCurrent ? sourceLabel(thread.model) : undefined,
          provider: metadataCurrent
            ? sourceLabel(thread.model_provider)
            : undefined,
          reasoning: metadataCurrent
            ? sourceLabel(thread.reasoning_effort)
            : undefined,
          startedAt: isoAt(thread.created_at_ms),
        },
        turns,
        attempts,
        usage: readUsage(home, thread, claim.start, stop),
      };
    }
  } finally {
    history?.close();
    state.close();
  }
}
