const allowedDecisions = new Set(['forwarded']);
const maxHandoffBytes = 12 * 1024;
const maxSummaryBytes = 2 * 1024;
const maxExcerptBytes = 1024;
const verifiedImplementations = new WeakSet();

function fail(message, safeToResume = true) {
  const error = new Error(message);
  error.safeToResume = safeToResume;
  return error;
}

export function assertAuthorizedTwoStageIssue(issue) {
  const labels = Array.isArray(issue?.labels)
    ? issue.labels.map((item) => (typeof item === 'string' ? item : item?.name))
    : [];
  const required = [
    'worker:peon',
    'priority:low',
    'target:develop',
    'hermes-profile:narrow-coding',
    'hermes-workflow:two-stage',
    'status:in-progress',
  ];
  if (
    !Number.isSafeInteger(issue?.number) ||
    issue.number < 1 ||
    issue.state !== 'OPEN' ||
    required.some(
      (label) => labels.filter((item) => item === label).length !== 1,
    ) ||
    labels.some(
      (label) =>
        [
          'owner:',
          'worker:',
          'priority:',
          'target:',
          'hermes-profile:',
          'hermes-workflow:',
          'status:',
        ].some((prefix) => label?.startsWith(prefix)) &&
        !required.includes(label),
    ) ||
    !Array.isArray(issue.dependencies) ||
    issue.dependencies.some(
      (dependency) =>
        dependency?.state !== 'CLOSED' || dependency?.status !== 'status:done',
    )
  )
    throw fail(
      'Fresh issue metadata does not authorize the two-stage workflow.',
    );
  return issue;
}

function validUsage(usage, stage, expectedRequests) {
  if (
    !usage ||
    usage.stage !== stage ||
    usage.forwardedRequests !== expectedRequests ||
    usage.inflightRequests !== 0 ||
    usage.exceededResource !== null ||
    !Number.isSafeInteger(usage.modelTokens) ||
    usage.modelTokens < 0 ||
    !Number.isSafeInteger(usage.toolCalls) ||
    usage.toolCalls < 0 ||
    usage.modelTokens > 32_000 ||
    usage.toolCalls > 64 ||
    !Array.isArray(usage.requestRecords) ||
    usage.requestRecords.length !== expectedRequests ||
    usage.requestRecords.some(
      (record, index) =>
        record?.request !== index + 1 ||
        record.stage !== (index === 0 ? 'inspect' : 'implement') ||
        !allowedDecisions.has(record.decision),
    )
  )
    throw fail(`Trusted ${stage} usage evidence is incomplete or invalid.`);
}

function parseHandoff(
  raw,
  { issueNumber, guidanceDigest, allowedEvidencePaths },
) {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > maxHandoffBytes
  )
    throw fail('Inspection handoff exceeds its trusted size limit.');
  let handoff;
  try {
    handoff = JSON.parse(raw);
  } catch {
    throw fail('Inspection handoff is not valid JSON.');
  }
  const expectedKeys = [
    'version',
    'issueNumber',
    'guidanceDigest',
    'summary',
    'sourceEvidence',
  ];
  if (
    !handoff ||
    Object.keys(handoff).sort().join(',') !== expectedKeys.sort().join(',') ||
    handoff.version !== 1 ||
    handoff.issueNumber !== issueNumber ||
    handoff.guidanceDigest !== guidanceDigest ||
    !/^[a-f0-9]{64}$/.test(guidanceDigest ?? '') ||
    typeof handoff.summary !== 'string' ||
    Buffer.byteLength(handoff.summary, 'utf8') > maxSummaryBytes ||
    !Array.isArray(handoff.sourceEvidence) ||
    handoff.sourceEvidence.length < 1 ||
    handoff.sourceEvidence.length > 6
  )
    throw fail('Inspection handoff does not match the trusted issue context.');
  if (!Array.isArray(allowedEvidencePaths))
    throw fail('Trusted source evidence paths are unavailable.');
  const allowed = new Set(allowedEvidencePaths);
  for (const evidence of handoff.sourceEvidence) {
    if (
      !evidence ||
      Object.keys(evidence).sort().join(',') !== 'excerpt,path' ||
      typeof evidence.path !== 'string' ||
      !allowed.has(evidence.path) ||
      typeof evidence.excerpt !== 'string' ||
      Buffer.byteLength(evidence.excerpt, 'utf8') > maxExcerptBytes
    )
      throw fail('Inspection handoff contains unauthorized source evidence.');
  }
  return handoff;
}

