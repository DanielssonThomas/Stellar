import { validateIssue } from '../validate-issue.mjs';
import { dependenciesFromBody } from '../issue-worktree.mjs';
import { effectiveTier } from '../ai-review.mjs';
import {
  assessCapability,
  assessSearch,
  digest,
  isText,
  requireValue,
  unique,
  validateSnapshot,
} from './planning-evidence.mjs';

function hasContext(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+Context\s*$/.test(line));
  if (start < 0) return false;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return (
    rest
      .slice(0, end < 0 ? undefined : end)
      .join('\n')
      .trim().length > 0
  );
}

function taskContract(task, scope, snapshot) {
  const issue = task.issue;
  requireValue(
    issue &&
      isText(issue.title) &&
      typeof issue.body === 'string' &&
      Array.isArray(issue.labels) &&
      issue.labels.every(isText),
    'Planning task requires an issue contract.',
  );
  const status = issue.labels.filter((label) => label.startsWith('status:'));
  requireValue(
    status.length === 1 &&
      (issue.number !== undefined || status[0] === 'status:triage'),
    'New planning proposals must remain in triage.',
  );
  requireValue(
    scope.contractDigest === digest(issue),
    'Trusted scope assessment does not match the issue contract.',
  );
  requireValue(
    issue.number !== undefined || !issue.labels.includes('priority:critical'),
    'Planning cannot assign critical priority to a new issue.',
  );
  const validation = validateIssue(
    {
      ...issue,
      number: undefined,
      labels: issue.labels.map((label) =>
        label === 'status:triage' ? 'status:ready' : label,
      ),
    },
    { authorizedWorkers: snapshot.authorizedWorkers },
  );
  requireValue(validation.valid, validation.errors.join('\n'));
  requireValue(hasContext(issue.body), 'Issue context is required.');
  const target = issue.labels
    .find((label) => label.startsWith('target:'))
    .slice(7);
  requireValue(
    snapshot.targetBranches.includes(target),
    'Target branch is not authorized.',
  );
  if (issue.number !== undefined) {
    requireValue(
      Number.isSafeInteger(issue.number) && issue.number > 0,
      'Existing issue identity is invalid.',
    );
    const current = snapshot.issues.find(
      (item) => item.number === issue.number,
    );
    requireValue(
      current &&
        current.state === 'OPEN' &&
        current.contractDigest === digest(issue),
      'Existing issue contract is absent, closed or changed.',
    );
  }
  requireValue(
    ['small', 'medium', 'large', 'unknown'].includes(scope.complexity) &&
      typeof scope.ambiguous === 'boolean' &&
      ['light', 'standard', 'critical'].includes(scope.riskFloor),
    'Trusted task risk and complexity are required.',
  );
  const dependencies = unique(
    dependenciesFromBody(issue.body),
    'Issue dependencies',
  );
  requireValue(
    dependencies.every((number) => Number.isSafeInteger(number) && number > 0),
    'Dependency identities are invalid.',
  );
  requireValue(
    !dependencies.includes(issue.number),
    'An issue cannot depend on itself.',
  );
  if (issue.number !== undefined) {
    const native = snapshot.issues.find(
      (item) => item.number === issue.number,
    ).dependencies;
    requireValue(
      Array.isArray(native) &&
        digest([...native].sort()) === digest([...dependencies].sort()),
      'Issue body and native dependencies disagree.',
    );
  }
  requireValue(
    dependencies.every((number) =>
      snapshot.issues.some((item) => item.number === number),
    ),
    'Dependency evidence is incomplete.',
  );
  const fileTier = effectiveTier(issue, scope.files, {
    expectedCount: scope.files.length,
  });
  const rank = { light: 0, standard: 1, critical: 2 };
  const tier =
    rank[fileTier] >= rank[scope.riskFloor] ? fileTier : scope.riskFloor;
  requireValue(
    issue.labels.includes(`review:${tier}`),
    'Requested review tier is below trusted scope risk.',
  );
  return { dependencies, tier };
}

