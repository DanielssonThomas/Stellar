import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const profiles = Object.freeze([
  { role: 'Architect', id: 'architect-cloud', mode: 'Cloud' },
  { role: 'Architect', id: 'architect', mode: 'Local identity' },
  { role: 'Foreman', id: 'foreman-cloud', mode: 'Cloud' },
  { role: 'Foreman', id: 'foreman', mode: 'Local Qwen' },
  { role: 'Peon', id: 'peon-cloud', mode: 'Cloud, unqualified for coding' },
  { role: 'Peon', id: 'peon', mode: 'Governed local route' },
  { role: 'Mira', id: 'mira', mode: 'Independent' },
  { role: 'Designer', id: 'designer', mode: 'Independent' },
]);

function configuredRoute(config) {
  const block = /^model:\r?\n((?:^  [^\r\n]*\r?\n)*)/m.exec(config)?.[1] ?? '';
  const scalar = (key) => {
    const value = new RegExp(`^  ${key}:\\s*(.+)$`, 'm')
      .exec(block)?.[1]
      ?.trim();
    if (!value) return 'Unknown';
    const unquoted = value.replace(/^(['"])(.*)\1$/, '$2');
    return unquoted.startsWith('__SET_APPROVED_') ? 'Unconfigured' : unquoted;
  };
  return {
    model: scalar('default'),
    provider: scalar('provider'),
  };
}

function timestamp(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function sessionSummary(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        'SELECT COUNT(*) AS count, MAX(last_activity_at) AS last_activity FROM sessions',
      )
      .get();
    const usage = db
      .prepare(
        'SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(api_call_count), 0) AS api_calls FROM session_model_usage',
      )
      .get();
    const recent = db
      .prepare(
        'SELECT last_activity_at, end_reason FROM sessions ORDER BY last_activity_at DESC LIMIT 3',
      )
      .all();
    return {
      sessionCount: Number(row.count),
      sessionState: Number(row.count) > 0 ? 'recorded' : 'none',
      lastActivity: timestamp(row.last_activity),
      usage: {
        inputTokens: Number(usage.input_tokens),
        outputTokens: Number(usage.output_tokens),
        apiCalls: Number(usage.api_calls),
      },
      events: recent.map((event) => ({
        at: timestamp(event.last_activity_at),
        kind: /error|fail|timeout|cancel/i.test(event.end_reason ?? '')
          ? 'failure'
          : 'session',
      })),
    };
  } finally {
    db.close();
  }
}

export async function readHermesStatus(root) {
  const result = [];
  for (const profile of profiles) {
    const base = path.join(root, 'profiles', profile.id);
    try {
      const config = await readFile(path.join(base, 'config.yaml'), 'utf8');
      const route = configuredRoute(config);
      let sessions = {
        sessionCount: 0,
        sessionState: 'unavailable',
        lastActivity: null,
        usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
        events: [],
      };
      try {
        sessions = sessionSummary(path.join(base, 'state.db'));
      } catch {
        // A missing or locked database means session data is unavailable, not active.
      }
      result.push({
        ...profile,
        ...route,
        ...sessions,
        source: 'Hermes local profile',
      });
    } catch {
      result.push({
        ...profile,
        model: 'Unavailable',
        provider: 'Unavailable',
        sessionCount: 0,
        sessionState: 'unavailable',
        lastActivity: null,
        usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
        events: [],
        source: 'Hermes profile unavailable',
      });
    }
  }
  return result;
}

const repository = 'DanielssonThomas/Stellar';
const githubBase = `https://api.github.com/repos/${repository}`;

export async function readGithubStatus(fetcher = fetch, timeoutMs = 4000) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stellar-dashboard',
  };
  const signal = AbortSignal.timeout(timeoutMs);
  const [issuesResponse, pullsResponse] = await Promise.all([
    fetcher(`${githubBase}/issues?state=open&per_page=100`, {
      headers,
      signal,
    }),
    fetcher(`${githubBase}/pulls?state=open&per_page=100`, { headers, signal }),
  ]);
  if (!issuesResponse.ok || !pullsResponse.ok)
    throw new Error('GitHub public status unavailable');
  const issues = (await issuesResponse.json())
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: String(item.title ?? '').slice(0, 160),
      url: `https://github.com/${repository}/issues/${item.number}`,
      status:
        item.labels
          ?.find((label) => label.name?.startsWith('status:'))
          ?.name?.slice(7) ?? 'unknown',
      owner:
        item.labels?.find(
          (label) =>
            label.name?.startsWith('owner:') ||
            label.name?.startsWith('worker:'),
        )?.name ?? 'unassigned',
      blocked:
        item.labels?.some((label) => label.name === 'status:blocked') ?? false,
    }));
  const pulls = (await pullsResponse.json()).map((item) => ({
    number: item.number,
    title: String(item.title ?? '').slice(0, 160),
    url: `https://github.com/${repository}/pull/${item.number}`,
    draft: Boolean(item.draft),
  }));
  return { state: 'live', issues, pulls, source: 'Public GitHub API' };
}

export async function buildSnapshot({
  hermesRoot = process.env.STELLAR_HERMES_ROOT || 'D:\\Hermes',
  fetcher = fetch,
} = {}) {
  const agents = await readHermesStatus(hermesRoot);
  let github;
  try {
    github = await readGithubStatus(fetcher);
  } catch {
    github = {
      state: 'unavailable',
      issues: [],
      pulls: [],
      source: 'Public GitHub API',
    };
  }
  return { observedAt: new Date().toISOString(), agents, github };
}
