import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostFixture } from './host-fixtures.mjs';
import { openHostStore } from './host-store.mjs';
import { digest } from './planning-evidence.mjs';
import { readPrCandidateBridge } from './pr-candidate-bridge.mjs';

let baseline;
let source;
let evidence;

before(async () => {
  baseline = await createHostFixture();
  const result = await baseline.host.run(baseline.request);
  assert.equal(result.value.status, 'ready-for-integration-review');
  const grantId = result.value.grantId;
  const store = await openHostStore(baseline.hostOptions.storeRoot);
  const grant = await store.read(`${grantId}.grant`);
  source = {
    grantId,
    grantDigest: grant.digest,
    attemptDigest: (await store.read(`${grantId}.attempt.result`)).digest,
    reviewDigest: (await store.read(`${grantId}.review`)).digest,
  };
  evidence = {
    issueNumber: 42,
    headSha: 'a'.repeat(40),
    baseSha: grant.value.facts.sourceRevision,
    changedFiles: [{ filename: 'widget.mjs', status: 'modified' }],
  };
});

after(async () => {
  if (baseline) await rm(baseline.root, { recursive: true, force: true });
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'stellar-pr-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, 'host');
  await cp(baseline.hostOptions.storeRoot, storeRoot, { recursive: true });
  const args = {
    storeRoot,
    source: structuredClone(source),
    evidence: structuredClone(evidence),
    readFileAtRevision: async (name, revision) => {
      assert.equal(name, 'widget.mjs');
      assert.ok([evidence.headSha, evidence.baseSha].includes(revision));
      return revision === evidence.headSha
        ? 'export const value = 2;\n'
        : 'export const value = 1;\n';
    },
  };
  const rewrite = async (suffix, change) => {
    const name = path.join(storeRoot, `${source.grantId}.${suffix}`);
    const record = JSON.parse(await readFile(name, 'utf8'));
    change(record.value);
    record.digest = digest(record.value);
    await writeFile(name, JSON.stringify(record));
    return record.digest;
  };
  return { args, rewrite };
}

test('bridges real host evidence to exact PR bytes without relabeling the original review', async (t) => {
  const { args } = await fixture(t);
  const result = await readPrCandidateBridge(args);
  assert.equal(result.mode, 'inert');
  assert.deepEqual(result.sourceIssue, {
    number: baseline.issue.number,
    title: baseline.issue.title,
    body: baseline.issue.body,
  });
  assert.equal(result.headRevision, evidence.headSha);
  assert.notEqual(result.candidateSnapshotSha, evidence.headSha);
  assert.equal(result.priorReview.headRevision, result.candidateSnapshotSha);
  assert.equal(result.reviewContext.expectedHeadRevision, evidence.headSha);
  assert.equal(result.reviewContext.expectedRevision, evidence.baseSha);
  assert.deepEqual(result.reviewContext.changedFiles, [
    {
      path: 'widget.mjs',
      status: 'modified',
      baseLineCount: 1,
      headLineCount: 1,
    },
  ]);
  assert.equal(result.resources.workerUsage.peon.attempts, 1);
  assert.equal(result.resources.workerUsage.peon.modelTokens, 0);
  assert.deepEqual(Object.keys(result.resources.receiptPins), [
    'implement',
    'verify',
    'review',
  ]);
  result.source.grantDigest = 'changed';
  assert.equal(args.source.grantDigest, source.grantDigest);
});

test('rejects incorrect retained pins and foreign issue or base identities', async (t) => {
  for (const field of ['grantDigest', 'attemptDigest', 'reviewDigest']) {
    const { args } = await fixture(t);
    args.source[field] = '0'.repeat(64);
    await assert.rejects(readPrCandidateBridge(args), /integrity/);
  }
  for (const change of [
    { issueNumber: 43 },
    { baseSha: 'b'.repeat(40) },
    { headSha: 'short' },
  ]) {
    const { args } = await fixture(t);
    Object.assign(args.evidence, change);
    await assert.rejects(readPrCandidateBridge(args));
  }
});

test('rejects incomplete, renamed, duplicated and unsupported PR file manifests before reading contents', async (t) => {
  for (const changedFiles of [
    [],
    [{ filename: 'other.mjs', status: 'modified' }],
    [{ filename: 'widget.mjs', status: 'removed' }],
    [
      {
        filename: 'widget.mjs',
        status: 'modified',
        previousFilename: 'old.mjs',
      },
    ],
    [
      { filename: 'widget.mjs', status: 'modified' },
      { filename: 'WIDGET.mjs', status: 'modified' },
    ],
  ]) {
    const { args } = await fixture(t);
    args.evidence.changedFiles = changedFiles;
    let calls = 0;
    args.readFileAtRevision = async () => {
      calls += 1;
      return '';
    };
    await assert.rejects(readPrCandidateBridge(args));
    assert.equal(calls, 0);
  }
});

test('rejects changed PR bytes, invalid text and baseline line evidence', async (t) => {
  for (const reader of [
    async () => 'changed\n',
    async () => null,
    async () => 'é'.repeat(32_769),
    async (_, revision) =>
      revision === evidence.headSha
        ? 'export const value = 2;\n'
        : 'extra\nline\n',
  ]) {
    const { args } = await fixture(t);
    args.readFileAtRevision = reader;
    await assert.rejects(readPrCandidateBridge(args), /Actual PR bytes/);
  }
});

test('rejects source mutation while reading the PR and preserves caller evidence snapshots', async (t) => {
  const { args } = await fixture(t);
  const read = args.readFileAtRevision;
  args.readFileAtRevision = async (name, revision) => {
    args.evidence.headSha = 'b'.repeat(40);
    await writeFile(
      path.join(args.storeRoot, `${source.grantId}.candidate-tree`, name),
      'changed\n',
    );
    return read(name, revision);
  };
  await assert.rejects(readPrCandidateBridge(args), /bytes no longer/);
});

test('rejects a repinned unsafe handoff and forged session identity', async (t) => {
  const unsafe = await fixture(t);
  unsafe.args.source.attemptDigest = await unsafe.rewrite(
    'attempt.result',
    (value) => {
      value.handoff.safeToResume = false;
    },
  );
  unsafe.args.source.reviewDigest = await unsafe.rewrite('review', (value) => {
    value.attemptDigest = unsafe.args.source.attemptDigest;
  });
  await assert.rejects(readPrCandidateBridge(unsafe.args), /safely stopped/);
  const forged = await fixture(t);
  await forged.rewrite('implement.result', (value) => {
    value.receipt.role = 'foreman';
  });
  await assert.rejects(readPrCandidateBridge(forged.args), /provenance/);
});

test('requires cleanup records bound to both implementation and verification receipts', async (t) => {
  const { args } = await fixture(t);
  const store = await openHostStore(args.storeRoot);
  const nonce = (await store.read(`${source.grantId}.implement.reservation`))
    .value.operationNonce;
  await rm(
    path.join(args.storeRoot, `${source.grantId}.attempt-${nonce}.cleanup`),
  );
  await assert.rejects(readPrCandidateBridge(args), { code: 'ENOENT' });
});
