import path from 'node:path';
import { openHostStore } from './host-store.mjs';
import { verifyInertCandidate } from './host-candidate.mjs';
import { reviewPacket } from './host-review.mjs';
import { validateReviewReport } from './review-report.mjs';
import {
  digest,
  isDigest,
  isRevision,
  requireValue,
} from './planning-evidence.mjs';

const roles = { implement: 'peon', verify: 'verifier', review: 'foreman' };
const detached = (value) => {
  digest(value);
  return JSON.parse(JSON.stringify(value));
};
const lineCount = (content) =>
  content.length ? content.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;

async function readPhase(store, grant, phase, expectedDigest) {
  const prefix = `${grant.id}.${phase}`;
  const result = await store.read(`${prefix}.result`, expectedDigest);
  const reservation = (await store.read(`${prefix}.reservation`)).value;
  const launch = (await store.read(`${prefix}.launch`)).value;
  const receipt = result.value.receipt;
  requireValue(
    result.value.authorityCurrent === true &&
      receipt.schemaVersion === 1 &&
      receipt.mode === 'inert' &&
      receipt.status === 'completed' &&
      receipt.terminated === true &&
      receipt.phase === phase &&
      receipt.role === roles[phase] &&
      receipt.recipeDigest === grant.recipePins[phase] &&
      receipt.nonce === reservation.nonce &&
      receipt.nonce === launch.nonce &&
      receipt.pid === launch.pid &&
      Number.isSafeInteger(receipt.pid) &&
      receipt.pid > 0 &&
      receipt.packetDigest === reservation.subjectDigest &&
      receipt.packetDigest === result.value.subjectDigest &&
      launch.packetDigest === receipt.packetDigest &&
      launch.recipeDigest === receipt.recipeDigest &&
      launch.reservationDigest === digest(reservation) &&
      reservation.grantId === grant.id &&
      reservation.contextDigest === grant.contextDigest &&
      reservation.phase === phase &&
      reservation.role === roles[phase] &&
      reservation.recipeDigest === receipt.recipeDigest &&
      receipt.usage.modelTokens === 0 &&
      receipt.usage.requests === 0,
    'Candidate source session provenance or termination is invalid.',
  );
  return { result, reservation };
}

function validateHandoff(grant, attempt) {
  const handoff = attempt.handoff;
  const usage = handoff?.workerUsage?.peon;
  const limits = grant.facts.limits;
  requireValue(
    attempt.schemaVersion === 1 &&
      attempt.mode === 'inert' &&
      attempt.grantId === grant.id &&
      attempt.status === 'complete' &&
      handoff?.status === 'complete' &&
      handoff.safeToResume === true &&
      handoff.task.issueNumber === grant.request.issueNumber &&
      handoff.task.owner === 'worker:peon' &&
      handoff.task.targetBranch === 'develop' &&
      handoff.currentWorkerId === null &&
      handoff.failures.length === 0 &&
      handoff.transfers.length === 0 &&
      handoff.attempts.length === 1 &&
      handoff.attempts[0].workerId === 'peon' &&
      handoff.attempts[0].status === 'completed' &&
      usage?.attempts === 1 &&
      limits.maxAttemptsPerWorker === 1 &&
      handoff.workerUsage.mira.attempts === 0 &&
      Number.isSafeInteger(usage.runtimeMs) &&
      usage.runtimeMs >= 0 &&
      usage.runtimeMs <= limits.maxRuntimeMsPerWorker &&
      usage.toolCalls === 0 &&
      usage.modelTokens === 0 &&
      usage.forwardedRequests === 0 &&
      attempt.verification.length > 0 &&
      attempt.verification.every((check) => check.status === 'passed'),
    'Candidate source lacks a completed, bounded and safely stopped attempt.',
  );
  return {
    limits: detached(limits),
    workerUsage: detached(handoff.workerUsage),
  };
}

