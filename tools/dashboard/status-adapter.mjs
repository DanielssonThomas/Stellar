import { readFile, stat } from 'node:fs/promises';
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
  const pages = async (resource) => {
    const entries = [];
    for (let page = 1; page <= 30; page += 1) {
      const response = await fetcher(
        `${githubBase}/${resource}?state=open&per_page=100&page=${page}`,
        { headers, signal },
      );
      if (!response.ok) throw new Error('GitHub public status unavailable');
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub response');
      entries.push(...batch);
      if (batch.length < 100) return entries;
    }
    throw new Error('GitHub pagination limit reached');
  };
  const [issueEntries, pullEntries, completedResponse] = await Promise.all([
    pages('issues'),
    pages('pulls'),
    fetcher(`${githubBase}/issues?state=closed&per_page=100&page=1`, {
      headers,
      signal,
    }),
  ]);
  if (!completedResponse.ok)
    throw new Error('GitHub public status unavailable');
  const completedEntries = await completedResponse.json();
  const issues = issueEntries
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
      updatedAt: item.updated_at ?? null,
    }));
  const pulls = pullEntries.map((item) => ({
    number: item.number,
    title: String(item.title ?? '').slice(0, 160),
    url: `https://github.com/${repository}/pull/${item.number}`,
    draft: Boolean(item.draft),
    updatedAt: item.updated_at ?? null,
  }));
  const recentCompleted = completedEntries
    .filter(
      (item) =>
        !item.pull_request &&
        item.labels?.some((label) => label.name === 'status:done'),
    )
    .slice(0, 5)
    .map((item) => ({
      number: item.number,
      title: String(item.title ?? '').slice(0, 160),
      url: `https://github.com/${repository}/issues/${item.number}`,
      updatedAt: item.updated_at ?? null,
    }));
  return {
    state: 'live',
    issues,
    pulls,
    recentCompleted,
    source: 'Public GitHub API',
    observedAt: new Date().toISOString(),
    complete: true,
  };
}

const designCharacter = 'stellar-assistant';
const designRootDefault = 'D:\\ai-repositories\\Stellar-Design';

function productionPipeline({
  referenceApproved,
  phase,
  sourceRecorded,
  exportRecorded,
  blenderAllowed,
  blenderSessionRecorded,
}) {
  const phaseOne = phase === 'phase_1_vroid_creation';
  const validatedVroid =
    referenceApproved && sourceRecorded && exportRecorded && blenderAllowed;
  const phaseOneKnown = phaseOne && referenceApproved;
  return {
    reference: referenceApproved ? 'done' : 'unknown',
    bodyFace: validatedVroid ? 'done' : phaseOneKnown ? 'current' : 'unknown',
    vroidValidation: validatedVroid
      ? 'done'
      : phaseOneKnown && (sourceRecorded || exportRecorded)
        ? 'current'
        : phaseOneKnown
          ? 'pending'
          : 'unknown',
    blender: blenderSessionRecorded
      ? 'current'
      : validatedVroid
        ? 'pending'
        : phaseOneKnown
          ? 'pending'
          : 'unknown',
    finalReview:
      phaseOneKnown || validatedVroid || blenderSessionRecorded
        ? 'pending'
        : 'unknown',
  };
}

