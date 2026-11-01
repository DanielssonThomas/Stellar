function normalizeLevel(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function missingUpperBound(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function regressedLowerBound(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, value);
}

function acceptsNumericStrings(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export const reviewProbes = [
  { id: 'lower-bound', criterionId: 'bounded', input: -0.4, expected: 0 },
  { id: 'upper-bound', criterionId: 'bounded', input: 2, expected: 1 },
  { id: 'valid-level', criterionId: 'preserved', input: 0.4, expected: 0.4 },
  { id: 'nan', criterionId: 'invalid-input', input: NaN, expected: 0 },
  {
    id: 'infinity',
    criterionId: 'invalid-input',
    input: Infinity,
    expected: 0,
  },
  {
    id: 'numeric-string',
    criterionId: 'invalid-input',
    input: '0.4',
    expected: 0,
  },
];

const finding = (kind, criterionId, summary, impact, suggestion, line = 3) => ({
  id: 'F1',
  kind,
  criterionId,
  path: 'src/level.mjs',
  side: 'head',
  line,
  summary,
  impact,
  suggestion,
});

export const reviewFixtures = [
  {
    id: 'correct-change',
    baseline: missingUpperBound,
    candidate: normalizeLevel,
    expectedFailedProbes: [],
    expectedDecision: 'passed',
    unmetCriteria: [],
    findings: [],
  },
  {
    id: 'upper-bound-defect',
    baseline: missingUpperBound,
    candidate: missingUpperBound,
    expectedFailedProbes: ['upper-bound'],
    expectedDecision: 'corrections-required',
    unmetCriteria: ['bounded'],
    findings: [
      finding(
        'defect',
        'bounded',
        'An input of 2 returns 2.',
        'The normalized value exceeds the consumer contract of 0..1.',
        'Clamp finite values to an upper bound of 1.',
      ),
    ],
  },
  {
    id: 'lower-bound-regression',
    baseline: normalizeLevel,
    candidate: regressedLowerBound,
    expectedFailedProbes: ['lower-bound'],
    expectedDecision: 'corrections-required',
    unmetCriteria: ['bounded'],
    findings: [
      finding(
        'regression',
        'bounded',
        'An input of -0.4 now returns -0.4.',
        'Previously supported negative input handling breaks normalized consumers.',
        'Restore the lower clamp while preserving the upper clamp.',
      ),
    ],
  },
  {
    id: 'missing-input-criterion',
    baseline: acceptsNumericStrings,
    candidate: acceptsNumericStrings,
    expectedFailedProbes: ['numeric-string'],
    expectedDecision: 'corrections-required',
    unmetCriteria: ['invalid-input'],
    findings: [
      finding(
        'missing-criterion',
        'invalid-input',
        'The string "0.4" is accepted as a level.',
        'The requested rejection of non-number input has not been implemented.',
        'Check the original value with Number.isFinite before clamping.',
        2,
      ),
    ],
  },
  {
    id: 'unsupported-test-claim',
    baseline: missingUpperBound,
    candidate: normalizeLevel,
    expectedFailedProbes: [],
    expectedDecision: 'blocked',
    unmetCriteria: [],
    verificationUnavailable: true,
    workerClaim: 'All unit tests passed.',
    findings: [
      {
        ...finding(
          'verification',
          'bounded',
          'The worker claims tests passed without a trusted run record.',
          'The reviewer cannot establish verification from the worker handoff.',
          'Obtain a trusted test result for this exact candidate revision.',
          1,
        ),
        checkId: 'level-tests',
      },
    ],
  },
];

export function fixtureReport(fixture) {
  const findings = structuredClone(fixture.findings);
  if (fixture.expectedFailedProbes.length > 0) {
    findings.push({
      ...finding(
        'verification',
        fixture.unmetCriteria[0],
        'The trusted level test run failed.',
        'The candidate does not satisfy the tested acceptance criteria.',
        'Correct the reported behavior and rerun the level tests.',
        1,
      ),
      id: 'F2',
      checkId: 'level-tests',
    });
  }
  return {
    schemaVersion: 2,
    issueNumber: 97,
    baselineRevision: 'a'.repeat(40),
    headRevision: 'b'.repeat(40),
    authorId: 'peon',
    reviewerId: 'foreman',
    decision: fixture.expectedDecision,
    findings,
    criteria: ['bounded', 'preserved', 'invalid-input'].map((id) => ({
      id,
      status: fixture.verificationUnavailable
        ? 'unverified'
        : fixture.unmetCriteria.includes(id)
          ? 'not-met'
          : 'met',
      reason: fixture.verificationUnavailable
        ? 'No trusted test run is available.'
        : fixture.unmetCriteria.includes(id)
          ? fixture.findings.find((entry) => entry.criterionId === id).summary
          : 'The fixture behavior satisfies this criterion.',
    })),
    verification: [
      {
        id: 'level-tests',
        status: fixture.verificationUnavailable
          ? 'not-run'
          : fixture.expectedFailedProbes.length > 0
            ? 'failed'
            : 'passed',
      },
    ],
  };
}

export function runFixtureProbes(fixture) {
  return reviewProbes.map((probe) => ({
    id: probe.id,
    criterionId: probe.criterionId,
    passed: Object.is(fixture.candidate(probe.input), probe.expected),
    baselinePassed: Object.is(fixture.baseline(probe.input), probe.expected),
  }));
}

export function fixtureContext(fixture, observedProbes) {
  return {
    expectedIssue: 97,
    expectedRevision: 'a'.repeat(40),
    expectedHeadRevision: 'b'.repeat(40),
    authorId: 'peon',
    criteria: ['bounded', 'preserved', 'invalid-input'],
    changedFiles: [
      {
        path: 'src/level.mjs',
        status: 'modified',
        baseLineCount: fixture.baseline.toString().split('\n').length,
        headLineCount: fixture.candidate.toString().split('\n').length,
      },
    ],
    verification: [
      {
        id: 'level-tests',
        command: 'fixture level probes',
        status: fixture.verificationUnavailable
          ? 'not-run'
          : observedProbes.every((probe) => probe.passed)
            ? 'passed'
            : 'failed',
      },
    ],
  };
}
