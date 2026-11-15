export function nativeSmokeSucceeded(code, timedOut, output) {
  return (
    code === 0 &&
    !timedOut &&
    output.split(/\r?\n/).includes('STELLAR_NATIVE_SMOKE_OK')
  );
}

const failureLabels = new Set([
  'owner-permission',
  'owner-parameters',
  'owner-busy',
  'owner-storage',
  'owner-conflict',
  'owner-missing',
  'owner-draining',
  'owner-other',
  'client-writer-busy',
  'client-pending',
  'client-unknown',
  'client-parameters',
  'bridge-local',
  'deadline',
  'unclassified',
]);

/** A failed probe never establishes rejection, successful delivery or retry authority. */
export function backgroundSmokeFailure(code, timedOut, output) {
  const lines = output.split(/\r?\n/);
  const diagnostics = lines.flatMap((line) => {
    const label = line.startsWith('STELLAR_SMOKE_STAGE bg-failure-')
      ? line.slice('STELLAR_SMOKE_STAGE bg-failure-'.length)
      : '';
    return failureLabels.has(label) ? [label] : [];
  });
  return {
    status: 'failed',
    exitCode: Number.isInteger(code) ? code : null,
    timedOut: timedOut === true,
    promptSubmissionAttempted: lines.includes(
      'STELLAR_SMOKE_STAGE bg-rpc-prompt-submit',
    ),
    diagnostic: diagnostics.at(-1) ?? 'unclassified',
    admissionReconciled: false,
    retryAuthorized: false,
  };
}
