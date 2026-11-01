import path from 'node:path';
import { createIntegrationAdmission } from './integration-admission.mjs';
import { createStageRunner, inspectRecovery } from './host-stage.mjs';
import { openHostStore } from './host-store.mjs';
import { assertHostRecipe } from './host-session.mjs';
import { validateReviewReport } from './review-report.mjs';
import {
  architectPacket,
  acceptArchitectDecision,
} from './approval-packet.mjs';
import { disabledIntegrationFallback } from './integration-fallback.mjs';
import { digest, isDigest, requireValue } from './planning-evidence.mjs';

export async function createArchitectApprovalHost({
  repository,
  workerPolicy,
  request,
  sourceStoreRoot,
  source,
  storeRoot,
  poolRoot,
  recipes,
  authorizationId,
  now = () => Date.now(),
  lifetimeMs = 300_000,
  faults = {},
}) {
  requireValue(
    typeof authorizationId === 'string' &&
      /^[a-zA-Z0-9._:-]{1,128}$/.test(authorizationId) &&
      Number.isSafeInteger(lifetimeMs) &&
      lifetimeMs > 0 &&
      lifetimeMs <= 300_000,
    'A stable host authorization identity and bounded decision lifetime are required.',
  );
  const registered = Object.freeze({
    'pr-review': assertHostRecipe(
      recipes?.['pr-review'],
      'pr-review',
      'foreman',
    ),
    'architect-approval': assertHostRecipe(
      recipes?.['architect-approval'],
      'architect-approval',
      'architect',
    ),
  });
  const recipePins = Object.fromEntries(
    Object.entries(registered).map(([phase, recipe]) => [phase, recipe.digest]),
  );
  const sourceStorage = await openHostStore(sourceStoreRoot);
  const admission = createIntegrationAdmission({
    repository,
    workerPolicy,
    request,
    sourceStoreRoot: sourceStorage.root,
    source,
  });
  const store = await openHostStore(storeRoot);
  const pool = await openHostStore(poolRoot);
  const roots = [store.root, pool.root, sourceStorage.root];
  requireValue(
    roots.every((root, index) =>
      roots.every((other, position) => {
        if (index === position) return true;
        const relative = path.relative(root, other);
        return (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        );
      }),
    ),
    'Approval, source and pool storage must be separate host roots.',
  );
  const stages = createStageRunner({
    store,
    pool,
    admission,
    recipes: registered,
    timeoutMs: 2000,
    faults: JSON.parse(JSON.stringify(faults)),
    assertCurrent: (grant) => unexpired(grant),
  });
  const unexpired = (grant) => {
    const timestamp = now();
    requireValue(
      Number.isFinite(timestamp) &&
        timestamp >= grant.createdAt &&
        timestamp < grant.expiresAt,
      'Architect authorization expired or host clock moved backwards.',
    );
  };

  async function load(id) {
    requireValue(isDigest(id), 'A persisted approval grant is required.');
    const grant = (await store.read(`${id}.approval-grant`)).value;
    requireValue(
      grant.id === id &&
        grant.authorizationId === authorizationId &&
        digest(grant.recipePins) === digest(recipePins),
      'Approval grant belongs to another host authorization or recipe.',
    );
    unexpired(grant);
    await stages.refresh(grant);
    return grant;
  }

  async function requestApproval(input) {
    digest(input);
    const operation = JSON.parse(JSON.stringify(input));
    requireValue(
      Object.keys(operation).sort().join(',') ===
        'issueNumber,key,pullNumber' &&
        Number.isSafeInteger(operation.issueNumber) &&
        operation.issueNumber > 0 &&
        Number.isSafeInteger(operation.pullNumber) &&
        operation.pullNumber > 0 &&
        typeof operation.key === 'string' &&
        /^[a-zA-Z0-9._-]{1,80}$/.test(operation.key),
      'Approval requests accept only issue, PR and idempotency key.',
    );
    const current = await admission.inspect(operation);
    if (!current.facts.decision.eligible)
      return {
        mode: 'inert',
        status: 'blocked',
        reasons: current.facts.decision.reasons,
      };
    const id = digest({
      authorizationId,
      repository: current.facts.snapshot.repository,
      issueNumber: operation.issueNumber,
      pullNumber: operation.pullNumber,
      headSha: current.facts.snapshot.pull.head.sha,
      policyDigest: current.facts.policyDigest,
    });
    const createdAt = now();
    let grant = {
      id,
      mode: 'inert',
      authorizationId,
      request: operation,
      contextDigest: current.digest,
      facts: current.facts,
      recipePins,
      createdAt,
      expiresAt: createdAt + lifetimeMs,
    };
    try {
      await store.create(`${id}.approval-grant`, grant);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      grant = await load(id);
      requireValue(
        digest(grant.request) === digest(operation) &&
          grant.contextDigest === current.digest,
        'Approval authorization is already consumed by another request.',
      );
    }
    unexpired(grant);
    const bridge = grant.facts.bridge;
    try {
      const reviewed = await stages.run(grant, 'pr-review', {
        context: bridge.reviewContext,
        files: bridge.files,
      });
      unexpired(grant);
      if (reviewed.value.receipt.status !== 'completed')
        return {
          id,
          mode: 'inert',
          status: 'blocked',
          reasons: ['review-session-failed'],
        };
      const report = validateReviewReport(
        reviewed.value.receipt.result,
        bridge.reviewContext,
      );
      const packet = architectPacket(grant.facts, report);
      const session = await stages.run(grant, 'architect-approval', packet);
      unexpired(grant);
      if (session.value.receipt.status !== 'completed')
        return {
          id,
          mode: 'inert',
          status: 'blocked',
          reasons: ['architect-session-failed'],
        };
      const decision = acceptArchitectDecision(
        session.value.receipt.result,
        packet,
      );
      await stages.refresh(grant);
      unexpired(grant);
      if (!(await store.exists(`${id}.approval`)))
        await store.create(`${id}.approval`, {
          mode: 'inert',
          grantId: id,
          packetDigest: digest(packet),
          reviewDigest: reviewed.digest,
          sessionDigest: session.digest,
          decision,
          expiresAt: grant.expiresAt,
        });
      return inspect(id);
    } catch (error) {
      if (error.code === 'HOST_POOL_BUSY')
        return { id, mode: 'inert', status: 'queued' };
      throw error;
    }
  }

  async function inspect(id) {
    const grant = await load(id);
    const approval = await store.read(`${id}.approval`);
    const reviewed = await store.read(
      `${id}.pr-review.result`,
      approval.value.reviewDigest,
    );
    const report = validateReviewReport(
      reviewed.value.receipt.result,
      grant.facts.bridge.reviewContext,
    );
    const packet = architectPacket(grant.facts, report);
    const session = await store.read(
      `${id}.architect-approval.result`,
      approval.value.sessionDigest,
    );
    requireValue(
      approval.value.packetDigest === digest(packet) &&
        session.value.receipt.role === 'architect' &&
        session.value.receipt.phase === 'architect-approval' &&
        session.value.receipt.status === 'completed' &&
        session.value.receipt.terminated &&
        session.value.receipt.packetDigest === digest(packet) &&
        reviewed.value.receipt.nonce !== session.value.receipt.nonce &&
        digest(approval.value.decision) ===
          digest(session.value.receipt.result),
      'Approval evidence is not bound to its authenticated independent sessions.',
    );
    const decision = acceptArchitectDecision(
      session.value.receipt.result,
      packet,
    );
    unexpired(grant);
    return {
      id,
      mode: 'inert',
      status:
        decision.decision === 'approve'
          ? 'ready-for-offline-integration'
          : 'blocked',
      decision: decision.decision,
      approvalDigest: approval.digest,
      evidenceDigest: grant.facts.evidenceDigest,
      policyDigest: grant.facts.policyDigest,
      issueNumber: grant.request.issueNumber,
      pullNumber: grant.request.pullNumber,
      headSha: grant.facts.snapshot.pull.head.sha,
      expiresAt: grant.expiresAt,
      liveExecutionAllowed: false,
    };
  }

  return Object.freeze({
    requestApproval,
    inspect,
    async integrate(id) {
      const readiness = await inspect(id);
      return {
        ...readiness,
        merged: false,
        reasons: ['live-architect-adapter-unqualified'],
      };
    },
    fallback: disabledIntegrationFallback,
    recover: () => inspectRecovery({ store, pool }),
  });
}
