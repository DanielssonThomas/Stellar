import path from 'node:path';
import { assertRepositoryAdmission } from './host-context.mjs';
import { openHostStore } from './host-store.mjs';
import { assertHostRecipe } from './host-session.mjs';
import { createStageRunner, inspectRecovery } from './host-stage.mjs';
import { executeAttempt } from './host-attempt.mjs';
import { verifyInertCandidate } from './host-candidate.mjs';
import { acceptReview, reviewPacket } from './host-review.mjs';
import { digest, isDigest, requireValue } from './planning-evidence.mjs';

const phaseRoles = {
  dispatch: 'foreman',
  implement: 'peon',
  verify: 'verifier',
  review: 'foreman',
  reconcile: 'foreman',
};
const detached = (value) => JSON.parse(JSON.stringify(value));

function queued(grant) {
  const value = {
    mode: 'inert',
    grantId: grant.id,
    contextDigest: grant.contextDigest,
    status: 'queued',
  };
  return { value, digest: digest(value) };
}

function outside(root, worktree) {
  const relative = path.relative(worktree, root);
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

export async function createEngineeringHost({
  admission,
  storeRoot,
  poolRoot,
  recipes,
  timeoutMs = 2000,
  faults = {},
}) {
  assertRepositoryAdmission(admission);
  const trustedRecipes = Object.freeze(
    Object.fromEntries(
      Object.entries(phaseRoles).map(([phase, role]) => [
        phase,
        assertHostRecipe(recipes?.[phase], phase, role),
      ]),
    ),
  );
  const recipePins = Object.fromEntries(
    Object.entries(trustedRecipes).map(([phase, recipe]) => [
      phase,
      recipe.digest,
    ]),
  );
  requireValue(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000,
    'Host sessions require a bounded timeout.',
  );
  const store = await openHostStore(storeRoot);
  const pool = await openHostStore(poolRoot);
  requireValue(
    outside(pool.root, store.root) && outside(store.root, pool.root),
    'Pool and host journal must use separate trusted roots.',
  );
  const stages = createStageRunner({
    store,
    pool,
    admission,
    recipes: trustedRecipes,
    timeoutMs,
    faults: detached(faults),
  });

  async function load(id) {
    requireValue(isDigest(id), 'A host grant digest is required.');
    const grant = (await store.read(`${id}.grant`)).value;
    requireValue(
      grant.id === id &&
        digest(grant.facts) === grant.contextDigest &&
        digest(grant.recipePins) === digest(recipePins),
      'Grant identity does not match its admission.',
    );
    await stages.refresh(grant);
    return grant;
  }

  async function prepare(request) {
    digest(request);
    request = detached(request);
    requireValue(
      Object.keys(request).sort().join(',') === 'issueNumber,key,sessionId' &&
        typeof request.key === 'string' &&
        /^[a-zA-Z0-9._-]{1,80}$/.test(request.key),
      'Prepare accepts only issue, claim session and idempotency key.',
    );
    const current = await admission.inspect(request);
    requireValue(
      outside(store.root, current.facts.claim.worktreePath) &&
        outside(pool.root, current.facts.claim.worktreePath),
      'Host journal and global pool must be outside the worker checkout.',
    );
    const id = digest({
      repository: current.facts.repository,
      issueNumber: request.issueNumber,
      sessionId: request.sessionId,
      sourceRevision: current.facts.sourceRevision,
      policyRevision: current.facts.policyRevision,
    });
    let grant = {
      schemaVersion: 1,
      mode: 'inert',
      id,
      request,
      contextDigest: current.digest,
      facts: current.facts,
      recipePins,
    };
    try {
      await store.create(`${id}.grant`, grant);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      grant = (await store.read(`${id}.grant`)).value;
      requireValue(
        digest(grant.request) === digest(request) &&
          grant.contextDigest === current.digest &&
          digest(grant.recipePins) === digest(recipePins),
        'Logical authorization already consumed by another request or context.',
      );
    }
    let dispatch;
    try {
      dispatch = await stages.run(grant, 'dispatch', {
        issueNumber: request.issueNumber,
        contextDigest: grant.contextDigest,
        scope: grant.facts.scope,
        capability: grant.facts.capability,
      });
    } catch (error) {
      if (error.code === 'HOST_POOL_BUSY')
        return { id, contextDigest: grant.contextDigest, status: 'queued' };
      throw error;
    }
    requireValue(
      dispatch.value.receipt.status === 'completed' &&
        dispatch.value.receipt.result?.operation === 'dispatch' &&
        dispatch.value.receipt.result.issueNumber === request.issueNumber,
      'Foreman did not authorize this bounded dispatch.',
    );
    return {
      id,
      contextDigest: grant.contextDigest,
      dispatchDigest: dispatch.digest,
      status: 'dispatched',
    };
  }

  async function execute(id) {
    const grant = await load(id);
    const dispatch = await store.read(`${id}.dispatch.result`);
    requireValue(
      dispatch.value.authorityCurrent &&
        dispatch.value.receipt.status === 'completed' &&
        dispatch.value.receipt.role === 'foreman' &&
        dispatch.value.receipt.result?.operation === 'dispatch' &&
        dispatch.value.receipt.result.issueNumber === grant.request.issueNumber,
      'A valid Foreman dispatch is required.',
    );
    try {
      return await executeAttempt({ grant, store, stages });
    } catch (error) {
      if (error.code !== 'HOST_POOL_BUSY') throw error;
      return queued(grant);
    }
  }

  async function review(id) {
    const grant = await load(id);
    const attempt = await store.read(`${id}.attempt.result`);
    const candidate = attempt.value.candidate;
    const candidateRoot = path.join(store.root, `${id}.candidate-tree`);
    if (candidate) {
      await store.read(`${id}.candidate`, digest(candidate));
      await verifyInertCandidate(candidateRoot, candidate);
    }
    const packet = reviewPacket(grant, attempt);
    if (await store.exists(`${id}.review`)) {
      const existing = await store.read(`${id}.review`);
      requireValue(
        existing.value.attemptDigest === attempt.digest &&
          existing.value.packetDigest === digest(packet),
        'Review belongs to another candidate or attempt.',
      );
      return existing;
    }
    let session;
    try {
      session = await stages.run(grant, 'review', packet);
    } catch (error) {
      if (error.code === 'HOST_POOL_BUSY') return queued(grant);
      throw error;
    }
    const report = acceptReview(packet, session);
    if (candidate) await verifyInertCandidate(candidateRoot, candidate);
    await stages.refresh(grant);
    return store.create(`${id}.review`, {
      mode: 'inert',
      issueNumber: grant.request.issueNumber,
      grantId: id,
      attemptDigest: attempt.digest,
      packetDigest: digest(packet),
      sessionDigest: session.digest,
      decision: report.decision,
      report,
    });
  }

  async function reconcile(id) {
    const grant = await load(id);
    const attempt = await store.read(`${id}.attempt.result`);
    const reviewed = await store.read(`${id}.review`);
    requireValue(
      reviewed.value.attemptDigest === attempt.digest &&
        reviewed.value.packetDigest === digest(reviewPacket(grant, attempt)),
      'Reconciliation requires a matching persisted independent review.',
    );
    const candidate = attempt.value.candidate;
    if (candidate)
      await verifyInertCandidate(
        path.join(store.root, `${id}.candidate-tree`),
        candidate,
      );
    const reports = [
      {
        issueNumber: grant.request.issueNumber,
        digest: reviewed.digest,
        decision: reviewed.value.decision,
      },
    ];
    if (await store.exists(`${id}.reconciliation`)) {
      const existing = await store.read(`${id}.reconciliation`);
      requireValue(
        existing.value.reviewDigest === reviewed.digest,
        'Reconciliation belongs to another review.',
      );
      return existing;
    }
    let session;
    try {
      session = await stages.run(grant, 'reconcile', { reports });
    } catch (error) {
      if (error.code === 'HOST_POOL_BUSY') return queued(grant);
      throw error;
    }
    requireValue(
      session.value.receipt.status === 'completed' &&
        digest(session.value.receipt.result?.reports) === digest(reports),
      'Reconciliation did not account for the persisted review.',
    );
    await stages.refresh(grant);
    return store.create(`${id}.reconciliation`, {
      mode: 'inert',
      grantId: id,
      issueNumber: grant.request.issueNumber,
      reviewDigest: reviewed.digest,
      decision: reviewed.value.decision,
      sessionDigest: session.digest,
      status:
        reviewed.value.decision === 'passed'
          ? 'ready-for-integration-review'
          : 'blocked',
    });
  }

  return Object.freeze({
    prepare,
    execute,
    review,
    reconcile,
    async run(request) {
      const grant = await prepare(request);
      if (grant.status === 'queued') {
        return queued(grant);
      }
      const attempt = await execute(grant.id);
      if (attempt.value.status === 'queued') return attempt;
      const reviewed = await review(grant.id);
      if (reviewed.value.status === 'queued') return reviewed;
      return reconcile(grant.id);
    },
    recover: () => inspectRecovery({ store, pool }),
  });
}
