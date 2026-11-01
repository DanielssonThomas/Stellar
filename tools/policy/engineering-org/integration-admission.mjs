import { captureIntegrationEvidence } from '../integration-evidence.mjs';
import { normalizeWorkerConfig } from '../integration-client.mjs';
import { createPrFileReader } from './pr-file-reader.mjs';
import { readPrCandidateBridge } from './pr-candidate-bridge.mjs';
import { digest, requireValue } from './planning-evidence.mjs';

export function createIntegrationAdmission({
  repository,
  workerPolicy,
  request,
  sourceStoreRoot,
  source,
}) {
  digest(workerPolicy);
  const workerConfig = normalizeWorkerConfig(
    JSON.parse(JSON.stringify(workerPolicy)),
  );
  digest(source);
  const pins = JSON.parse(JSON.stringify(source));
  const readOnly = (route, options = {}) => {
    const method = options.method ?? 'GET';
    requireValue(
      method === 'GET' ||
        (route === '/@root/graphql' &&
          method === 'POST' &&
          typeof options.body?.query === 'string' &&
          /^\s*query\b/.test(options.body.query)),
      'Approval admission exposes only read operations.',
    );
    return request(route, options);
  };
  return Object.freeze({
    async inspect({ issueNumber, pullNumber }) {
      const first = await captureIntegrationEvidence(readOnly, {
        issueNumber,
        pullNumber,
        workerConfig,
        repository,
      });
      let bridge = null;
      if (first.decision.eligible)
        bridge = await readPrCandidateBridge({
          storeRoot: sourceStoreRoot,
          source: pins,
          evidence: {
            issueNumber,
            headSha: first.pull.head.sha,
            baseSha: first.baseSha,
            changedFiles: first.facts.files.map(
              ({ filename, status, previousFilename }) => ({
                filename,
                status,
                ...(previousFilename ? { previousFilename } : {}),
              }),
            ),
          },
          readFileAtRevision: createPrFileReader(readOnly, {
            headSha: first.pull.head.sha,
            files: first.facts.files,
          }),
        });
      if (bridge)
        requireValue(
          bridge.sourceIssue.number === first.issue.number &&
            bridge.sourceIssue.title === first.issue.title &&
            bridge.sourceIssue.body === first.issue.body,
          'Current issue scope differs from the verified source acceptance criteria.',
        );
      const latest = await captureIntegrationEvidence(readOnly, {
        issueNumber,
        pullNumber,
        workerConfig,
        repository,
      });
      requireValue(
        first.digest === latest.digest,
        'Integration evidence changed during admission.',
      );
      const facts = {
        snapshot: latest.facts,
        evidenceDigest: latest.digest,
        policyDigest: latest.policyDigest,
        decision: latest.decision,
        bridge,
      };
      return { facts, digest: digest(facts) };
    },
  });
}
