/** Deterministic, model-independent authority rules for the Stellar agent organization. */
export const managerAvailability = Object.freeze([
  'available',
  'temporarily-unavailable',
  'approval-required',
  'recovered',
]);

export function transitionManagerAvailability(current, event) {
  if (!managerAvailability.includes(current))
    throw new Error('Manager availability state is invalid.');
  if (event?.type === 'approval-required') return 'approval-required';
  if (
    event?.type === 'provider-failure' &&
    event.failure?.verified === true &&
    event.failure.kind !== 'unknown'
  )
    return 'temporarily-unavailable';
  if (event?.type === 'provider-failure')
    throw new Error(
      'Unverified provider failures cannot change manager state.',
    );
  if (
    event?.type === 'provider-recovered' &&
    ['temporarily-unavailable', 'approval-required'].includes(current)
  )
    return 'recovered';
  if (event?.type === 'manager-resumed' && current === 'recovered')
    return 'available';
  throw new Error('Manager availability transition is not authorized.');
}

const providerFailureKinds = new Set([
  'quota',
  'timeout',
  'authentication',
  'context-limit',
  'network',
  'unknown',
]);

export function classifyProviderFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const code = String(error?.code ?? '').toLowerCase();
  let kind = 'unknown';
  if (status === 401 || status === 403 || /auth|credential/.test(code))
    kind = 'authentication';
  else if (status === 429 || /quota|rate.?limit|insufficient_quota/.test(code))
    kind = 'quota';
  else if (status === 408 || /timeout|timedout/.test(code)) kind = 'timeout';
  else if (/context.?length|token.?limit/.test(code)) kind = 'context-limit';
  else if (/network|econn|dns|socket/.test(code)) kind = 'network';
  return {
    kind,
    verified: providerFailureKinds.has(kind) && kind !== 'unknown',
  };
}

export function mapPeonInstance(instanceId, configuredInstances = ['Peon-01']) {
  if (
    !Array.isArray(configuredInstances) ||
    !configuredInstances.includes(instanceId)
  )
    throw new Error('Peon instance is not explicitly configured.');
  if (!/^Peon-[0-9]{2,}$/.test(instanceId))
    throw new Error('Invalid Peon instance ID.');
  return Object.freeze({
    instanceId,
    issueOwner: 'worker:peon',
    inferencePool: 'peon-qwen-single-slot',
  });
}

/** Check a proposed command against caller, current host facts, and a fresh issue. */
export function authorizeOperation({ caller, operation, issue, facts = {} }) {
  if (!['architect', 'foreman', 'peon'].includes(caller))
    throw new Error('Unknown caller identity.');
  if (
    ![
      'inspect',
      'plan',
      'dispatch',
      'review',
      'reconcile',
      'request-integration',
    ].includes(operation)
  )
    throw new Error('Operation is not exposed by the trusted interface.');
  if (operation === 'plan' && caller !== 'architect')
    throw new Error('Only Architect may submit strategic plans.');
  if (operation === 'dispatch' && caller !== 'foreman')
    throw new Error('Only Foreman may dispatch Peon work.');
  if (operation === 'review' && caller !== 'foreman')
    throw new Error('Only Foreman may submit a review.');
  if (operation === 'request-integration' && caller !== 'architect')
    throw new Error('Only Architect may approve integration.');
  if (operation === 'reconcile' && caller !== 'foreman')
    throw new Error('Only Foreman may reconcile results.');
  if (caller === 'peon' && operation !== 'inspect')
    throw new Error(
      'Peon cannot assign, review, reconcile, or integrate work.',
    );
  if (
    operation === 'dispatch' &&
    (!issue ||
      issue.state !== 'OPEN' ||
      issue.status !== 'status:ready' ||
      issue.owner !== 'worker:peon')
  )
    throw new Error('Dispatch requires a fresh ready Peon-owned issue.');
  if (
    caller === 'peon' &&
    operation === 'inspect' &&
    (!issue ||
      issue.owner !== 'worker:peon' ||
      !facts.sessionId ||
      facts.sessionId !== facts.claimSessionId)
  )
    throw new Error('Peon may inspect only its current claimed assignment.');
  if (operation === 'review') {
    const identity = /^[a-z][a-z0-9._-]{0,63}$/;
    if (
      !identity.test(facts.authorId ?? '') ||
      !identity.test(facts.reviewerId ?? '') ||
      facts.reviewerId !== caller
    )
      throw new Error(
        'Independent review requires validated author and reviewer identities.',
      );
    if (facts.authorId === facts.reviewerId)
      throw new Error('A worker cannot independently review its own changes.');
  }
  if (
    operation === 'request-integration' &&
    facts.approval !== 'architect-approved'
  )
    throw new Error('Integration requires recorded Architect approval.');
  if (facts.fallbackMergeEnabled === true)
    throw new Error('Fallback integration is disabled in this implementation.');
  return {
    authorized: true,
    caller,
    operation,
    issueNumber: issue?.number ?? null,
  };
}

export function validateReviewReport(
  report,
  { expectedIssue, expectedRevision, authorId },
) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.issueNumber !== expectedIssue ||
    report.baselineRevision !== expectedRevision
  )
    throw new Error('Review report identity or baseline is stale.');
  if (
    report.reviewerId !== 'foreman' ||
    report.authorId !== authorId ||
    report.reviewerId === report.authorId
  )
    throw new Error('Review report does not prove independent Foreman review.');
  if (
    !['passed', 'corrections-required', 'blocked'].includes(report.decision) ||
    !Array.isArray(report.findings)
  )
    throw new Error('Review report schema is invalid.');
  return report;
}
