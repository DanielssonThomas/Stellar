import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectCodexAgents } from './codex-telemetry.mjs';

const profiles = Object.freeze([
  ['architect', 'Architect', 'stellar'],
  ['architect-cloud', 'Architect Cloud', 'stellar'],
  ['foreman', 'Foreman', 'stellar'],
  ['foreman-cloud', 'Foreman Cloud', 'stellar'],
  ['peon', 'Peon', 'stellar'],
  ['peon-cloud', 'Peon Cloud', 'stellar'],
  ['mira', 'Mira', 'stellar'],
  ['designer', 'Designer', 'stellar-design'],
  ['art-director', 'Art Director', 'stellar-design'],
]);
const allowedTools = new Map([
  ['terminal', 'Terminal'],
  ['file_read', 'Reading files'],
  ['file_write', 'Editing files'],
  ['file_edit', 'Editing files'],
  ['browser', 'Browser'],
  ['web_search', 'Web search'],
  ['blender', 'Blender'],
  ['stellar-vroid', 'VRoid'],
]);

function iso(seconds) {
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function opaque(value) {
  return value
    ? createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
    : null;
}

function safeTool(name) {
  if (typeof name !== 'string') return null;
  const key = name.toLowerCase();
  for (const [prefix, label] of allowedTools)
    if (
      key === prefix ||
      key.startsWith(`${prefix}.`) ||
      key.startsWith(`${prefix}_`)
    )
      return label;
  return 'Tool invocation';
}

export function normalizeProfile(
  profile,
  rows,
  { now = Date.now(), processIdentity = () => null } = {},
) {
  const [id, name, project] = profile;
  const nowSeconds = now / 1000;
  const lease = rows.leases.find(
    (row) =>
      Number.isFinite(row.expires_at) &&
      row.expires_at > nowSeconds &&
      verifiedLeaseHolder(row, processIdentity),
  );
  const session = lease
    ? rows.sessions.find((row) => row.id === lease.conversation_id)
    : rows.sessions[0];
  const live = Boolean(lease && session && !session.ended_at);
  const recentEnd = session?.ended_at && nowSeconds - session.ended_at < 90;
  const failed = /error|fail|timeout/i.test(session?.end_reason ?? '');
  const state = live
    ? 'running'
    : recentEnd
      ? failed
        ? 'failed'
        : 'completed'
      : 'unknown';
  const sessionId = opaque(session?.id);
  const events = rows.messages
    .filter(
      (row) => row.session_id === session?.id && Number.isFinite(row.timestamp),
    )
    .slice(0, 40)
    .map((row) => {
      const tool = safeTool(row.tool_name);
      if (!tool) return null;
      return {
        id: opaque(`${id}:${row.id}`),
        at: iso(row.timestamp),
        kind: 'tool',
        label: tool,
      };
    })
    .filter(Boolean)
    .reverse();
  const currentEvent = live
    ? events
        .filter((event) => Date.parse(event.at) >= lease.acquired_at * 1000)
        .at(-1)
    : null;
  if (recentEnd)
    events.push({
      id: opaque(`${id}:${session.id}:end`),
      at: iso(session.ended_at),
      kind: failed ? 'failure' : 'completion',
      label: failed ? 'Session ended with an error' : 'Session ended',
    });
  return {
    id,
    name,
    project,
    state,
    sessionId,
    task: null,
    activity: live ? (currentEvent?.label ?? 'Processing a turn') : null,
    tool: currentEvent?.kind === 'tool' ? currentEvent.label : null,
    model:
      typeof session?.model === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(session.model) &&
      !session.model.includes('..')
        ? session.model
        : null,
    provider:
      typeof session?.billing_provider === 'string' &&
      /^[a-zA-Z0-9._-]{1,50}$/.test(session.billing_provider)
        ? session.billing_provider
        : null,
    usage: session
      ? {
          inputTokens: Math.max(0, Number(session.input_tokens) || 0),
          outputTokens: Math.max(0, Number(session.output_tokens) || 0),
        }
      : null,
    startedAt: live ? iso(session.started_at) : null,
    lastObservedAt: iso(session?.last_activity_at),
    source: {
      kind: 'hermes-turn-lease',
      health: 'available',
      observedAt: new Date(now).toISOString(),
    },
    events,
  };
}

export function readProfileDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const leases = db
      .prepare(
        'SELECT conversation_id, holder, acquired_at, expires_at FROM session_turn_leases WHERE expires_at > unixepoch() ORDER BY acquired_at DESC LIMIT 20',
      )
      .all();
    const columns =
      'id, parent_session_id, started_at, ended_at, end_reason, last_activity_at, model, billing_provider, input_tokens, output_tokens';
    const sessions = db
      .prepare(
        `SELECT ${columns} FROM sessions ORDER BY last_activity_at DESC LIMIT 40`,
      )
      .all();
    const messages = db
      .prepare(
        'SELECT id, session_id, timestamp, tool_name FROM messages WHERE tool_name IS NOT NULL ORDER BY id DESC LIMIT 80',
      )
      .all();
    const sessionById = db.prepare(
      `SELECT ${columns} FROM sessions WHERE id = ?`,
    );
    const toolsBySession = db.prepare(
      'SELECT id, session_id, timestamp, tool_name FROM messages WHERE session_id = ? AND tool_name IS NOT NULL ORDER BY id DESC LIMIT 40',
    );
    for (const lease of leases) {
      if (!sessions.some((session) => session.id === lease.conversation_id)) {
        const session = sessionById.get(lease.conversation_id);
        if (session) sessions.push(session);
      }
      messages.push(...toolsBySession.all(lease.conversation_id));
    }
    const uniqueMessages = new Map();
    for (const message of messages) {
      uniqueMessages.set(`${message.session_id}:${message.id}`, message);
    }
    return {
      leases,
      sessions,
      messages: [...uniqueMessages.values()].sort(
        (a, b) => b.timestamp - a.timestamp,
      ),
    };
  } finally {
    db.close();
  }
}

