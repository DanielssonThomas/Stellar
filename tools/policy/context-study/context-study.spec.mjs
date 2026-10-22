import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactToolResult,
  filterToolSchemas,
  projectRequests,
  retrieveCompactedRange,
  retrieveOriginalLines,
} from './context-study.mjs';
import { TrustedArtifactStore } from './trusted-artifact-store.mjs';
import { syntheticToolResults } from './synthetic-fixtures.mjs';

test('coalesces only exact repeated stdout and keeps an explicit retrieval range', () => {
  const directory = syntheticToolResults[0];
  const compacted = compactToolResult(directory);
  assert.equal(compacted.exitCode, directory.exitCode);
  assert.equal(compacted.stderr, '');
  assert.match(compacted.stdout, /coalesced=29 exact repeats/);
  assert.deepEqual(compacted.omissions, [
    {
      artifactId: directory.artifactId,
      firstLine: 2,
      lastLine: 31,
      repeatCount: 30,
    },
  ]);
  assert.equal(
    retrieveOriginalLines(directory.stdout, compacted.omissions[0]),
    Array.from(
      { length: 30 },
      () => 'libs/ui/atoms/src/lib/skeleton-atom',
    ).join('\n'),
  );
});

test('compacts with an opaque attempt-scoped artifact and retrieves exact omitted bytes', () => {
  const store = new TrustedArtifactStore();
  const stdout = 'header\nrepeat\nrepeat\nrepeat\ntail\n';
  const result = compactToolResult({
    kind: 'command',
    stdout,
    stderr: 'warning\n',
    exitCode: 7,
    artifactStore: store,
    scope: 'issue-50:session-a',
  });
  const omission = result.omissions[0];
  assert.match(omission.artifactId, /^[a-f0-9]{32}$/);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'warning\n');
  assert.match(result.stdout, /coalesced=2 exact repeats/);
  assert.doesNotMatch(result.stdout, /issue-50|session-a|\\\\|\/tmp/);
  const retrieved = retrieveCompactedRange(
    store,
    'issue-50:session-a',
    omission,
  );
  assert.deepEqual(retrieved, {
    content: 'repeat\nrepeat\nrepeat\n',
    firstLine: 2,
    lastLine: 4,
  });
  assert.throws(
    () => retrieveCompactedRange(store, 'issue-51:other', omission),
    (error) => error.category === 'not-found',
  );
  store.close();
});

test('keeps unique search and command lines, status, stderr, and exit code', () => {
  for (const result of syntheticToolResults.slice(1, 4)) {
    const compacted = compactToolResult(result);
    assert.equal(compacted.exitCode, result.exitCode);
    assert.equal(compacted.stderr, result.stderr ?? '');
    for (const unique of result.stdout.split('\n').filter(Boolean)) {
      assert.ok(compacted.stdout.includes(unique));
    }
  }
  assert.match(
    compactToolResult(syntheticToolResults[1]).stdout,
    /coalesced=39 exact repeats/,
  );
  assert.match(
    compactToolResult(syntheticToolResults[2]).stdout,
    /coalesced=199 exact repeats/,
  );
  assert.match(
    compactToolResult(syntheticToolResults[3]).stdout,
    /coalesced=59 exact repeats/,
  );
});

test('leaves source excerpts and test/build failures unchanged', () => {
  for (const result of syntheticToolResults.slice(4)) {
    assert.deepEqual(compactToolResult(result), {
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      exitCode: result.exitCode,
      omissions: [],
    });
  }
});

test('filters model-visible schemas to a unique synthetic allowlist', () => {
  const schemas = ['terminal', 'web_search', 'patch'].map((name) => ({
    type: 'function',
    function: { name },
  }));
  assert.deepEqual(
    filterToolSchemas(schemas, ['terminal', 'patch']).map(
      (item) => item.function.name,
    ),
    ['terminal', 'patch'],
  );
  assert.throws(
    () => filterToolSchemas([schemas[0], schemas[0]], ['terminal']),
    /unique/,
  );
});

test('projects growing prompts and completion reserves cumulatively', () => {
  const requests = projectRequests({
    baselinePrompts: [13_815, 18_428, 23_041],
    schemaSavings: [1_200, 1_200, 1_200],
    resultSavings: [0, 800, 1_600],
    transferFactor: 0.5,
    completionReserve: 1_000,
  });
  assert.deepEqual(requests, [
    {
      request: 1,
      promptTokens: 13_215,
      promptGrowth: 0,
      completionTokens: 1_000,
      cumulativeTokens: 14_215,
    },
    {
      request: 2,
      promptTokens: 17_428,
      promptGrowth: 4_213,
      completionTokens: 1_000,
      cumulativeTokens: 32_643,
    },
    {
      request: 3,
      promptTokens: 21_641,
      promptGrowth: 4_213,
      completionTokens: 1_000,
      cumulativeTokens: 55_284,
    },
  ]);
});

test('projects checkpoint savings separately from schema and output savings', () => {
  const requests = projectRequests({
    baselinePrompts: [13_815, 18_428, 23_041],
    checkpointSavings: [0, 5_000, 10_000],
    transferFactor: 1,
    completionReserve: 1_500,
  });
  assert.deepEqual(
    requests.map((request) => request.promptTokens),
    [13_815, 13_428, 13_041],
  );
  assert.equal(requests[2].cumulativeTokens, 44_784);
});
