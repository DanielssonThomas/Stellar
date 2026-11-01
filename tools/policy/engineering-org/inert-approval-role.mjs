const phase = process.argv[2];
const nonce = process.argv[3];
process.once('disconnect', () => process.exit(0));
process.once('message', (request) => {
  if (request.nonce !== nonce) process.exit(2);
  if (request.fault === 'provider-failure') {
    process.send({ nonce, error: 'quota' });
    setImmediate(() => process.disconnect());
    return;
  }
  const packet = request.packet;
  let result;
  if (phase === 'pr-review') {
    const context = packet.context;
    const passed =
      packet.files.every(
        (file) => file.content === 'export const value = 2;\n',
      ) && context.verification.every((check) => check.status === 'passed');
    result = {
      schemaVersion: 2,
      issueNumber: context.expectedIssue,
      baselineRevision: context.expectedRevision,
      headRevision: context.expectedHeadRevision,
      authorId: context.authorId,
      reviewerId: 'foreman',
      decision: passed ? 'passed' : 'corrections-required',
      criteria: context.criteria.map((id) => ({
        id,
        status: passed ? 'met' : 'not-met',
        reason: passed
          ? 'The exact PR fixture contents satisfy the bounded value criterion.'
          : 'The PR fixture contents fail the bounded value criterion.',
      })),
      verification: context.verification.map(({ id, status }) => ({
        id,
        status,
      })),
      findings: passed
        ? []
        : context.criteria.map((criterionId, index) => ({
            id: `value-${index}`,
            kind: 'defect',
            criterionId,
            path: context.changedFiles[0].path,
            side: 'file',
            summary: 'The exact PR fixture does not export the required value.',
            impact: 'The bounded acceptance criterion is unmet.',
            suggestion: 'Correct the export and obtain fresh evidence.',
          })),
    };
  } else if (phase === 'architect-approval') {
    result = {
      schemaVersion: 1,
      issueNumber: packet.issueNumber,
      pullNumber: packet.pullNumber,
      headSha: packet.headSha,
      policyDigest: packet.policyDigest,
      evidenceDigest: packet.evidenceDigest,
      decision:
        packet.review.decision === 'passed' && packet.risks.length === 0
          ? 'approve'
          : 'deny',
      reason:
        'The bounded inert readiness decision follows the independent PR review and host evidence.',
    };
  } else process.exit(3);
  process.send({ nonce, result });
  setImmediate(() => process.disconnect());
});
