import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewReport } from './review-report.mjs';

const source = 'export function answer() { return 42; }';
const fixtures = [
  {
    id: 'deleted-required-export',
    status: 'deleted',
    base: source,
    head: null,
    required: true,
    side: 'base',
    line: 1,
  },
  {
    id: 'emptied-required-export',
    status: 'modified',
    base: source,
    head: '',
    required: true,
    side: 'base',
    line: 1,
  },
  {
    id: 'empty-added-missing-export',
    status: 'added',
    base: null,
    head: '',
    required: true,
    side: 'file',
  },
  {
    id: 'deleted-obsolete-export',
    status: 'deleted',
    base: source,
    head: null,
    required: false,
  },
];

function lineCount(content) {
  return content ? content.split('\n').length : 0;
}

function evidence(fixture, passed) {
  return {
    expectedIssue: 97,
    expectedRevision: 'a'.repeat(40),
    expectedHeadRevision: 'b'.repeat(40),
    authorId: 'peon',
    criteria: ['export-lifecycle'],
    changedFiles: [
      {
        path: 'src/answer.mjs',
        status: fixture.status,
        baseLineCount: lineCount(fixture.base),
        headLineCount: lineCount(fixture.head),
      },
    ],
    verification: [
      {
        id: 'export-probe',
        command: 'fixture export lifecycle probe',
        status: passed ? 'passed' : 'failed',
      },
    ],
  };
}

function response(fixture) {
  const findings = fixture.required
    ? [
        {
          id: 'missing-export',
          kind: 'missing-criterion',
          criterionId: 'export-lifecycle',
          path: 'src/answer.mjs',
          side: fixture.side,
          ...(fixture.line ? { line: fixture.line } : {}),
          summary: 'The required answer export is absent.',
          impact: 'Consumers cannot call the documented API.',
          suggestion: 'Provide the answer export in the candidate module.',
        },
        {
          id: 'failed-probe',
          kind: 'verification',
          criterionId: 'export-lifecycle',
          path: 'src/answer.mjs',
          side: 'file',
          checkId: 'export-probe',
          summary: 'The export lifecycle probe failed.',
          impact: 'The required API has not been verified.',
          suggestion: 'Restore the export and rerun the probe.',
        },
      ]
    : [];
  return {
    schemaVersion: 2,
    issueNumber: 97,
    baselineRevision: 'a'.repeat(40),
    headRevision: 'b'.repeat(40),
    authorId: 'peon',
    reviewerId: 'foreman',
    decision: fixture.required ? 'corrections-required' : 'passed',
    criteria: [
      {
        id: 'export-lifecycle',
        status: fixture.required ? 'not-met' : 'met',
        reason: fixture.required
          ? 'The export must remain available.'
          : 'The obsolete export is removed.',
      },
    ],
    verification: [
      { id: 'export-probe', status: fixture.required ? 'failed' : 'passed' },
    ],
    findings,
  };
}

async function loadFixture(content) {
  return content === null
    ? null
    : import(`data:text/javascript,${encodeURIComponent(content)}`);
}

for (const fixture of fixtures) {
  test(`offline file lifecycle: ${fixture.id}`, async () => {
    const baseModule = await loadFixture(fixture.base);
    const headModule = await loadFixture(fixture.head);
    if (fixture.base !== null) assert.equal(baseModule.answer(), 42);
    assert.equal(typeof headModule?.answer, 'undefined');
    const passed = fixture.required
      ? typeof headModule?.answer === 'function'
      : headModule === null;
    const context = evidence(fixture, passed);
    const report = response(fixture);
    assert.equal(
      validateReviewReport(report, context).decision,
      fixture.required ? 'corrections-required' : 'passed',
    );
    assert.equal(context.changedFiles[0].headLineCount, 0);
    if (fixture.required) {
      assert.throws(
        () => validateReviewReport({ ...report, decision: 'passed' }, context),
        /contradicts/,
      );
      assert.throws(
        () =>
          validateReviewReport(
            {
              ...report,
              findings: report.findings.map((entry) => ({
                ...entry,
                side: 'head',
                line: 1,
              })),
            },
            context,
          ),
        /findings require/,
      );
    }
  });
}

test('rejects invalid sides, baseline ranges and inconsistent file status evidence', () => {
  const fixture = fixtures[0];
  const report = response(fixture);
  const context = evidence(fixture, false);
  for (const change of [
    { side: 'head' },
    { line: 2 },
    { side: 'file' },
    { side: undefined },
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
  for (const change of [
    { status: 'renamed' },
    { headLineCount: 1 },
    { baseLineCount: -1 },
    { status: 'added' },
  ]) {
    assert.throws(
      () =>
        validateReviewReport(report, {
          ...context,
          changedFiles: [{ ...context.changedFiles[0], ...change }],
        }),
      /Trusted review context/,
    );
  }
  const added = fixtures[2];
  const addedReport = response(added);
  assert.throws(
    () =>
      validateReviewReport(
        {
          ...addedReport,
          findings: [
            { ...addedReport.findings[0], side: 'base', line: 1 },
            addedReport.findings[1],
          ],
        },
        evidence(added, false),
      ),
    /findings require/,
  );
});
