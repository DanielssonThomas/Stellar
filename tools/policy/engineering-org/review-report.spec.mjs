import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewReport } from './authority.mjs';
import {
  fixtureContext,
  fixtureReport,
  reviewFixtures,
  runFixtureProbes,
} from './review-fixtures.mjs';

function packet(fixture = reviewFixtures[0]) {
  return {
    report: fixtureReport(fixture),
    context: fixtureContext(fixture, runFixtureProbes(fixture)),
  };
}

for (const fixture of reviewFixtures) {
  test(`offline qualification: ${fixture.id}`, () => {
    const probes = runFixtureProbes(fixture);
    assert.deepEqual(
      probes.filter((probe) => !probe.passed).map((probe) => probe.id),
      fixture.expectedFailedProbes,
    );
    const report = fixtureReport(fixture);
    const context = fixtureContext(fixture, probes);
    assert.equal(
      validateReviewReport(report, context).decision,
      fixture.expectedDecision,
    );
    for (const criterion of report.criteria) {
      const passing = probes
        .filter((probe) => probe.criterionId === criterion.id)
        .every((probe) => probe.passed);
      assert.equal(
        criterion.status,
        fixture.verificationUnavailable
          ? 'unverified'
          : passing
            ? 'met'
            : 'not-met',
      );
    }
    if (fixture.id === 'lower-bound-regression') {
      const regression = probes.find((probe) => probe.id === 'lower-bound');
      assert.equal(regression.baselinePassed, true);
      assert.equal(regression.passed, false);
    }
    if (fixture.expectedDecision !== 'passed') {
      assert.throws(
        () => validateReviewReport({ ...report, decision: 'passed' }, context),
        /contradicts/,
      );
    }
  });
}

test('rejects incomplete context rather than trusting matching missing fields', () => {
  for (const context of [undefined, {}, { expectedIssue: 97 }]) {
    assert.throws(
      () => validateReviewReport({}, context),
      /Trusted review context/,
    );
  }
  const invalidChanges = [
    { expectedIssue: 0 },
    { expectedIssue: '97' },
    { expectedRevision: 'abc' },
    { expectedHeadRevision: 'old' },
    { authorId: '../peon' },
    { expectedRevision: ['a'.repeat(40)] },
    { authorId: ['peon'] },
    { criteria: [] },
    { criteria: ['same', 'same'] },
    { criteria: new Array(1) },
    { changedFiles: [] },
    {
      changedFiles: [
        {
          path: '../file',
          status: 'modified',
          baseLineCount: 1,
          headLineCount: 1,
        },
      ],
    },
    {
      changedFiles: [
        {
          path: '/file',
          status: 'modified',
          baseLineCount: 1,
          headLineCount: 1,
        },
      ],
    },
    {
      changedFiles: [
        {
          path: 'src/file',
          status: 'modified',
          baseLineCount: 1,
          headLineCount: -1,
        },
      ],
    },
    { verification: [] },
    { verification: [{ id: 'test', command: 'test', status: 'claimed' }] },
  ];
  const { report, context } = packet();
  for (const change of invalidChanges) {
    assert.throws(
      () => validateReviewReport(report, { ...context, ...change }),
      /Trusted review context/,
    );
  }
});

test('rejects old schema, stale issue/base/head and mismatched author or reviewer', () => {
  const { report, context } = packet();
  for (const change of [
    { schemaVersion: 1 },
    { issueNumber: 98 },
    { baselineRevision: 'c'.repeat(40) },
    { headRevision: 'c'.repeat(40) },
    { authorId: 'other' },
    { reviewerId: 'peon' },
    { approval: 'CEO-approved' },
  ]) {
    assert.throws(
      () => validateReviewReport({ ...report, ...change }, context),
      /invalid|stale|independent/,
    );
  }
  assert.throws(
    () =>
      validateReviewReport(
        { ...report, authorId: 'foreman' },
        { ...context, authorId: 'foreman' },
      ),
    /independent/,
  );
  for (const malformed of [null, [], 'passed', 1]) {
    assert.throws(() => validateReviewReport(malformed, context), /invalid/);
  }
});

