import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactUnavailableError,
  TrustedArtifactStore,
} from './trusted-artifact-store.mjs';
import { compactToolResult } from './context-study.mjs';

const id = '0123456789abcdef0123456789abcdef';

test('isolates retrieval by attempt scope and exposes no storage path', () => {
  const store = new TrustedArtifactStore({ createId: () => id });
  const artifactId = store.put('issue-50:attempt-a', 'first\nsecond\n');
  assert.equal(artifactId, id);
  assert.deepEqual(
    store.retrieve('issue-50:attempt-a', id, {
      firstLine: 1,
      lastLine: 2,
    }),
    {
      content: 'first\nsecond\n',
      firstLine: 1,
      lastLine: 2,
    },
  );
  assert.throws(
    () =>
      store.retrieve('issue-50:attempt-b', id, { firstLine: 1, lastLine: 1 }),
    (error) =>
      error instanceof ArtifactUnavailableError &&
      error.category === 'not-found',
  );
  assert.deepEqual(store.stats, { artifacts: 1, bytes: 13 });
  assert.doesNotMatch(JSON.stringify(store.stats), /attempt-a|tmp|path|first/);
  store.close();
});

test('rejects oversized artifacts and count/aggregate exhaustion deterministically', () => {
  const store = new TrustedArtifactStore({
    createId: () => id,
    maxArtifacts: 1,
    maxArtifactBytes: 5,
    maxTotalBytes: 5,
  });
  assert.throws(
    () => store.put('scope-a', '123456'),
    (error) => error.category === 'size-limit',
  );
  store.put('scope-a', '12345');
  assert.throws(
    () => store.put('scope-b', '1'),
    (error) => error.category === 'count-limit',
  );
  store.close();
});

test('caps aggregate retained bytes independently of per-artifact size', () => {
  const ids = [id, 'fedcba9876543210fedcba9876543210'];
  const store = new TrustedArtifactStore({
    createId: () => ids.shift(),
    maxArtifacts: 3,
    maxArtifactBytes: 3,
    maxTotalBytes: 4,
  });
  store.put('scope-a', 'abc');
  assert.throws(
    () => store.put('scope-a', 'de'),
    (error) => error.category === 'total-size-limit',
  );
  assert.deepEqual(store.stats, { artifacts: 1, bytes: 3 });
  store.close();
});

test('expires artifacts, reports missing references, and bounds requested line ranges', () => {
  let now = 100;
  const store = new TrustedArtifactStore({
    now: () => now,
    createId: () => id,
    ttlMs: 25,
  });
  store.put('scope-a', 'one\ntwo');
  assert.throws(
    () =>
      store.retrieve('scope-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        firstLine: 1,
        lastLine: 1,
      }),
    (error) => error.category === 'not-found',
  );
  assert.throws(
    () => store.retrieve('scope-a', id, { firstLine: 1, lastLine: 3 }),
    (error) => error.category === 'invalid-range',
  );
  now = 125;
  assert.throws(
    () => store.retrieve('scope-a', id, { firstLine: 1, lastLine: 1 }),
    (error) => error.category === 'expired',
  );
  assert.deepEqual(store.stats, { artifacts: 0, bytes: 0 });
  store.close();
});

test('cancels pending expiry callbacks when the trusted store closes', () => {
  let cancelled = 0;
  const store = new TrustedArtifactStore({
    createId: () => id,
    scheduleExpiry: () => () => {
      cancelled += 1;
    },
  });
  store.put('attempt-a', 'retained only until close');
  store.close();
  assert.equal(cancelled, 1);
});

test('cleans one attempt scope and permanently closes the store', () => {
  const ids = [id, 'fedcba9876543210fedcba9876543210'];
  const store = new TrustedArtifactStore({ createId: () => ids.shift() });
  store.put('attempt-a', 'a');
  store.put('attempt-b', 'b');
  store.cleanupScope('attempt-a');
  assert.deepEqual(store.stats, { artifacts: 1, bytes: 1 });
  store.close();
  assert.throws(
    () =>
      store.retrieve('attempt-b', 'fedcba9876543210fedcba9876543210', {
        firstLine: 1,
        lastLine: 1,
      }),
    (error) => error.category === 'store-closed',
  );
});

test('reports visibly when compaction cannot retain the full original artifact', () => {
  const store = new TrustedArtifactStore({
    maxArtifactBytes: 4,
    maxTotalBytes: 4,
  });
  assert.throws(
    () =>
      compactToolResult({
        kind: 'search',
        stdout: 'match\nmatch\nmatch',
        exitCode: 0,
        artifactStore: store,
        scope: 'attempt-a',
      }),
    (error) => error.category === 'size-limit',
  );
  assert.deepEqual(store.stats, { artifacts: 0, bytes: 0 });
  store.close();
});
