import path from 'node:path';
import { superviseWorker } from '../supervise-worker.mjs';
import { sealInertCandidate, verifyInertCandidate } from './host-candidate.mjs';
import { acceptVerification } from './host-review.mjs';
import { requireValue } from './planning-evidence.mjs';

export async function executeAttempt({ grant, store, stages }) {
  await stages.refresh(grant);
  if (await store.exists(`${grant.id}.attempt.result`))
    return store.read(`${grant.id}.attempt.result`);
  requireValue(
    !(await store.exists(`${grant.id}.attempt.reservation`)),
    'Attempt already consumed; replay requires a completed immutable result.',
  );
  return stages.withAttempt(grant, (operation) =>
    runAttempt({ grant, store, stages, operation }),
  );
}

async function runAttempt({ grant, store, stages, operation }) {
  const prefix = `${grant.id}.attempt`;
  await stages.refresh(grant);
  if (await store.exists(`${prefix}.result`))
    return store.read(`${prefix}.result`);
  requireValue(
    !(await store.exists(`${prefix}.reservation`)),
    'Attempt already consumed; replay requires a completed immutable result.',
  );
  await store.create(`${prefix}.reservation`, {
    grantId: grant.id,
    contextDigest: grant.contextDigest,
  });
  let candidate = null;
  let verification = [];
  let active = null;
  let lastSession = null;
  const controller = new AbortController();
  const candidateRoot = path.join(store.root, `${grant.id}.candidate-tree`);
  const cancel = async () => {
    controller.abort();
    try {
      await active;
    } catch {
      /* A missing receipt never proves cleanup. */
    }
    return lastSession?.value.receipt.terminated === true;
  };
  const run = async (phase, packet, signal) => {
    lastSession = null;
    active = stages.run(
      grant,
      phase,
      packet,
      AbortSignal.any([controller.signal, signal].filter(Boolean)),
      operation,
    );
    lastSession = await active;
    return lastSession;
  };
  const verify = async ({ signal }) => {
    await verifyInertCandidate(candidateRoot, candidate);
    verification = acceptVerification(
      await run(
        'verify',
        {
          candidateDigest: candidate.contentDigest,
          gitCommit: candidate.gitCommit,
          files: candidate.files,
        },
        signal,
      ),
    );
    await verifyInertCandidate(candidateRoot, candidate);
    return verification.map((check) => ({
      name: check.id,
      passed: check.status === 'passed',
      summary: check.command,
    }));
  };
  verify.cancel = cancel;
  const supervised = await superviseWorker({
    task: grant.facts.assignment,
    limits: grant.facts.limits,
    handoffPath: path.join(store.root, `${grant.id}.handoff.json`),
    workers: {
      peon: {
        id: 'peon',
        cancel,
        async run({ signal }) {
          const session = await run(
            'implement',
            {
              issueNumber: grant.request.issueNumber,
              sourceRevision: grant.facts.sourceRevision,
              allowedPaths: grant.facts.scope.allowedPaths,
              criteria: grant.facts.scope.criteria,
            },
            signal,
          );
          if (session.value.receipt.status !== 'completed')
            return {
              status: 'failed',
              failure: {
                code: 'InertSessionFailed',
                message: session.value.receipt.failure,
              },
            };
          candidate = await sealInertCandidate({
            root: candidateRoot,
            facts: grant.facts,
            changes: session.value.receipt.result?.changes,
          });
          await store.create(`${grant.id}.candidate`, candidate);
          return {
            status: 'completed',
            attemptedSolution: 'Host-sealed inert candidate change snapshot.',
          };
        },
      },
      mira: {
        id: 'mira',
        run: async () => {
          throw new Error('Escalation requires separate host authorization.');
        },
      },
    },
    inspectWorktree: async () => ({
      fingerprint: candidate?.contentDigest ?? grant.contextDigest,
      changes: candidate?.files.map((file) => file.path) ?? [],
    }),
    verify,
    authorizeHandoff: async () => null,
  });
  await stages.refresh(grant);
  requireValue(
    supervised.safeToResume !== false &&
      supervised.handoff.safeToResume !== false,
    'Attempt cleanup is unconfirmed; review remains pending.',
  );
  return store.create(`${prefix}.result`, {
    schemaVersion: 1,
    mode: 'inert',
    grantId: grant.id,
    status: supervised.status,
    candidate,
    verification,
    handoff: supervised.handoff,
    failure: supervised.handoff.failures.at(-1)?.message ?? null,
  });
}
