const revision = /^[a-f0-9]{40}$/;
const identity = /^[a-z][a-z0-9._-]{0,63}$/;
const statuses = ['passed', 'failed', 'not-run', 'blocked'];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function record(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function list(value) {
  return (
    Array.isArray(value) &&
    [...value.keys()].every((index) => Object.hasOwn(value, index))
  );
}

function unique(values) {
  return new Set(values).size === values.length;
}

function repositoryPath(value) {
  return (
    text(value) &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

export function validateReviewReport(report, context) {
  requireValue(
    context &&
      Number.isSafeInteger(context.expectedIssue) &&
      context.expectedIssue > 0 &&
      text(context.expectedRevision) &&
      revision.test(context.expectedRevision) &&
      text(context.expectedHeadRevision) &&
      revision.test(context.expectedHeadRevision) &&
      text(context.authorId) &&
      identity.test(context.authorId) &&
      list(context.criteria) &&
      context.criteria.length > 0 &&
      context.criteria.every(text) &&
      unique(context.criteria) &&
      list(context.changedFiles) &&
      context.changedFiles.length > 0 &&
      context.changedFiles.every(
        (file) =>
          repositoryPath(file?.path) &&
          Number.isSafeInteger(file.lineCount) &&
          file.lineCount > 0,
      ) &&
      unique(context.changedFiles.map((file) => file.path)) &&
      list(context.verification) &&
      context.verification.length > 0 &&
      context.verification.every(
        (check) =>
          text(check?.id) &&
          text(check.command) &&
          statuses.includes(check.status),
      ) &&
      unique(context.verification.map((check) => check.id)),
    'Trusted review context is incomplete or invalid.',
  );
  requireValue(
    record(report, [
      'schemaVersion',
      'issueNumber',
      'baselineRevision',
      'headRevision',
      'authorId',
      'reviewerId',
      'decision',
      'findings',
      'criteria',
      'verification',
    ]) &&
      report.schemaVersion === 2 &&
      report.issueNumber === context.expectedIssue &&
      report.baselineRevision === context.expectedRevision &&
      report.headRevision === context.expectedHeadRevision,
    'Review report schema, issue or revision is invalid or stale.',
  );
  requireValue(
    report.reviewerId === 'foreman' &&
      report.authorId === context.authorId &&
      report.authorId !== report.reviewerId,
    'Review report does not prove independent Foreman review.',
  );
  requireValue(
    list(report.criteria) &&
      report.criteria.length === context.criteria.length &&
      report.criteria.every(
        (criterion) =>
          record(criterion, ['id', 'status', 'reason']) &&
          context.criteria.includes(criterion.id) &&
          ['met', 'not-met', 'unverified'].includes(criterion.status) &&
          text(criterion.reason),
      ) &&
      unique(report.criteria.map((criterion) => criterion.id)),
    'Review must assess every acceptance criterion exactly once.',
  );
  requireValue(
    list(report.verification) &&
      report.verification.length === context.verification.length &&
      report.verification.every(
        (claim) =>
          record(claim, ['id', 'status']) &&
          context.verification.some(
            (check) => check.id === claim.id && check.status === claim.status,
          ),
      ) &&
      unique(report.verification.map((claim) => claim.id)),
    'Review verification claims do not match trusted results.',
  );
  requireValue(
    list(report.findings) &&
      report.findings.every((finding) => {
        if (
          !record(finding, [
            'id',
            'kind',
            'criterionId',
            'path',
            'line',
            'summary',
            'impact',
            'suggestion',
            'checkId',
          ])
        )
          return false;
        const file = context.changedFiles.find(
          (entry) => entry.path === finding.path,
        );
        return (
          text(finding.id) &&
          [
            'defect',
            'regression',
            'missing-criterion',
            'verification',
          ].includes(finding.kind) &&
          context.criteria.includes(finding.criterionId) &&
          file &&
          Number.isSafeInteger(finding.line) &&
          finding.line > 0 &&
          finding.line <= file.lineCount &&
          [finding.summary, finding.impact, finding.suggestion].every(text) &&
          (finding.kind === 'verification'
            ? context.verification.some(
                (check) =>
                  check.id === finding.checkId && check.status !== 'passed',
              )
            : finding.checkId === undefined &&
              report.criteria.some(
                (criterion) =>
                  criterion.id === finding.criterionId &&
                  criterion.status === 'not-met',
              ))
        );
      }) &&
      unique(report.findings.map((finding) => finding.id)),
    'Review findings require valid locations, criteria, impact and correction.',
  );
  requireValue(
    report.criteria.every(
      (criterion) =>
        criterion.status !== 'not-met' ||
        report.findings.some((finding) => finding.criterionId === criterion.id),
    ) &&
      context.verification.every(
        (check) =>
          check.status === 'passed' ||
          report.findings.some(
            (finding) =>
              finding.kind === 'verification' && finding.checkId === check.id,
          ),
      ),
    'Unmet criteria and incomplete verification require actionable findings.',
  );
  const corrections =
    report.findings.some((finding) => finding.kind !== 'verification') ||
    report.criteria.some((criterion) => criterion.status === 'not-met') ||
    context.verification.some((check) => check.status === 'failed');
  const blocked =
    report.findings.length > 0 ||
    report.criteria.some((criterion) => criterion.status === 'unverified') ||
    context.verification.some((check) => check.status !== 'passed');
  requireValue(
    report.decision ===
      (corrections ? 'corrections-required' : blocked ? 'blocked' : 'passed'),
    'Review decision contradicts its findings, criteria or verification.',
  );
  return report;
}
