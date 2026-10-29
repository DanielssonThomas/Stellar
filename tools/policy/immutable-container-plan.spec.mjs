import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceImmutableAttempt,
  newImmutableAttempt,
} from './immutable-attempt.mjs';
import {
  assertImmutableContainerIdentity,
  assertPrivateVolumeIdentity,
  buildDisposableVerifierArgs,
  buildInertCorrectionWorkerArgs,
  buildPrivateVolumeCreateArgs,
  immutableContainerNames,
  immutableVolumeLabels,
  pinnedWorkerImage,
} from './immutable-container-plan.mjs';

const identity = {
  issueNumber: 140,
  sessionId: 'trusted-session',
  revisionSha: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  executorAccount: 'stellar_exec',
  executorUid: 1100,
  executorGid: 1100,
  snapshotPath: '/var/lib/stellar-immutable/attempt-140',
  protectedPaths: ['AGENTS.md'],
  id: '33333333-3333-4333-8333-333333333333',
};

test('volume identity is derived from trusted account, labels, and graph root', () => {
  const prepared = newImmutableAttempt(identity);
  const record = advanceImmutableAttempt(prepared, 'volume-initialized', {
    volumeIdentity: '1:2',
  });
  const create = buildPrivateVolumeCreateArgs(record);
  assert.ok(create.includes(record.volumeName));
  const graphRoot = '/home/stellar_exec/.local/share/containers/storage';
  const Mountpoint = `${graphRoot}/volumes/${record.volumeName}/_data`;
  const inspect = {
    Name: record.volumeName,
    Mountpoint,
    Labels: immutableVolumeLabels(record),
  };
  assert.equal(
    assertPrivateVolumeIdentity(record, inspect, graphRoot, '1:2'),
    Mountpoint,
  );
  assert.throws(() =>
    assertPrivateVolumeIdentity(
      record,
      { ...inspect, Name: 'other' },
      graphRoot,
      '1:2',
    ),
  );
  assert.throws(() =>
    assertPrivateVolumeIdentity(
      record,
      inspect,
      '/home/peon/.local/share/containers/storage',
      '1:2',
    ),
  );
  assert.throws(() =>
    assertPrivateVolumeIdentity(
      record,
      { ...inspect, Mountpoint: '/tmp/forged' },
      graphRoot,
      '1:2',
    ),
  );
  assert.throws(() =>
    assertPrivateVolumeIdentity(record, inspect, graphRoot, '1:999'),
  );
});

test('inert worker and verifier plans retain isolation and reject wrong attempts', () => {
  const record = newImmutableAttempt(identity);
  const initialized = advanceImmutableAttempt(record, 'volume-initialized', {
    volumeIdentity: '1:2',
  });
  const worker = buildInertCorrectionWorkerArgs(initialized, ['true']);
  assert.ok(worker.includes('--read-only'));
  assert.ok(worker.includes('--cap-drop=all'));
  assert.ok(worker.includes('--network=stellar-peon-worker'));
  assert.ok(worker.some((arg) => arg.endsWith('dst=/workspace')));
  assert.ok(worker.some((arg) => arg.endsWith('dst=/workspace/AGENTS.md,ro')));
  assert.ok(!worker.some((arg) => arg.startsWith('--secret=')));
  assert.ok(!worker.some((arg) => arg.includes('/home/peon/workspaces')));
  assert.throws(() => buildInertCorrectionWorkerArgs(record, ['true']));
  const names = immutableContainerNames(record);
  const expectedVolumePath = `/home/stellar_exec/.local/share/containers/storage/volumes/${record.volumeName}/_data`;
  const inspected = {
    Id: 'c'.repeat(64),
    Name: names.worker,
    ImageName: pinnedWorkerImage,
    Config: {
      Labels: { 'stellar.immutable.attempt': record.id },
      User: '1100:1100',
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'stellar-peon-worker',
      Annotations: { 'io.podman.annotations.userns': 'keep-id' },
      CapAdd: [],
      Devices: [],
    },
    Mounts: [
      { Destination: '/sealed', Source: record.snapshotPath, RW: false },
      {
        Destination: '/workspace',
        Source: expectedVolumePath,
        Name: record.volumeName,
        RW: true,
      },
      {
        Destination: '/workspace/AGENTS.md',
        Source: `${record.snapshotPath}/AGENTS.md`,
        RW: false,
      },
    ],
  };
  assert.equal(
    assertImmutableContainerIdentity(
      record,
      inspected,
      'worker',
      inspected.Id,
      expectedVolumePath,
    ),
    true,
  );
  assert.throws(() =>
    assertImmutableContainerIdentity(
      record,
      { ...inspected, Name: names.verifier },
      'worker',
      inspected.Id,
      expectedVolumePath,
    ),
  );
  assert.throws(() =>
    assertImmutableContainerIdentity(
      record,
      { ...inspected, Mounts: [] },
      'worker',
      inspected.Id,
      expectedVolumePath,
    ),
  );
  assert.throws(() =>
    assertImmutableContainerIdentity(
      record,
      {
        ...inspected,
        Mounts: [
          ...inspected.Mounts,
          {
            Destination: '/authoritative',
            Source: '/home/thoma/work',
            RW: true,
          },
        ],
      },
      'worker',
      inspected.Id,
      expectedVolumePath,
    ),
  );
  assert.throws(() =>
    assertImmutableContainerIdentity(
      record,
      {
        ...inspected,
        HostConfig: { ...inspected.HostConfig, ReadonlyRootfs: false },
      },
      'worker',
      inspected.Id,
      expectedVolumePath,
    ),
  );
  const running = advanceImmutableAttempt(initialized, 'running', {
    workerContainerId: 'c'.repeat(64),
    meterContainerId: 'e'.repeat(64),
  });
  const stopped = advanceImmutableAttempt(running, 'stopped', {
    terminationConfirmed: true,
  });
  const collected = advanceImmutableAttempt(stopped, 'collected', {
    candidateDigest: 'd'.repeat(64),
    candidatePath: '/var/lib/stellar-immutable/candidate-140',
  });
  const verifier = buildDisposableVerifierArgs(
    collected,
    '/var/lib/stellar-immutable/candidate-140',
    ['true'],
  );
  assert.ok(verifier.includes('--network=none'));
  assert.ok(verifier.some((arg) => arg.includes(names.verifierVolume)));
  assert.throws(() =>
    buildDisposableVerifierArgs(
      stopped,
      '/var/lib/stellar-immutable/candidate-140',
      ['true'],
    ),
  );
});