export async function readCharacterStatus(
  root = process.env.STELLAR_DESIGN_ROOT || designRootDefault,
) {
  const base = path.join(root, 'characters', designCharacter);
  try {
    const [state, progress, contract, file, audit] = await Promise.all([
      readFile(path.join(base, 'phase-state.json'), 'utf8').then(JSON.parse),
      readFile(path.join(base, 'phase1-progress.json'), 'utf8').then(
        JSON.parse,
      ),
      readFile(path.join(base, 'design-contract.yaml'), 'utf8').then(
        JSON.parse,
      ),
      stat(path.join(base, 'phase1-progress.json')),
      readFile(path.join(base, 'designer-session-audit.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    ]);
    if (
      state.character_id !== designCharacter ||
      progress.character_id !== designCharacter ||
      contract.character_id !== designCharacter
    )
      throw new Error('Character identity mismatch');
    if (!Array.isArray(progress.requirements))
      throw new Error('Missing requirement progress');
    const requirements = progress.requirements;
    const outstanding = requirements.filter(
      (item) =>
        item.status !== 'achieved' && item.status !== 'approved_difference',
    );
    const referenceApproved =
      contract.approval?.status === 'approved' &&
      Array.isArray(contract.references) &&
      contract.references.length > 0;
    const sourceRecorded = Boolean(progress.source);
    const exportRecorded = Boolean(progress.export);
    const blenderAllowed = state.phase2_launch_allowed === true;
    const blenderSessionRecorded = Boolean(state.blender_session_id);
    const pipeline = productionPipeline({
      referenceApproved,
      phase: state.phase,
      sourceRecorded,
      exportRecorded,
      blenderAllowed,
      blenderSessionRecorded,
    });
    const nextAction = blenderSessionRecorded
      ? 'Inspect recorded Blender outputs and Phase 2 progress before final review.'
      : blenderAllowed && pipeline.vroidValidation === 'done'
        ? 'Launch the authorized Blender handoff and record the Designer session.'
        : !referenceApproved
          ? 'Confirm the approved design contract and reference before production.'
          : state.phase !== 'phase_1_vroid_creation'
            ? 'Inspect production records to establish the next authorized stage.'
            : outstanding.length > 0
              ? 'Resolve outstanding visual requirements, capture missing views, and obtain user approval before handoff.'
              : !sourceRecorded || !exportRecorded
                ? 'Promote and validate the reviewed VRoid source and export before handoff.'
                : 'Complete VRoid validation and record visual approval before Blender handoff.';
    const image =
      typeof progress.latest_review_comparison === 'string' &&
      progress.latest_review_comparison.startsWith(
        'assets/characters/stellar-assistant-phase1/',
      )
        ? 'latest'
        : null;
    return {
      state: 'observed',
      id: designCharacter,
      assignedAgent: 'Designer',
      activity: 'unknown',
      designerSessionCount: Array.isArray(progress.designer_sessions)
        ? progress.designer_sessions.length
        : null,
      phase: String(state.phase ?? 'unknown'),
      workflow: String(progress.status ?? 'unknown').replaceAll('_', ' '),
      contractApproved: contract.approval?.status === 'approved',
      referenceAvailable:
        Array.isArray(contract.references) && contract.references.length > 0,
      pipeline,
      nextAction,
      vroid: {
        achieved: requirements.filter((item) => item.status === 'achieved')
          .length,
        total: requirements.length,
        sourceRecorded,
        exportRecorded,
      },
      blender: {
        launchAllowed: blenderAllowed,
        sessionRecorded: blenderSessionRecorded,
      },
      handoff: String(state.handoff_status ?? 'unknown').replaceAll('_', ' '),
      blocker:
        state.phase === 'phase_1_vroid_creation' && !blenderAllowed
          ? String(progress.blocker ?? '').slice(0, 380)
          : 'Current blockers beyond Phase 1 are not connected to this dashboard.',
      outstandingCount: outstanding.length,
      outstanding: outstanding.slice(0, 5).map((item) => ({
        id: String(item.id).slice(0, 40),
        status: String(item.status).replaceAll('_', ' ').slice(0, 60),
      })),
      latestImage: image,
      latestImageLabel: image ? 'Exploratory comparison — unapproved' : null,
      validation: state.phase2_launch_allowed
        ? 'Phase 2 launch recorded as allowed'
        : 'Phase 1 visual approval pending',
      technicalValidation:
        audit?.character_id === designCharacter
          ? String(audit.status ?? 'unknown')
              .replaceAll('_', ' ')
              .slice(0, 100)
          : 'No Designer audit recorded',
      lastVerifiedAt: file.mtime.toISOString(),
      source: 'Stellar-Design phase-state, phase1-progress, design-contract',
    };
  } catch {
    return {
      state: 'unavailable',
      id: designCharacter,
      source: 'Stellar-Design phase-state, phase1-progress, design-contract',
      reason: 'Design checkout or required production records unavailable',
    };
  }
}

let githubCache = null;
export async function buildSnapshot({
  hermesRoot = process.env.STELLAR_HERMES_ROOT || 'D:\\Hermes',
  fetcher = fetch,
} = {}) {
  const agents = await readHermesStatus(hermesRoot);
  const characters = [await readCharacterStatus()];
  let github;
  try {
    if (
      fetcher === fetch &&
      githubCache &&
      Date.now() - githubCache.cachedAt < 300_000
    ) {
      github = githubCache.data;
    } else {
      github = await readGithubStatus(fetcher);
      if (fetcher === fetch)
        githubCache = { cachedAt: Date.now(), data: github };
    }
  } catch {
    github = githubCache
      ? { ...githubCache.data, state: 'stale' }
      : {
          state: 'unavailable',
          issues: [],
          pulls: [],
          recentCompleted: [],
          source: 'Public GitHub API',
        };
  }
  return { observedAt: new Date().toISOString(), agents, github, characters };
}
