import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { trustedPeonWorkerImage } from '../supervised-peon-run.mjs';

const issueId = `ctxprobe-${process.pid}-${Date.now()}`;
const workerImage = trustedPeonWorkerImage;
const transportArgs = [
  '--distribution',
  'Ubuntu',
  '--user',
  'peon',
  '--exec',
  'podman',
  'run',
  '--rm',
  '--pull=never',
  '--interactive',
  '--userns=keep-id',
  '--user=1001:1001',
  '--network=none',
  '--http-proxy=false',
  '--read-only',
  '--cap-drop=all',
  '--security-opt=no-new-privileges',
  '--pids-limit=16',
  '--memory=512m',
  '--memory-swap=512m',
  '--cpus=1',
  '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m',
  '--tmpfs=/tmp/.hermes:rw,nosuid,nodev,noexec,size=64m,mode=0777',
];

function invoke(name, command, payload) {
  const args = [...transportArgs, `--name=${name}`, workerImage, ...command];
  const result = spawnSync('wsl.exe', args, {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024,
  });
  return {
    result,
    approximateWindowsCommandUnits: args.join(' ').length + 'wsl.exe '.length,
  };
}

function isAbsent(name) {
  const result = spawnSync(
    'wsl.exe',
    [
      '--distribution',
      'Ubuntu',
      '--user',
      'peon',
      '--exec',
      'podman',
      'container',
      'exists',
      name,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  return !result.error && result.status !== 0;
}

function cleanupExactProbe(name) {
  if (isAbsent(name)) return true;
  spawnSync(
    'wsl.exe',
    [
      '--distribution',
      'Ubuntu',
      '--user',
      'peon',
      '--exec',
      'podman',
      'rm',
      '--force',
      name,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  return isAbsent(name);
}

const base = 'quotes:" \' \\; newline:\n unicode:λ/雪/🙂;';
let data = 'é'.repeat(25_000);
let largeInput = JSON.stringify({ marker: base, data });
while (Buffer.byteLength(largeInput, 'utf8') > 52_000) {
  data = data.slice(0, -1);
  largeInput = JSON.stringify({ marker: base, data });
}
while (Buffer.byteLength(largeInput, 'utf8') < 52_000) {
  data += 'a';
  largeInput = JSON.stringify({ marker: base, data });
}

const expected = createHash('sha256').update(largeInput).digest('hex');
const successName = `stellar-${issueId}-success`;
const argvName = `stellar-${issueId}-argv`;
const failureName = `stellar-${issueId}-early-exit`;
const success = invoke(successName, ['sha256sum'], largeInput);
const successMatch = /^([a-f0-9]{64})\s+-\s*$/m.exec(
  success.result.stdout ?? '',
);
assert.equal(success.result.error, undefined);
assert.equal(success.result.status, 0);
assert.equal(successMatch?.[1], expected);
assert.ok(success.approximateWindowsCommandUnits < 2_000);
assert.ok(isAbsent(successName));

const argvProbe = [
  'import os,sys',
  'prompt=sys.stdin.buffer.read().decode("utf-8", "strict")',
  'code="import sys,hashlib; print(hashlib.sha256(sys.argv[1].encode(\\"utf-8\\")).hexdigest())"',
  'os.execv("/usr/bin/python3", ["/usr/bin/python3", "-c", code, prompt])',
].join('\n');
const argvDelivery = invoke(argvName, ['python3', '-c', argvProbe], largeInput);
assert.equal(argvDelivery.result.error, undefined);
assert.equal(argvDelivery.result.status, 0);
assert.equal(argvDelivery.result.stdout.trim(), expected);
assert.ok(isAbsent(argvName));

const earlyExit = invoke(failureName, ['sh', '-c', 'exit 23'], largeInput);
const failureClean = cleanupExactProbe(failureName);
assert.ok(failureClean, 'failed probe container must be absent after cleanup');

process.stdout.write(
  `${JSON.stringify({
    image: workerImage,
    transport:
      'Windows stdin -> wsl.exe --exec -> rootless Podman -i -> pinned entrypoint -> sha256sum',
    payloadUtf8Bytes: Buffer.byteLength(largeInput, 'utf8'),
    payloadCodePoints: [...largeInput].length,
    payloadContainsUnicodeQuotesBackslashesAndNewlines: true,
    approximateWindowsCommandUnits: success.approximateWindowsCommandUnits,
    expectedSha256: expected,
    observedSha256: successMatch?.[1],
    pythonExecveSha256: argvDelivery.result.stdout.trim(),
    pythonExecveExitCode: argvDelivery.result.status,
    successExitCode: success.result.status,
    earlyExitStatus: earlyExit.result.status ?? null,
    earlyExitPipeError: earlyExit.result.error?.code ?? null,
    earlyExitContainerAbsent: failureClean,
    successContainerAbsent: isAbsent(successName),
    network: 'none',
    completionRequests: 0,
  })}\n`,
);