test('requires all criteria and checks exactly once and preserves failed/not-run status', () => {
  for (const fixture of reviewFixtures) {
    const { report, context } = packet(fixture);
    for (const verification of [
      [],
      [{ id: 'invented', status: 'passed' }],
      [...report.verification, ...report.verification],
    ]) {
      assert.throws(
        () => validateReviewReport({ ...report, verification }, context),
        /verification claims/,
      );
    }
    if (fixture.expectedDecision !== 'passed') {
      assert.throws(
        () =>
          validateReviewReport(
            {
              ...report,
              verification: [{ id: 'level-tests', status: 'passed' }],
            },
            context,
          ),
        /verification claims/,
      );
    }
    for (const criteria of [
      [],
      report.criteria.slice(1),
      [report.criteria[0], report.criteria[0], report.criteria[0]],
      report.criteria.map((entry) => ({ ...entry, reason: '' })),
    ]) {
      assert.throws(
        () => validateReviewReport({ ...report, criteria }, context),
        /every acceptance criterion/,
      );
    }
  }
});

test('requires actionable findings within the supplied candidate file evidence', () => {
  const { report, context } = packet(reviewFixtures[1]);
  for (const change of [
    { id: '' },
    { kind: 'warning' },
    { criterionId: 'invented' },
    { path: 'src/other.mjs' },
    { side: 'unknown' },
    { side: 'file' },
    { line: 0 },
    { line: 500 },
    { line: 1.5 },
    { summary: '' },
    { impact: '' },
    { suggestion: '' },
    { checkId: 'fake' },
  ]) {
    assert.throws(
      () =>
        validateReviewReport(
          {
            ...report,
            findings: [
              { ...report.findings[0], ...change },
              report.findings[1],
            ],
          },
          context,
        ),
      /findings require/,
    );
  }
  for (const findings of [
    null,
    ['defect'],
    [null],
    new Array(1),
    [report.findings[0], report.findings[0], report.findings[1]],
  ]) {
    assert.throws(
      () => validateReviewReport({ ...report, findings }, context),
      /findings require/,
    );
  }
  for (const findings of [[], [report.findings[0]]]) {
    assert.throws(
      () => validateReviewReport({ ...report, findings }, context),
      /actionable findings/,
    );
  }
  assert.throws(
    () =>
      validateReviewReport(
        {
          ...report,
          criteria: report.criteria.map((entry) => ({
            ...entry,
            status: 'met',
          })),
        },
        context,
      ),
    /findings require/,
  );
});

test('does not treat worker handoff prose as trusted verification', () => {
  const fixture = reviewFixtures.find(
    (entry) => entry.id === 'unsupported-test-claim',
  );
  const { report, context } = packet(fixture);
  assert.equal(fixture.workerClaim, 'All unit tests passed.');
  assert.equal(validateReviewReport(report, context).decision, 'blocked');
  assert.throws(
    () =>
      validateReviewReport(
        {
          ...report,
          verification: [{ id: 'level-tests', status: 'passed' }],
        },
        context,
      ),
    /verification claims/,
  );
});

test('rejects hidden failed checks, unexplained blocking, and a contradictory passed decision', () => {
  const { report, context } = packet();
  assert.throws(
    () => validateReviewReport({ ...report, decision: 'blocked' }, context),
    /contradicts/,
  );
  assert.throws(
    () =>
      validateReviewReport(
        {
          ...report,
          criteria: report.criteria.map((entry) => ({
            ...entry,
            status: 'unverified',
          })),
        },
        context,
      ),
    /contradicts/,
  );
  const extraCheck = {
    id: 'native-smoke',
    command: 'native smoke',
    status: 'failed',
  };
  assert.throws(
    () =>
      validateReviewReport(report, {
        ...context,
        verification: [...context.verification, extraCheck],
      }),
    /verification claims/,
  );
});
