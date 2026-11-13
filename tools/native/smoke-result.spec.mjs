import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nativeSmokeSucceeded,
  backgroundSmokeFailure,
} from './smoke-result.mjs';

test('a clean early window close cannot pass without the native IPC completion marker', () => {
  assert.equal(nativeSmokeSucceeded(0, false, ''), false);
  assert.equal(
    nativeSmokeSucceeded(0, false, 'STELLAR_NATIVE_SMOKE_OK\r\n'),
    true,
  );
  assert.equal(
    nativeSmokeSucceeded(1, false, 'STELLAR_NATIVE_SMOKE_OK\n'),
    false,
  );
  assert.equal(
    nativeSmokeSucceeded(0, true, 'STELLAR_NATIVE_SMOKE_OK\n'),
    false,
  );
  assert.equal(
    nativeSmokeSucceeded(0, false, 'prefixSTELLAR_NATIVE_SMOKE_OK\n'),
    false,
  );
});

test('failed background probes retain uncertainty and never authorize retry', () => {
  const report = backgroundSmokeFailure(
    1,
    false,
    [
      'STELLAR_SMOKE_STAGE bg-rpc-session-create',
      'STELLAR_SMOKE_STAGE bg-rpc-prompt-submit',
      'STELLAR_SMOKE_STAGE bg-rpc-refused',
      'STELLAR_SMOKE_STAGE bg-failure-owner-permission',
      'STELLAR_NATIVE_SMOKE_OK',
    ].join('\n'),
  );
  assert.deepEqual(report, {
    status: 'failed',
    exitCode: 1,
    timedOut: false,
    promptSubmissionAttempted: true,
    diagnostic: 'owner-permission',
    admissionReconciled: false,
    retryAuthorized: false,
  });
});

test('raw diagnostics and marker-like substrings never enter failure evidence', () => {
  const report = backgroundSmokeFailure(
    null,
    true,
    [
      'raw private token and session contents',
      'prefixSTELLAR_SMOKE_STAGE bg-rpc-prompt-submit',
      'STELLAR_SMOKE_STAGE bg-failure-private path and token',
    ].join('\n'),
  );
  assert.equal(report.promptSubmissionAttempted, false);
  assert.equal(report.diagnostic, 'unclassified');
  assert.equal(report.exitCode, null);
  assert.equal(report.timedOut, true);
  assert.equal(report.admissionReconciled, false);
  assert.equal(report.retryAuthorized, false);
  assert.equal(JSON.stringify(report).includes('private'), false);
});