export function validateInspectionStage({
  issue,
  issueNumber,
  exitCode,
  workerCleanup,
  snapshotCleanup,
  meterIdentityBefore,
  meterIdentityAfter,
  usage,
  initialWorkspaceFingerprint,
  finalWorkspaceFingerprint,
  workspaceAccess,
  githubCredentialAvailable,
  workspaceContainsGitMetadata,
  handoff,
  guidanceDigest,
  allowedEvidencePaths,
  verifyExcerpt,
}) {
  assertAuthorizedTwoStageIssue(issue);
  if (issue.number !== issueNumber)
    throw fail('Inspection issue differs from authoritative issue metadata.');
  if (exitCode !== 0)
    throw fail('Inspection worker did not exit successfully.');
  if (
    workspaceAccess !== 'read-only' ||
    githubCredentialAvailable !== false ||
    workspaceContainsGitMetadata !== false
  )
    throw fail('Inspection workspace or credential boundary is not enforced.');
  if (!workerCleanup?.confirmed)
    throw fail('Inspection worker termination is unconfirmed.', false);
  if (!snapshotCleanup?.confirmed)
    throw fail('Inspection snapshot cleanup is unconfirmed.', false);
  if (
    !meterIdentityBefore?.id ||
    meterIdentityBefore.id !== meterIdentityAfter?.id ||
    meterIdentityBefore.startedAt !== meterIdentityAfter.startedAt ||
    meterIdentityBefore.restartCount !== meterIdentityAfter.restartCount
  )
    throw fail(
      'Attempt metering sidecar identity or lifecycle changed.',
      false,
    );
  if (
    typeof initialWorkspaceFingerprint !== 'string' ||
    initialWorkspaceFingerprint !== finalWorkspaceFingerprint
  )
    throw fail('Read-only inspection changed the assigned workspace.', false);
  validUsage(usage, 'inspect', 1);
  if (typeof verifyExcerpt !== 'function')
    throw fail('Trusted source excerpt verification is unavailable.');
  const parsed = parseHandoff(handoff, {
    issueNumber,
    guidanceDigest,
    allowedEvidencePaths,
  });
  if (
    parsed.sourceEvidence.some(
      ({ path, excerpt }) => !verifyExcerpt(path, excerpt),
    )
  )
    throw fail(
      'Inspection handoff source evidence did not match trusted files.',
    );
  return Object.freeze({
    issueNumber,
    guidanceDigest,
    handoff: parsed,
    meterIdentity: meterIdentityAfter,
    usage,
    workspaceFingerprint: finalWorkspaceFingerprint,
  });
}

export async function authorizeImplementationStage({
  inspection,
  readMeterIdentity,
  readUsage,
  advanceMeter,
  isCancelled = () => false,
}) {
  if (!inspection || typeof inspection !== 'object')
    throw fail('No validated inspection result is available.');
  if (
    typeof readMeterIdentity !== 'function' ||
    typeof readUsage !== 'function' ||
    typeof advanceMeter !== 'function'
  )
    throw fail('Trusted stage-transition operations are unavailable.');
  if (isCancelled())
    throw fail(
      'Attempt was cancelled before the implementation transition.',
      false,
    );
  const before = await readMeterIdentity();
  if (
    before?.id !== inspection.meterIdentity.id ||
    before.startedAt !== inspection.meterIdentity.startedAt ||
    before.restartCount !== inspection.meterIdentity.restartCount
  )
    throw fail('Attempt metering sidecar was replaced or restarted.', false);
  const current = await readUsage();
  if (
    current?.stage !== 'inspect' ||
    current.forwardedRequests !== 1 ||
    current.inflightRequests !== 0 ||
    current.exceededResource !== null ||
    current.modelTokens !== inspection.usage.modelTokens ||
    current.toolCalls !== inspection.usage.toolCalls ||
    JSON.stringify(current.requestRecords) !==
      JSON.stringify(inspection.usage.requestRecords)
  )
    throw fail('Attempt accounting changed before the stage transition.');
  const transition = await advanceMeter();
  if (transition?.stage !== 'implement')
    throw fail('Meter did not confirm the trusted implementation transition.');
  if (isCancelled())
    throw fail(
      'Attempt was cancelled during the implementation transition.',
      false,
    );
  const after = await readMeterIdentity();
  const transitionedUsage = await readUsage();
  if (
    after?.id !== before.id ||
    after.startedAt !== before.startedAt ||
    after.restartCount !== before.restartCount ||
    transitionedUsage?.stage !== 'implement' ||
    transitionedUsage.forwardedRequests !== 1 ||
    transitionedUsage.inflightRequests !== 0 ||
    transitionedUsage.modelTokens !== current.modelTokens ||
    transitionedUsage.toolCalls !== current.toolCalls ||
    JSON.stringify(transitionedUsage.requestRecords) !==
      JSON.stringify(current.requestRecords)
  )
    throw fail(
      'Meter continuity was not confirmed after stage transition.',
      false,
    );
  return Object.freeze({
    stage: 'implement',
    issueNumber: inspection.issueNumber,
    handoff: inspection.handoff,
    meterIdentity: after,
    usage: transitionedUsage,
  });
}

export function validateImplementationStage({
  transition,
  exitCode,
  workerCleanup,
  meterIdentity,
  usage,
  changedPaths,
}) {
  if (!transition || transition.stage !== 'implement')
    throw fail(
      'Implementation stage was not authorized by trusted transition.',
    );
  if (exitCode !== 0)
    throw fail('Implementation worker did not exit successfully.');
  if (!workerCleanup?.confirmed)
    throw fail('Implementation worker termination is unconfirmed.', false);
  if (
    meterIdentity?.id !== transition.meterIdentity.id ||
    meterIdentity?.startedAt !== transition.meterIdentity.startedAt ||
    meterIdentity?.restartCount !== transition.meterIdentity.restartCount
  )
    throw fail(
      'Attempt metering sidecar identity changed during implementation.',
      false,
    );
  validUsage(usage, 'implement', 2);
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some((entry) => typeof entry !== 'string' || !entry)
  )
    throw fail('No trusted source-change evidence is available.');
  const result = Object.freeze({
    issueNumber: transition.issueNumber,
    changedPaths: [...new Set(changedPaths)],
    usage,
    workerCleanup,
    meterIdentity,
  });
  verifiedImplementations.add(result);
  return result;
}

export function assertStageVerificationAllowed(implementation) {
  if (
    !implementation ||
    !verifiedImplementations.has(implementation) ||
    implementation.workerCleanup?.confirmed !== true
  )
    throw fail(
      'Trusted verification requires a completed implementation stage and confirmed worker cleanup.',
    );
  return true;
}
