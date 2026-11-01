import { parseArgs } from 'node:util';
import { createRepositoryAdmission } from './host-context.mjs';
import { createHostFixture } from './host-fixtures.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repository: { type: 'string' },
    scope: { type: 'string' },
    digest: { type: 'string' },
    issue: { type: 'string' },
    session: { type: 'string' },
  },
});

try {
  if (
    positionals.length === 1 &&
    positionals[0] === 'qualify' &&
    Object.keys(values).length === 0
  ) {
    const fixture = await createHostFixture();
    const result = await fixture.host.run(fixture.request);
    process.stdout.write(
      `${JSON.stringify({ mode: 'inert', root: fixture.root, result }, null, 2)}\n`,
    );
    if (result.value.status !== 'ready-for-integration-review')
      process.exitCode = 1;
  } else if (
    positionals.length === 1 &&
    positionals[0] === 'admit' &&
    Object.keys(values).sort().join(',') ===
      'digest,issue,repository,scope,session'
  ) {
    const admission = createRepositoryAdmission({
      repositoryRoot: values.repository,
      scopeRecordPath: values.scope,
      scopeRecordDigest: values.digest,
    });
    const snapshot = await admission.inspect({
      issueNumber: Number(values.issue),
      sessionId: values.session,
    });
    process.stdout.write(
      `${JSON.stringify({ mode: 'read-only', contextDigest: snapshot.digest, checkedAt: snapshot.checkedAt, issueNumber: snapshot.facts.issue.number, sourceRevision: snapshot.facts.sourceRevision, policyRevision: snapshot.facts.policyRevision }, null, 2)}\n`,
    );
  } else
    throw new Error(
      'Use qualify, or admit --repository <absolute root> --scope <absolute receipt> --digest <sha256> --issue <number> --session <claim session>. Live execution is unavailable.',
    );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
