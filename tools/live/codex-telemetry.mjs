import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const labels = new Map([
  ['commandExecution', 'Running a command'],
  ['fileChange', 'Editing files'],
  ['mcpToolCall', 'Using a connected tool'],
  ['imageView', 'Inspecting an image'],
  ['webSearch', 'Searching the web'],
  ['subAgentActivity', 'Coordinating agents'],
  ['collabAgentToolCall', 'Coordinating agents'],
  ['imageGeneration', 'Generating an image'],
  ['agentMessage', 'Posted an update'],
]);
const recentMs = 5 * 60_000;
const visibleMs = 30 * 60_000;
const digest = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
const stamp = (value) =>
  Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;

export function projectForCwd(cwd) {
  if (typeof cwd !== 'string') return null;
  const folder = cwd
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase();
  if (
    folder === 'stellar-design' ||
    folder?.startsWith('stellar-design-issue-')
  )
    return 'stellar-design';
  if (folder === 'stellar' || folder?.startsWith('stellar-issue-'))
    return 'stellar';
  return null;
}

export function readCodexHistory(root = path.join(os.homedir(), '.codex')) {
  const state = new DatabaseSync(path.join(root, 'state_5.sqlite'), {
    readOnly: true,
  });
  let history;
  try {
    history = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'), {
      readOnly: true,
    });
    const threads = state
      .prepare(
        'SELECT id, cwd FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT 80',
      )
      .all();
    const turn = history.prepare(
      'SELECT turn_id, status, started_at, completed_at FROM thread_turns WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1',
    );
    const items = history.prepare(
      'SELECT item_id, item_type, created_at_ms FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY created_at_ms DESC LIMIT 25',
    );
    return threads
      .filter((thread) => projectForCwd(thread.cwd))
      .map((thread) => {
        const latest = turn.get(thread.id);
        return latest
          ? {
              id: thread.id,
              cwd: thread.cwd,
              ...latest,
              items: items.all(thread.id, latest.turn_id),
            }
          : null;
      })
      .filter(Boolean);
  } finally {
    history?.close();
    state.close();
  }
}

export function normalizeCodexThreads(rows, now = Date.now()) {
  return rows
    .map((row) => {
      const project = projectForCwd(row.cwd);
      if (!project || !row.id) return null;
      const lastItemAt = Math.max(
        0,
        ...row.items.map((item) => Number(item.created_at_ms) || 0),
      );
      const lastAt = Math.max(
        lastItemAt,
        (Number(row.completed_at) || 0) * 1000,
      );
      if (now - lastAt > visibleMs || lastAt > now + 60_000) return null;
      const fresh = now - lastAt <= recentMs;
      const state =
        row.status === 'inProgress' && fresh
          ? 'running'
          : row.status === 'completed' && fresh
            ? 'completed'
            : row.status === 'failed' && fresh
              ? 'failed'
              : 'unknown';
      const events = row.items
        .filter(
          (item) =>
            labels.has(item.item_type) && Number.isFinite(item.created_at_ms),
        )
        .sort((a, b) => b.created_at_ms - a.created_at_ms)
        .slice(0, 12)
        .map((item) => ({
          id: digest(`${row.id}:${item.item_id}`),
          at: stamp(item.created_at_ms),
          kind: 'tool',
          label: labels.get(item.item_type),
        }))
        .reverse();
      if (['completed', 'failed'].includes(state))
        events.push({
          id: digest(`${row.id}:${row.turn_id}:end`),
          at: stamp(Number(row.completed_at) * 1000),
          kind: state === 'failed' ? 'failure' : 'completion',
          label: state === 'failed' ? 'Turn failed' : 'Turn completed',
        });
      const recentEvent = events.at(-1);
      const activity =
        state === 'running'
          ? recentEvent?.at && now - Date.parse(recentEvent.at) <= recentMs
            ? recentEvent.label
            : 'Codex turn in progress'
          : null;
      const id = `codex-${digest(row.id)}`;
      return {
        id,
        name: `Codex ${digest(row.id).slice(0, 4).toUpperCase()}`,
        project,
        state,
        sessionId: digest(row.id),
        task: null,
        activity,
        tool: null,
        model: null,
        provider: 'Codex',
        usage: null,
        startedAt:
          state === 'running' ? stamp(Number(row.started_at) * 1000) : null,
        lastObservedAt: stamp(lastAt),
        source: {
          kind: 'codex-local-turn-history',
          health: 'available',
          observedAt: stamp(now),
        },
        events,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt))
    .slice(0, 8);
}

export function collectCodexAgents({
  root,
  now = Date.now(),
  readHistory = readCodexHistory,
} = {}) {
  try {
    return normalizeCodexThreads(readHistory(root), now);
  } catch {
    return [
      {
        id: 'codex-source',
        name: 'Codex sessions',
        project: 'stellar',
        state: 'disconnected',
        sessionId: null,
        task: null,
        activity: null,
        tool: null,
        model: null,
        provider: 'Codex',
        usage: null,
        startedAt: null,
        lastObservedAt: null,
        source: {
          kind: 'codex-local-turn-history',
          health: 'unavailable',
          observedAt: stamp(now),
        },
        events: [],
      },
    ];
  }
}
