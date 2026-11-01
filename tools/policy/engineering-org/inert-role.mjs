const phase = process.argv[2];
const nonce = process.argv[3];
process.once('disconnect', () => process.exit(0));
process.once('message', async (request) => {
  if (request.nonce !== nonce) process.exit(2);
  const { packet, fault } = request;
  if (fault === 'hang') return;
  if (fault === 'oversize') {
    process.stdout.write('x'.repeat(100_000));
    return;
  }
  if (fault === 'provider-failure') {
    process.send({ nonce, error: 'quota' });
    setImmediate(() => process.disconnect());
    return;
  }
  let result;
  if (phase === 'dispatch')
    result = { operation: 'dispatch', issueNumber: packet.issueNumber };
  else if (phase === 'implement')
    result = {
      changes: [
        {
          path: packet.allowedPaths[0],
          content: `export const value = ${fault === 'defect' ? 0 : 2};\n`,
        },
      ],
    };
  else if (phase === 'verify') {
    const module = await import(
      `data:text/javascript,${encodeURIComponent(packet.files[0].content)}`
    );
    result = {
      checks: [
        {
          id: 'fixture-value',
          command: 'inert value export probe',
          status: module.value === 2 ? 'passed' : 'failed',
        },
      ],
    };
  } else if (phase === 'review') {
    if (packet.kind === 'attempt-failure') {
      result = {
        schemaVersion: 1,
        kind: 'attempt-failure',
        issueNumber: packet.issueNumber,
        attemptDigest: packet.attemptDigest,
        decision: 'blocked',
        reason:
          'The bounded attempt did not produce a verified candidate; host intervention is required.',
      };
    } else {
      const context = packet.context;
      const failed = context.verification.some(
        (check) => check.status !== 'passed',
      );
      result = {
        schemaVersion: 2,
        issueNumber: context.expectedIssue,
        baselineRevision: context.expectedRevision,
        headRevision: context.expectedHeadRevision,
        authorId: context.authorId,
        reviewerId: 'foreman',
        decision: failed ? 'corrections-required' : 'passed',
        criteria: context.criteria.map((id) => ({
          id,
          status: failed ? 'not-met' : 'met',
          reason: failed
            ? 'The fixture check failed.'
            : 'The fixture check passed.',
        })),
        verification: context.verification.map(({ id, status }) => ({
          id,
          status,
        })),
        findings: failed
          ? context.criteria.map((criterionId, index) => ({
              id: `check-${index}`,
              kind: 'verification',
              criterionId,
              path: context.changedFiles[0].path,
              side: 'file',
              checkId: context.verification[0].id,
              summary: 'The expected fixture value is missing.',
              impact: 'The acceptance probe fails.',
              suggestion: 'Return the required value and rerun verification.',
            }))
          : [],
      };
    }
  } else if (phase === 'reconcile')
    result = {
      reports: packet.reports.map(({ issueNumber, digest, decision }) => ({
        issueNumber,
        digest,
        decision,
      })),
    };
  else process.exit(3);
  process.send({
    nonce: fault === 'foreign-channel' ? 'foreign' : nonce,
    result,
  });
  setImmediate(() => process.disconnect());
});
