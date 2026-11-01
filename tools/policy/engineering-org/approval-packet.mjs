import { digest, requireValue } from './planning-evidence.mjs';

export function architectPacket(facts, review) {
  const { snapshot, bridge } = facts;
  const packet = {
    schemaVersion: 1,
    mode: 'inert',
    repository: snapshot.repository,
    issueNumber: snapshot.issue.number,
    pullNumber: snapshot.pull.number,
    headSha: snapshot.pull.head.sha,
    targetSha: snapshot.target.sha,
    policyDigest: facts.policyDigest,
    evidenceDigest: facts.evidenceDigest,
    changedFiles: snapshot.files,
    commits: snapshot.commits,
    checks: snapshot.checks,
    review,
    risks: [
      ...review.findings.map(({ id, summary }) => ({ id, summary })),
      ...snapshot.checks
        .filter(
          (check) =>
            check.status !== 'completed' || check.conclusion !== 'success',
        )
        .map((check) => ({
          id: `ci-${check.id}`,
          summary: `Check ${check.name} has not completed successfully.`,
        })),
    ],
    resources: bridge.resources,
    candidateSnapshotSha: bridge.candidateSnapshotSha,
  };
  digest(packet);
  return packet;
}

export function acceptArchitectDecision(result, packet) {
  requireValue(
    result?.schemaVersion === 1 &&
      result.issueNumber === packet.issueNumber &&
      result.pullNumber === packet.pullNumber &&
      result.headSha === packet.headSha &&
      result.policyDigest === packet.policyDigest &&
      result.evidenceDigest === packet.evidenceDigest &&
      ['approve', 'deny'].includes(result.decision) &&
      typeof result.reason === 'string' &&
      result.reason.trim().length > 0 &&
      result.reason.length <= 1024,
    'Architect decision does not bind the current integration packet.',
  );
  requireValue(
    result.decision !== 'approve' ||
      (packet.review.decision === 'passed' && packet.risks.length === 0),
    'Architect cannot approve unresolved technical findings.',
  );
  return result;
}
