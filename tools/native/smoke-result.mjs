export function nativeSmokeSucceeded(code, timedOut, output) {
  return (
    code === 0 &&
    !timedOut &&
    output.split(/\r?\n/).includes('STELLAR_NATIVE_SMOKE_OK')
  );
}
