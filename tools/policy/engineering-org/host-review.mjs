import { validateReviewReport } from './review-report.mjs';
import { digest, requireValue } from './planning-evidence.mjs';

export function reviewPacket(grant, attempt) {
  const candidate = attempt.value.candidate;
  if (!candidate || !attempt.value.verification.length)
    return {
      kind: 'attempt-failure',
      issueNumber: grant.request.issueNumber,
      attemptDigest: attempt.digest,
      status: attempt.value.status,
      failure: attempt.value.failure ?? 'No verified candidate was produced.',
    };
  return {
    kind: 'candidate',
    attemptDigest: attempt.digest,
    candidateDigest: digest(candidate),
    context: {
      expectedIssue: grant.request.issueNumber,
      expectedRevision: candidate.sourceRevision,
      expectedHeadRevision: candidate.gitCommit,
      authorId: 'peon',
      criteria: grant.facts.scope.criteria.map(({ id }) => id),
      changedFiles: candidate.files.map(
        ({ path, status, baseLineCount, headLineCount }) => ({
          path,
          status,
          baseLineCount,
          headLineCount,
        }),
      ),
      verification: attempt.value.verification,
    },
    files: candidate.files,
  };
}

export function acceptReview(packet, session) {
  const receipt = session.value.receipt;
  if (receipt.status !== 'completed')
    return {
      decision: 'blocked',
      kind: 'review-session-failed',
      failure: receipt.failure,
    };
  const report = receipt.result;
  if (packet.kind === 'candidate')
    return validateReviewReport(report, packet.context);
  requireValue(
    report?.schemaVersion === 1 &&
      report.kind === 'attempt-failure' &&
      report.issueNumber === packet.issueNumber &&
      report.attemptDigest === packet.attemptDigest &&
      report.decision === 'blocked' &&
      typeof report.reason === 'string' &&
      report.reason.trim().length > 0 &&
      report.reason.length <= 1024,
    'Failure review does not match the immutable attempt.',
  );
  return report;
}

export function acceptVerification(session) {
  const receipt = session.value.receipt;
  if (receipt.status !== 'completed') return [];
  const checks = receipt.result?.checks;
  requireValue(
    Array.isArray(checks) &&
      checks.length > 0 &&
      checks.length <= 16 &&
      new Set(checks.map((check) => check.id)).size === checks.length &&
      checks.every(
        (check) =>
          typeof check.id === 'string' &&
          /^[a-z0-9-]{1,80}$/.test(check.id) &&
          typeof check.command === 'string' &&
          check.command.length > 0 &&
          check.command.length <= 256 &&
          ['passed', 'failed', 'not-run', 'blocked'].includes(check.status),
      ),
    'Verifier returned invalid bounded checks.',
  );
  return checks;
}
