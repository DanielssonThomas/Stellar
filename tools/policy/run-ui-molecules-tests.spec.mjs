import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertScopedMoleculeChanges,
  moleculeTestPlan,
} from './run-ui-molecules-tests.mjs';

const source = 'agent-status-molecule.component.ts';
const spec = 'agent-status-molecule.component.spec.ts';

test('empty prepared library is an explicit baseline skip, not a test pass', () => {
  assert.equal(moleculeTestPlan([]), 'baseline-skip');
  assert.throws(
    () => moleculeTestPlan([], { requireAgentStatus: true }),
    /agent-status molecule is missing/,
  );
});

test('generated agent-status source and test require real unit tests', () => {
  assert.equal(
    moleculeTestPlan([source, spec], { requireAgentStatus: true }),
    'run',
  );
});

test('missing and orphaned tests fail closed', () => {
  assert.throws(() => moleculeTestPlan([source]), /matching test/);
  assert.throws(() => moleculeTestPlan([spec]), /matching test/);
  assert.throws(
    () =>
      moleculeTestPlan(
        ['other-molecule.component.ts', 'other-molecule.component.spec.ts'],
        { requireAgentStatus: true },
      ),
    /agent-status molecule is missing/,
  );
});

test('generator scope rejects root changes, traversal and empty evidence', () => {
  assert.deepEqual(
    assertScopedMoleculeChanges([
      'libs/ui/molecules/src/index.ts',
      'libs/ui/molecules/src/lib/molecules/agent-status-molecule.component.ts',
    ]),
    [
      'libs/ui/molecules/src/index.ts',
      'libs/ui/molecules/src/lib/molecules/agent-status-molecule.component.ts',
    ],
  );
  for (const path of [
    'nx.json',
    'tsconfig.base.json',
    'libs/ui/molecules/project.json',
    'libs/ui/molecules/src/../project.json',
    'libs/ui/molecules/src\\index.ts',
  ])
    assert.throws(() => assertScopedMoleculeChanges([path]), /outside scoped/);
  assert.throws(() => assertScopedMoleculeChanges([]), /outside scoped/);
});
