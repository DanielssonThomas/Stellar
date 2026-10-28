import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertMatchingHermesConfigDigest,
  defaultPeonHermesProfile,
  maxForwardedRequestsForWorkflow,
  modelTokenLimitForWorkflow,
  peonHermesConfigFilename,
  resolvePeonHermesProfile,
  resolvePeonHermesWorkflow,
  validatePeonHermesConfigSource,
  validatePeonHermesSoulSource,
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

test('selects only the explicit eligible bounded-coding workflow label', () => {
  assert.equal(resolvePeonHermesWorkflow({ labels: [] }), 'standard');
  assert.equal(maxForwardedRequestsForWorkflow('standard'), undefined);
  assert.equal(maxForwardedRequestsForWorkflow('bounded-coding'), 2);
  assert.throws(
    () => maxForwardedRequestsForWorkflow('three-stage'),
    /Unknown trusted/,
  );
  const selected = {
    labels: [...eligible.labels, 'hermes-workflow:bounded-coding'],
  };
  assert.equal(resolvePeonHermesWorkflow(selected), 'bounded-coding');
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
          'hermes-workflow:bounded-coding',
        ],
      }),
    /requires a low-priority Peon issue/,
  );
  assert.throws(
    () =>
      resolvePeonHermesWorkflow({
        labels: [...selected.labels, 'hermes-workflow:bounded-coding'],
      }),
    /unknown or ambiguous/,
  );
});

test('four-request evidence profile is explicit and restricted to issue 50', () => {
  const selected = {
    number: 50,
    labels: [
      ...eligible.labels.filter(
        (label) => label !== 'hermes-profile:narrow-coding',
      ),
      'hermes-profile:narrow-evidence',
      'hermes-workflow:edit-first-4',
    ],
  };
  assert.equal(resolvePeonHermesProfile(selected), 'narrow-evidence');
  assert.equal(resolvePeonHermesWorkflow(selected), 'edit-first-4');
  assert.equal(maxForwardedRequestsForWorkflow('edit-first-4'), 4);
  assert.equal(modelTokenLimitForWorkflow('edit-first-4'), 52_000);
  assert.equal(modelTokenLimitForWorkflow('bounded-coding'), 32_000);
  assert.throws(
    () => resolvePeonHermesProfile({ ...selected, number: 51 }),
    /requires issue #50/,
  );
  assert.throws(
    () =>
      resolvePeonHermesWorkflow({
        ...selected,
        labels: selected.labels.filter(
          (label) => label !== 'hermes-profile:narrow-evidence',
        ),
      }),
    /requires a low-priority Peon issue/,
  );
  assert.throws(
    () =>
      resolvePeonHermesWorkflow({
        ...selected,
        labels: [...selected.labels, 'hermes-workflow:bounded-coding'],
      }),
    /unknown or ambiguous/,
  );
});

test('minimal coding uses the narrow tools without a scripted request count', () => {
  const selected = {
    number: 50,
    labels: [
      'worker:peon',
      'priority:low',
      'target:develop',
      'hermes-profile:narrow-coding',
      'hermes-workflow:minimal-coding',
    ],
  };
  assert.equal(resolvePeonHermesProfile(selected), 'narrow-coding');
  assert.equal(resolvePeonHermesWorkflow(selected), 'minimal-coding');
  assert.equal(maxForwardedRequestsForWorkflow('minimal-coding'), undefined);
  assert.equal(modelTokenLimitForWorkflow('minimal-coding'), 32_000);
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

test('maps Peon SOUL only to the version-controlled identity template', () => {
  const trusted =
    '/mnt/d/repo/tools/policy/engineering-org/templates/peon/soul.md';
  assert.equal(validatePeonHermesSoulSource(trusted), trusted);
  for (const source of [
    '/home/peon/workspaces/issue-50/SOUL.md',
    '/mnt/d/repo/tools/policy/SOUL.md',
    '/mnt/d/repo/tools/policy/engineering-org/templates/peon/../soul.md',
    `${trusted},ro`,
  ])
    assert.throws(
      () => validatePeonHermesSoulSource(source),
      /version-controlled identity template/,
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

test('keeps focus and narrow tool settings aligned on the Peon model', () => {
  const focus = readFileSync(
    new URL('./peon-hermes-config.yaml', import.meta.url),
    'utf8',
  );
  const narrow = readFileSync(
    new URL('./peon-hermes-narrow-config.yaml', import.meta.url),
    'utf8',
  );
  const evidence = readFileSync(
    new URL('./peon-hermes-evidence-config.yaml', import.meta.url),
    'utf8',
  );
  const template = readFileSync(
    new URL('./engineering-org/templates/peon/config.yaml', import.meta.url),
    'utf8',
  );
  assert.match(focus, /coding_context: focus/);
  assert.doesNotMatch(focus, /disabled_toolsets:/);
  assert.match(narrow, /coding_context: focus/);
  for (const setting of [
    'default: Qwen3.5-9B-Q5_K_S',
    'provider: custom',
    'base_url: http://peon-meter:18436/v1',
    'context_length: 65536',
    'max_turns: 250',
  ]) {
    for (const config of [focus, narrow, evidence, template])
      assert.ok(config.includes(setting));
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
