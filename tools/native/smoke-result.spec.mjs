import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeSmokeSucceeded } from './smoke-result.mjs';

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