export function collectSnapshot({
  root = process.env.STELLAR_HERMES_ROOT || 'D:\\Hermes',
  now = Date.now(),
  processIdentity = defaultProcessIdentity,
  readDatabase = readProfileDatabase,
  collectCodex = collectCodexAgents,
} = {}) {
  const agents = profiles.map((profile) => {
    try {
      const rows = readDatabase(
        path.join(root, 'profiles', profile[0], 'state.db'),
      );
      return normalizeProfile(profile, rows, { now, processIdentity });
    } catch {
      return {
        id: profile[0],
        name: profile[1],
        project: profile[2],
        state: 'disconnected',
        sessionId: null,
        task: null,
        activity: null,
        tool: null,
        model: null,
        provider: null,
        usage: null,
        startedAt: null,
        lastObservedAt: null,
        source: {
          kind: 'hermes-turn-lease',
          health: 'unavailable',
          observedAt: new Date(now).toISOString(),
        },
        events: [],
      };
    }
  });
  agents.push(...collectCodex({ now }));
  return { schemaVersion: 1, observedAt: new Date(now).toISOString(), agents };
}

function verifiedLeaseHolder(lease, processIdentity) {
  const holder = lease.holder ?? '';
  const pidMatch = /(?:^|:)pid=(\d+)(?::|$)/.exec(holder);
  if (!pidMatch || !Number.isFinite(lease.acquired_at)) return false;
  const pid = Number(pidMatch[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  let identity;
  try {
    identity = processIdentity(pid);
  } catch {
    return false;
  }
  if (
    !identity ||
    !Number.isFinite(identity.startedAt) ||
    identity.startedAt <= 0 ||
    identity.startedAt > lease.acquired_at * 1000
  )
    return false;
  const recordedNamespace = /(?:^|:)pidns=(\d+)(?::|$)/.exec(holder)?.[1];
  if (identity.namespaceSupported === true)
    return Boolean(
      recordedNamespace &&
        identity.pidNamespace &&
        recordedNamespace === identity.pidNamespace,
    );
  return identity.namespaceSupported === false && !recordedNamespace;
}

function defaultProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const started = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 1000, maxBuffer: 1024 },
      );
      const startedAt = Date.parse(started.trim());
      return Number.isFinite(startedAt)
        ? { startedAt, namespaceSupported: false }
        : null;
    }
    if (process.platform === 'linux') {
      const localNamespace = readlinkSync('/proc/self/ns/pid');
      const holderNamespace = readlinkSync(`/proc/${pid}/ns/pid`);
      if (localNamespace !== holderNamespace) return null;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/);
      if (['Z', 'X'].includes(fields[0])) return null;
      const ticks = Number(fields[19]);
      const ticksPerSecond = Number(
        execFileSync('getconf', ['CLK_TCK'], {
          encoding: 'utf8',
          timeout: 1000,
        }).trim(),
      );
      const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      if (
        !Number.isFinite(ticks) ||
        !Number.isFinite(ticksPerSecond) ||
        ticksPerSecond <= 0 ||
        !Number.isFinite(uptime)
      )
        return null;
      const startedAt =
        Date.now() - uptime * 1000 + (ticks / ticksPerSecond) * 1000;
      return {
        startedAt,
        namespaceSupported: true,
        pidNamespace: /\[(\d+)\]/.exec(holderNamespace)?.[1] ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
