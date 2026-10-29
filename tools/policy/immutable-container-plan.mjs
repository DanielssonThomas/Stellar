import path from 'node:path';
import { attemptSchema } from './immutable-attempt.mjs';

export const proposedExecutor = Object.freeze({
  account: 'stellar_exec',
  uid: 1100,
  gid: 1100,
});
export const pinnedWorkerImage =
  'ghcr.io/stellar-ai-corp/hermes-worker@sha256:619cd1dba336ea1426f4a2b667f92ea022c4e36a0b305dad4eb922fc135098b2';
const sha256 = /^[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;

function valid(record) {
  if (
    record?.schema !== attemptSchema ||
    record.executorAccount !== proposedExecutor.account ||
    record.executorUid !== proposedExecutor.uid ||
    record.executorGid !== proposedExecutor.gid
  )
    throw new Error(
      'Attempt does not use the proposed separate executor identity.',
    );
  return record;
}

export function immutableContainerNames(record) {
  valid(record);
  return Object.freeze({
    worker: `stellar-immutable-worker-${record.issueNumber}-${record.id}`,
    meter: `stellar-immutable-meter-${record.issueNumber}-${record.id}`,
    verifier: `stellar-immutable-verify-${record.issueNumber}-${record.id}`,
    verifierVolume: `${record.volumeName}-verify`,
  });
}

export function immutableVolumeLabels(record) {
  valid(record);
  return Object.freeze({
    'stellar.immutable.attempt': record.id,
    'stellar.immutable.issue': String(record.issueNumber),
    'stellar.immutable.snapshot': record.snapshotDigest,
  });
}

export function buildPrivateVolumeCreateArgs(record) {
  const labels = immutableVolumeLabels(record);
  return [
    'volume',
    'create',
    '--ignore=false',
    ...Object.entries(labels).flatMap(([key, value]) => [
      '--label',
      `${key}=${value}`,
    ]),
    record.volumeName,
  ];
}

export function assertPrivateVolumeIdentity(
  record,
  inspected,
  graphRoot,
  observedIdentity,
) {
  valid(record);
  if (
    typeof graphRoot !== 'string' ||
    !graphRoot.startsWith('/home/stellar_exec/') ||
    path.posix.normalize(graphRoot) !== graphRoot
  )
    throw new Error('Executor graph root is not trusted.');
  const expectedPath = path.posix.join(
    graphRoot,
    'volumes',
    record.volumeName,
    '_data',
  );
  const labels = immutableVolumeLabels(record);
  if (
    inspected?.Name !== record.volumeName ||
    inspected.Mountpoint !== expectedPath ||
    record.status !== 'volume-initialized' ||
    observedIdentity !== record.volumeIdentity ||
    Object.entries(labels).some(
      ([key, value]) => inspected.Labels?.[key] !== value,
    )
  )
    throw new Error('Podman volume identity differs from trusted attempt.');
  return expectedPath;
}

export function assertImmutableContainerIdentity(
  record,
  inspected,
  kind,
  expectedId,
  expectedVolumePath,
) {
  valid(record);
  const names = immutableContainerNames(record);
  if (
    !['worker', 'meter', 'verifier'].includes(kind) ||
    !containerId.test(expectedId ?? '') ||
    inspected?.Id !== expectedId ||
    inspected.Name !== names[kind] ||
    inspected.ImageName !== pinnedWorkerImage ||
    inspected.Config?.Labels?.['stellar.immutable.attempt'] !== record.id
  )
    throw new Error('Podman container identity differs from trusted attempt.');
  if (kind === 'meter')
    throw new Error('Meter identity contract is not established.');
  const host = inspected.HostConfig;
  if (
    host?.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.SecurityOpt?.includes('no-new-privileges') !== true ||
    host.NetworkMode !== (kind === 'worker' ? 'stellar-peon-worker' : 'none') ||
    host.Annotations?.['io.podman.annotations.userns'] !== 'keep-id' ||
    host.CapAdd?.length !== 0 ||
    host.Devices?.length !== 0 ||
    inspected.Config?.User !== `${record.executorUid}:${record.executorGid}`
  )
    throw new Error(
      'Podman container security settings differ from trusted plan.',
    );
  if (kind === 'worker' || kind === 'verifier') {
    const mounts = inspected.Mounts;
    const volume = kind === 'worker' ? record.volumeName : names.verifierVolume;
    const source =
      kind === 'worker' ? record.snapshotPath : record.candidatePath;
    if (
      typeof expectedVolumePath !== 'string' ||
      !expectedVolumePath.endsWith(`/volumes/${volume}/_data`)
    )
      throw new Error('Trusted private volume path is required.');
    const expected = [
      ['/sealed', source, false, undefined],
      ['/workspace', expectedVolumePath, true, volume],
      ...record.protectedPaths.map((name) => [
        `/workspace/${name}`,
        `${source}/${name}`,
        false,
        undefined,
      ]),
    ];
    if (
      !Array.isArray(mounts) ||
      mounts.length !== expected.length ||
      expected.some(
        ([destination, mountSource, rw, volumeName]) =>
          !mounts.some(
            (item) =>
              item.Destination === destination &&
              item.Source === mountSource &&
              item.RW === rw &&
              (volumeName === undefined || item.Name === volumeName),
          ),
      )
    )
      throw new Error(
        'Worker mounts differ from the sealed source and private volume.',
      );
  }
  return true;
}

export function buildInertCorrectionWorkerArgs(record, command) {
  valid(record);
  if (
    record.status !== 'volume-initialized' ||
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== 'string' || part.includes('\0'))
  )
    throw new Error(
      'Trusted initialized attempt and bounded command are required.',
    );
  const names = immutableContainerNames(record);
  return [
    'create',
    '--pull=never',
    `--name=${names.worker}`,
    '--label',
    `stellar.immutable.attempt=${record.id}`,
    '--userns=keep-id',
    `--user=${record.executorUid}:${record.executorGid}`,
    '--network=stellar-peon-worker',
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m',
    `--mount=type=bind,src=${record.snapshotPath},dst=/sealed,ro`,
    `--mount=type=volume,src=${record.volumeName},dst=/workspace`,
    ...record.protectedPaths.map(
      (name) =>
        `--mount=type=bind,src=${record.snapshotPath}/${name},dst=/workspace/${name},ro`,
    ),
    '--workdir=/workspace',
    '--env=HOME=/tmp',
    '--env=COREPACK_HOME=/opt/corepack',
    '--env=COREPACK_DEFAULT_TO_LATEST=0',
    '--env=COREPACK_ENABLE_NETWORK=0',
    '--env=NX_SKIP_NATIVE_FILE_CACHE=true',
    '--env=HERMES_HOME=/tmp/.hermes',
    '--env=HERMES_RUNTIME_DIR=/opt/hermes/tools',
    '--env=OPENAI_BASE_URL=http://peon-meter:18436/v1',
    '--env=OPENAI_API_KEY=stellar-local-meter',
    pinnedWorkerImage,
    ...command,
  ];
}

