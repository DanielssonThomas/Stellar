import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertMatchingHermesConfigDigest,
  defaultPeonHermesProfile,
  maxForwardedRequestsForWorkflow,
  peonHermesConfigFilename,
  resolvePeonHermesProfile,
  resolvePeonHermesWorkflow,
  validatePeonHermesConfigSource,
} from './peon-hermes-profiles.mjs';

const eligible = {
  labels: [
    'worker:peon',
    'priority:low',
    'target:develop',
    'hermes-profile:narrow-coding',
  ],
};

test('uses the existing focus profile unless an issue explicitly opts in', () => {
  assert.equal(defaultPeonHermesProfile, 'focus');
  assert.equal(resolvePeonHermesProfile({ labels: [] }), 'focus');
  assert.equal(
    resolvePeonHermesProfile({ labels: ['worker:peon', 'priority:low'] }),
    'focus',
  );
});

test('selects narrow coding only for explicitly eligible issue metadata', () => {
  assert.equal(resolvePeonHermesProfile(eligible), 'narrow-coding');
  for (const label of ['worker:codex', 'priority:high', 'target:main']) {
    assert.throws(
      () =>
        resolvePeonHermesProfile({
          labels: eligible.labels
            .filter((entry) => !entry.startsWith(label.split(':')[0] + ':'))
            .concat(label),
        }),
      /requires a low-priority Peon issue targeting develop/,
    );
  }
});

test('fails closed on unknown or ambiguous profile labels', () => {
  assert.throws(
    () => resolvePeonHermesProfile({ labels: ['hermes-profile:experimental'] }),
    /unknown or ambiguous/,
  );
  assert.throws(
    () =>
      resolvePeonHermesProfile({
        labels: [...eligible.labels, 'hermes-profile:other'],
      }),
    /unknown or ambiguous/,
  );
});

test('selects only the explicit eligible two-stage workflow label', () => {
  assert.equal(resolvePeonHermesWorkflow({ labels: [] }), 'standard');
  assert.equal(maxForwardedRequestsForWorkflow('standard'), undefined);
  assert.equal(maxForwardedRequestsForWorkflow('two-stage'), 2);
  assert.throws(
    () => maxForwardedRequestsForWorkflow('three-stage'),
    /Unknown trusted/,
  );
  const selected = {
    labels: [...eligible.labels, 'hermes-workflow:two-stage'],
  };
  assert.equal(resolvePeonHermesWorkflow(selected), 'two-stage');
  assert.throws(
    () =>
      resolvePeonHermesWorkflow({
        labels: [...eligible.labels, 'hermes-workflow:future'],
      }),
    /unknown or ambiguous/,
  );
  assert.throws(
    () =>
      resolvePeonHermesWorkflow({
        labels: [
          ...eligible.labels.filter(
            (label) => label !== 'hermes-profile:narrow-coding',
          ),
          'hermes-workflow:two-stage',
        ],
      }),
    /requires a low-priority Peon issue/,
  );
  assert.throws(
    () =>
      resolvePeonHermesWorkflow({
        labels: [...selected.labels, 'hermes-workflow:two-stage'],
      }),
    /unknown or ambiguous/,
  );
});

test('maps only fixed trusted configs and rejects arbitrary or issue-worktree paths', () => {
  assert.equal(peonHermesConfigFilename('focus'), 'peon-hermes-config.yaml');
  assert.equal(
    peonHermesConfigFilename('narrow-coding'),
    'peon-hermes-narrow-config.yaml',
  );
  assert.throws(() => peonHermesConfigFilename('custom'), /Unknown trusted/);
  assert.throws(() => peonHermesConfigFilename('toString'), /Unknown trusted/);
  assert.equal(
    validatePeonHermesConfigSource(
      'narrow-coding',
      '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml',
    ),
    '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml',
  );
  for (const source of [
    '/home/peon/workspaces/issue-50/tools/policy/peon-hermes-narrow-config.yaml',
    '/mnt/d/repo/tools/policy/peon-hermes-config.yaml',
    '/mnt/d/repo/tools/policy/../peon-hermes-narrow-config.yaml',
    '/mnt/d/repo/tools/policy/peon-hermes-narrow-config.yaml,ro',
    'relative/tools/policy/peon-hermes-narrow-config.yaml',
  ])
    assert.throws(
      () => validatePeonHermesConfigSource('narrow-coding', source),
      /does not match its profile/,
    );
});

test('requires matching well-formed Windows and WSL config digests', () => {
  const digest = 'a'.repeat(64);
  assert.equal(assertMatchingHermesConfigDigest(digest, digest), digest);
  assert.throws(
    () => assertMatchingHermesConfigDigest(digest, 'b'.repeat(64)),
    /differs across Windows and WSL/,
  );
  assert.throws(
    () => assertMatchingHermesConfigDigest(digest, 'not-a-digest'),
    /differs across Windows and WSL/,
  );
});

test('keeps the production focus profile unchanged and narrows only the separate opt-in config', () => {
  const focus = readFileSync(
    new URL('./peon-hermes-config.yaml', import.meta.url),
    'utf8',
  );
  const narrow = readFileSync(
    new URL('./peon-hermes-narrow-config.yaml', import.meta.url),
    'utf8',
  );
  assert.match(focus, /coding_context: focus/);
  assert.doesNotMatch(focus, /disabled_toolsets:/);
  assert.match(narrow, /coding_context: focus/);
  for (const setting of [
    'default: Qwen3.5-4B-Q4_K_M',
    'provider: custom',
    'base_url: http://peon-meter:18436/v1',
    'context_length: 65536',
    'max_turns: 250',
  ]) {
    assert.ok(focus.includes(setting));
    assert.ok(narrow.includes(setting));
  }
  assert.match(narrow, /disabled_toolsets:\r?\n(?:[ ]{4}- [a-z_]+\r?\n)+$/);
  for (const toolset of [
    'browser',
    'clarify',
    'code_execution',
    'connections',
    'delegation',
    'memory',
    'session_search',
    'todo',
    'vision',
    'web',
  ])
    assert.match(narrow, new RegExp(`[ ]{4}- ${toolset}\\r?\\n`));
});