export async function readPrCandidateBridge({
  storeRoot,
  source,
  evidence,
  readFileAtRevision,
}) {
  source = detached(source);
  evidence = detached(evidence);
  requireValue(
    Object.keys(source).sort().join(',') ===
      'attemptDigest,grantDigest,grantId,reviewDigest' &&
      Object.values(source).every(isDigest) &&
      typeof readFileAtRevision === 'function' &&
      Number.isSafeInteger(evidence.issueNumber) &&
      evidence.issueNumber > 0 &&
      isRevision(evidence.headSha) &&
      isRevision(evidence.baseSha),
    'Pinned candidate source and exact PR revisions are required.',
  );
  const store = await openHostStore(storeRoot);
  const grant = (
    await store.read(`${source.grantId}.grant`, source.grantDigest)
  ).value;
  const attempt = await store.read(
    `${source.grantId}.attempt.result`,
    source.attemptDigest,
  );
  const prior = await store.read(
    `${source.grantId}.review`,
    source.reviewDigest,
  );
  requireValue(
    grant.schemaVersion === 1 &&
      grant.mode === 'inert' &&
      grant.id === source.grantId &&
      grant.request.issueNumber === evidence.issueNumber &&
      grant.facts.issue.number === evidence.issueNumber &&
      typeof grant.facts.issue.title === 'string' &&
      typeof grant.facts.issue.body === 'string' &&
      digest(grant.facts) === grant.contextDigest &&
      grant.facts.repository === 'DanielssonThomas/Stellar' &&
      grant.facts.sourceRevision === evidence.baseSha &&
      prior.value.mode === 'inert' &&
      prior.value.issueNumber === evidence.issueNumber &&
      prior.value.grantId === grant.id &&
      prior.value.attemptDigest === attempt.digest &&
      prior.value.decision === 'passed',
    'Candidate source belongs to another issue, base, grant or review.',
  );
  const resources = validateHandoff(grant, attempt.value);
  const candidate = attempt.value.candidate;
  requireValue(
    candidate?.mode === 'inert' &&
      candidate.issueNumber === evidence.issueNumber &&
      candidate.sessionId === grant.request.sessionId &&
      candidate.sourceRevision === evidence.baseSha &&
      isRevision(candidate.gitCommit),
    'Candidate snapshot identity does not match its source.',
  );
  await store.read(`${grant.id}.candidate`, digest(candidate));
  const candidateRoot = path.join(store.root, `${grant.id}.candidate-tree`);
  await verifyInertCandidate(candidateRoot, candidate);
  const packet = reviewPacket(grant, attempt);
  requireValue(
    prior.value.packetDigest === digest(packet),
    'Prior review does not bind the source candidate.',
  );
  validateReviewReport(prior.value.report, packet.context);
  const phases = {};
  for (const phase of Object.keys(roles))
    phases[phase] = await readPhase(
      store,
      grant,
      phase,
      phase === 'review' ? prior.value.sessionDigest : undefined,
    );
  requireValue(
    digest(phases.review.result.value.receipt.result) ===
      digest(prior.value.report) &&
      phases.review.result.value.subjectDigest === digest(packet) &&
      phases.implement.result.value.subjectDigest ===
        digest({
          issueNumber: evidence.issueNumber,
          sourceRevision: evidence.baseSha,
          allowedPaths: grant.facts.scope.allowedPaths,
          criteria: grant.facts.scope.criteria,
        }) &&
      digest(phases.implement.result.value.receipt.result.changes) ===
        digest(
          candidate.files.map(({ path, content }) => ({ path, content })),
        ) &&
      phases.verify.result.value.subjectDigest ===
        digest({
          candidateDigest: candidate.contentDigest,
          gitCommit: candidate.gitCommit,
          files: candidate.files,
        }) &&
      digest(phases.verify.result.value.receipt.result.checks) ===
        digest(attempt.value.verification),
    'Stored review or verification differs from its host session.',
  );
  const operationNonce = phases.implement.reservation.operationNonce;
  requireValue(
    typeof operationNonce === 'string' &&
      /^[a-f0-9-]{36}$/.test(operationNonce) &&
      phases.verify.reservation.operationNonce === operationNonce,
    'Source phases do not share one attempt lease.',
  );
  const cleanup = await store.read(
    `${grant.id}.attempt-${operationNonce}.cleanup`,
  );
  const expectedSessions = ['implement', 'verify'].map((phase) => ({
    phase,
    nonce: phases[phase].result.value.receipt.nonce,
    pid: phases[phase].result.value.receipt.pid,
    resultDigest: phases[phase].result.digest,
  }));
  requireValue(
    isDigest(cleanup.value.slotDigest) &&
      digest(cleanup.value.sessions) === digest(expectedSessions),
    'Source attempt cleanup is missing or does not bind both stopped phases.',
  );
  requireValue(
    Array.isArray(evidence.changedFiles) &&
      evidence.changedFiles.length === candidate.files.length &&
      evidence.changedFiles.every(
        (file) =>
          typeof file.filename === 'string' &&
          ['added', 'modified'].includes(file.status) &&
          file.previousFilename === undefined &&
          file.previous_filename === undefined,
      ) &&
      new Set(evidence.changedFiles.map((file) => file.filename.toLowerCase()))
        .size === evidence.changedFiles.length,
    'PR change evidence is incomplete, duplicated or unsupported.',
  );
  const changedFiles = [];
  const files = [];
  for (const file of candidate.files) {
    const changed = evidence.changedFiles.find(
      (entry) => entry.filename === file.path,
    );
    requireValue(
      changed?.status === file.status,
      'PR changed-file set differs from the source candidate.',
    );
    const content = await readFileAtRevision(file.path, evidence.headSha);
    const baseline =
      file.status === 'added'
        ? ''
        : await readFileAtRevision(file.path, evidence.baseSha);
    requireValue(
      typeof content === 'string' &&
        typeof baseline === 'string' &&
        Buffer.byteLength(content) <= 32_768 &&
        Buffer.byteLength(baseline) <= 65_536 &&
        content === file.content &&
        lineCount(baseline) === file.baseLineCount,
      'Actual PR bytes or baseline differ from the verified source candidate.',
    );
    files.push({ path: file.path, content });
    changedFiles.push({
      path: file.path,
      status: file.status,
      baseLineCount: lineCount(baseline),
      headLineCount: lineCount(content),
    });
  }
  await verifyInertCandidate(candidateRoot, candidate);
  await store.read(`${grant.id}.grant`, source.grantDigest);
  await store.read(`${grant.id}.attempt.result`, source.attemptDigest);
  await store.read(`${grant.id}.review`, source.reviewDigest);
  return detached({
    mode: 'inert',
    candidateSnapshotSha: candidate.gitCommit,
    sourceRevision: evidence.baseSha,
    headRevision: evidence.headSha,
    source,
    sourceIssue: {
      number: grant.facts.issue.number,
      title: grant.facts.issue.title,
      body: grant.facts.issue.body,
    },
    reviewContext: {
      ...packet.context,
      expectedRevision: evidence.baseSha,
      expectedHeadRevision: evidence.headSha,
      changedFiles,
    },
    files,
    resources: {
      ...resources,
      operationNonce,
      cleanupDigest: cleanup.digest,
      receiptPins: Object.fromEntries(
        Object.entries(phases).map(([phase, value]) => [
          phase,
          value.result.digest,
        ]),
      ),
    },
    priorReview: {
      decision: prior.value.decision,
      reviewerId: prior.value.report.reviewerId,
      headRevision: prior.value.report.headRevision,
    },
  });
}