export function buildDisposableVerifierArgs(record, candidatePath, command) {
  valid(record);
  if (
    record.status !== 'collected' ||
    !sha256.test(record.candidateDigest ?? '') ||
    candidatePath !== record.candidatePath ||
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== 'string' || part.includes('\0'))
  )
    throw new Error(
      'Sealed candidate digest and trusted verifier command are required.',
    );
  const names = immutableContainerNames(record);
  return [
    'create',
    '--pull=never',
    `--name=${names.verifier}`,
    '--label',
    `stellar.immutable.attempt=${record.id}`,
    '--userns=keep-id',
    `--user=${record.executorUid}:${record.executorGid}`,
    '--network=none',
    '--http-proxy=false',
    '--read-only',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m',
    `--mount=type=bind,src=${candidatePath},dst=/sealed,ro`,
    `--mount=type=volume,src=${names.verifierVolume},dst=/workspace`,
    ...record.protectedPaths.map(
      (name) =>
        `--mount=type=bind,src=${candidatePath}/${name},dst=/workspace/${name},ro`,
    ),
    '--workdir=/workspace',
    '--env=HOME=/tmp',
    '--env=COREPACK_ENABLE_NETWORK=0',
    '--env=NX_SKIP_NATIVE_FILE_CACHE=true',
    pinnedWorkerImage,
    ...command,
  ];
}
