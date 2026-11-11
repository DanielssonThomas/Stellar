import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findClaim,
  isoAt,
  observationWindowMs,
  sourceFile,
  sourceLabel,
} from './collector-claims.mjs';

const provenance = 'hermes-state';
const profiles = [
  'ivy',
  'architect',
  'architect-cloud',
  'foreman',
  'foreman-cloud',
  'peon',
  'peon-cloud',
  'mira',
];
const cleanId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value)
    ? value
    : undefined;
const sessionId = (profile, id) =>
  id && `${profile}:${createHash('sha256').update(id).digest('hex')}`;
const closes = new Set([
  'agent_close',
  'cli_close',
  'tui_close',
  'acp_close',
  'compression',
]);
const interrupts = new Set([
  'tui_shutdown',
  'ws_disconnect',
  'ws_orphan_reap',
  'idle_timeout',
  'lru_evict',
]);

function readProfile(database, profile, claims, cutoff, now) {
  const columns =
    'id, parent_session_id, cwd, git_branch, git_repo_root, started_at, ended_at, end_reason, model, billing_provider, last_activity_at';
  const clause =
    profile === 'ivy'
      ? ''
      : 'AND git_branch IS NOT NULL AND git_repo_root IS NOT NULL';
  const sessions = database
    .prepare(
      `
    SELECT ${columns} FROM sessions WHERE last_activity_at >= ? ${clause}
    ORDER BY last_activity_at DESC LIMIT ?
  `,
    )
    .all(cutoff, profile === 'ivy' ? 24 : 12);
  const usageRows = database.prepare(`
    SELECT model, billing_provider, max(last_seen) AS at, sum(input_tokens) AS uncached,
      sum(output_tokens) AS output, sum(cache_read_tokens) AS cached,
      sum(cache_write_tokens) AS cache_write, sum(reasoning_tokens) AS reasoning
    FROM session_model_usage WHERE session_id = ? AND api_call_count > 0
    GROUP BY model, billing_provider ORDER BY at DESC LIMIT 16
  `);
  const messages = database.prepare(`
    SELECT id, timestamp FROM messages WHERE session_id = ? AND tool_name IS NOT NULL AND timestamp BETWEEN ? AND ?
    ORDER BY id DESC LIMIT 80
  `);
  return sessions.flatMap((row) => {
    const id = sessionId(profile, cleanId(row.id));
    const startedAt = isoAt(row.started_at * 1000);
    if (!id || !startedAt) return [];
    const claim =
      row.git_branch && row.git_repo_root
        ? findClaim(claims, {
            cwd: row.cwd,
            branch: row.git_branch,
            repoRoot: row.git_repo_root,
            started: row.started_at * 1000,
          })
        : undefined;
    if (!claim && profile !== 'ivy') return [];

    const stop = Math.min(now, claim?.stop ?? now);
    const endedAt =
      row.ended_at * 1000 <= stop ? isoAt(row.ended_at * 1000) : undefined;
    const metadataCurrent = row.last_activity_at * 1000 <= stop;
    const status =
      endedAt &&
      (closes.has(row.end_reason)
        ? 'completed'
        : interrupts.has(row.end_reason)
          ? 'interrupted'
          : undefined);
    const usage = usageRows.all(row.id).flatMap((entry) => {
      const lastObserved = entry.at * 1000;
      if (lastObserved > stop || lastObserved < (claim?.start ?? 0)) return [];
      const at = isoAt(
        Math.max(lastObserved, endedAt ? Date.parse(endedAt) : 0),
      );
      if (
        !at ||
        ![
          entry.uncached,
          entry.output,
          entry.cached,
          entry.cache_write,
          entry.reasoning,
        ].every((value) => Number.isSafeInteger(value) && value >= 0)
      )
        return [];
      const inputTokens = entry.uncached + entry.cached + entry.cache_write;
      const counterId = createHash('sha256')
        .update(JSON.stringify([entry.model, entry.billing_provider]))
        .digest('hex');
      const observationId = createHash('sha256')
        .update(JSON.stringify([counterId, at, entry, Boolean(endedAt)]))
        .digest('hex');
      return [
        {
          id: observationId,
          at,
          mode: 'cumulative',
          counterId,
          model: sourceLabel(entry.model),
          provider: sourceLabel(entry.billing_provider),
          inputTokens,
          cachedTokens: entry.cached,
          cacheWriteTokens: entry.cache_write,
          outputTokens: entry.output,
          reasoningTokens: entry.reasoning,
          totalTokens: inputTokens + entry.output,
          complete: Boolean(endedAt),
          provenance,
        },
      ];
    });
    const attempts = claim
      ? messages
          .all(row.id, Math.max(cutoff, claim.start / 1000), stop / 1000)
          .flatMap((message) => {
            const at = isoAt(message.timestamp * 1000);
            return at && Number.isSafeInteger(message.id)
              ? [
                  {
                    id: String(message.id),
                    at,
                    category: 'tool',
                    provenance,
                  },
                ]
              : [];
          })
      : [];
    return [
      {
        session: {
          id,
          source: 'hermes',
          agent: profile,
          issueNumber: claim?.issue,
          parentId: sessionId(profile, cleanId(row.parent_session_id)),
          model: metadataCurrent ? sourceLabel(row.model) : undefined,
          provider: metadataCurrent
            ? sourceLabel(row.billing_provider)
            : undefined,
          startedAt,
          endedAt,
          status,
        },
        usage,
        attempts,
      },
    ];
  });
}

export function* readHermesBatches({
  home,
  claims,
  now = Date.now(),
  onUnavailable,
}) {
  const cutoff = (now - observationWindowMs) / 1000;
  for (const profile of profiles) {
    if (profile !== 'ivy' && !claims.length) break;
    let database;
    try {
      database = new DatabaseSync(
        sourceFile(home, path.join('profiles', profile, 'state.db')),
        { readOnly: true },
      );
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=25;');
      if (
        database.prepare('SELECT version FROM schema_version LIMIT 1').get()
          ?.version !== 32
      )
        throw new Error('Unsupported Hermes state schema');
      yield* readProfile(database, profile, claims, cutoff, now);
    } catch {
      onUnavailable?.();
    } finally {
      database?.close();
    }
  }
}