function taskRecommendation(task, scope, snapshot) {
  const { dependencies, tier } = taskContract(task, scope, snapshot);
  const duplicates = assessSearch(scope, snapshot).filter(
    (number) => number !== task.issue.number,
  );
  const capability = assessCapability(scope, snapshot);
  const owner = task.issue.labels.find((label) =>
    /^(owner|worker):/.test(label),
  );
  const unresolved = dependencies.filter((number) => {
    const issue = snapshot.issues.find((item) => item.number === number);
    return issue.state !== 'CLOSED' || issue.status !== 'status:done';
  });
  let action = 'prepare';
  let role = 'peon';
  let reason = 'verified-capability';
  if (duplicates.length) {
    action = 'reuse';
    role = 'architect';
    reason = 'duplicate-outcome';
  } else if (
    task.issue.number !== undefined &&
    !task.issue.labels.some((label) =>
      ['status:triage', 'status:ready'].includes(label),
    )
  ) {
    action = 'escalate';
    role = 'architect';
    reason = 'existing-work-needs-reconciliation';
  } else if (task.issue.labels.includes('type:epic')) {
    action = 'escalate';
    role = 'architect';
    reason = 'strategic-planning-required';
  } else if (scope.ambiguous || scope.complexity === 'unknown') {
    action = 'escalate';
    role = 'architect';
    reason = 'ambiguous-scope';
  } else if (tier === 'critical' || scope.complexity !== 'small') {
    action = 'escalate';
    role = 'foreman';
    reason = 'sensitive-or-complex';
  } else if (!capability.eligible) {
    action = 'escalate';
    role = 'foreman';
    reason = 'insufficient-capability-evidence';
  } else if (owner !== 'worker:peon') {
    action = 'escalate';
    role = 'architect';
    reason = 'ownership-review-required';
  } else if (unresolved.length || task.after.length) {
    action = 'queue';
    reason = 'unresolved-dependencies';
  }
  requireValue(
    task.assignment?.role === role && isText(task.assignment?.rationale),
    'Assignment must match the evidence-based role and include rationale.',
  );
  return {
    key: task.key,
    milestone: task.milestone,
    contractDigest: digest(task.issue),
    action,
    role,
    reason,
    tier,
    owner,
    dependencies,
    after: [...task.after],
    unresolved,
    duplicates,
    capability,
    rationale: task.assignment.rationale,
  };
}

function orderedTasks(tasks) {
  const remaining = [...tasks];
  const ordered = [];
  while (remaining.length) {
    const index = remaining.findIndex((task) =>
      task.after.every((key) => ordered.some((item) => item.key === key)),
    );
    requireValue(index >= 0, 'Planned task dependencies contain a cycle.');
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered;
}

export function planEngineeringWork(packet, snapshot, { now }) {
  const packetDigest = digest(packet);
  const snapshotDigest = validateSnapshot(snapshot, now);
  requireValue(
    packet?.schemaVersion === 1 &&
      packet.snapshotDigest === snapshotDigest &&
      isText(packet.repository) &&
      packet.repository === snapshot.repository &&
      packet.revision === snapshot.revision &&
      packet.policyRevision === snapshot.policyRevision &&
      isText(packet.planId),
    'Planning packet is stale or belongs to another repository/policy revision.',
  );
  requireValue(
    Array.isArray(packet.tasks) &&
      packet.tasks.length > 0 &&
      packet.tasks.length <= 64 &&
      Number.isSafeInteger(packet.epicNumber) &&
      packet.epicNumber > 0 &&
      snapshot.issues.some(
        (issue) =>
          issue.number === packet.epicNumber &&
          issue.state === 'OPEN' &&
          issue.type === 'type:epic',
      ),
    'A bounded task set and existing open epic are required.',
  );
  unique(
    packet.tasks.map((task) => task.key),
    'Task keys',
  );
  unique(
    packet.tasks.map((task) => digest(task.issue)),
    'Task contracts',
  );
  unique(
    packet.tasks
      .filter((task) => task.issue.number !== undefined)
      .map((task) => task.issue.number),
    'Existing task issue identities',
  );
  for (const task of packet.tasks) {
    requireValue(
      isText(task.key) &&
        /^[a-z][a-z0-9-]{0,63}$/.test(task.key) &&
        isText(task.milestone),
      'Task identity and milestone are required.',
    );
    unique(task.after, 'Planned dependencies');
    requireValue(
      task.after.every((key) => packet.tasks.some((item) => item.key === key)),
      'Planned dependency does not name a task.',
    );
  }
  const recommendations = orderedTasks(packet.tasks).map((task) => {
    const scope = snapshot.scopes.find((item) => item.key === task.key);
    requireValue(scope, 'Trusted scope evidence is missing.');
    return taskRecommendation(task, scope, snapshot);
  });
  return {
    schemaVersion: 1,
    planId: packet.planId,
    repository: snapshot.repository,
    revision: snapshot.revision,
    policyRevision: snapshot.policyRevision,
    snapshotDigest,
    packetDigest,
    epicNumber: packet.epicNumber,
    evaluatedAt: now,
    executionAuthorized: false,
    recommendations,
  };
}
