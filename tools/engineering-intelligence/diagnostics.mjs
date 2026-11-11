import { createHash } from 'node:crypto';

const knownRust = new Map([
  ['E0277', 'Trait bound not satisfied'],
  ['E0308', 'Mismatched types'],
  ['E0382', 'Use after move'],
  ['E0432', 'Unresolved import'],
  ['E0499', 'Multiple mutable borrows'],
  ['E0502', 'Conflicting borrows'],
  ['E0597', 'Borrowed value does not live long enough'],
  ['E0599', 'Method or associated item unavailable'],
]);

export function digest(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function diagnosticDescription(code, technology) {
  if (/^E\d{4}$/.test(code))
    return knownRust.get(code) ?? 'Rust compiler diagnostic';
  if (/^TS\d{3,5}$/.test(code)) return 'TypeScript compiler diagnostic';
  if (code === 'TEST_FAILURE') return 'Named test failed';
  if (code === 'CLIPPY_LINT') return 'Clippy lint';
  if (code === 'ESLINT_RULE') return 'ESLint rule violation';
  if (code === 'CI_CHECK') return 'CI check failed';
  return technology
    ? 'Structured execution diagnostic'
    : 'Execution diagnostic';
}

export function diagnoseOutput(text, { technology, category, exitCode } = {}) {
  if (!Number.isInteger(exitCode) || exitCode === 0 || typeof text !== 'string')
    return {};
  const bounded = text.slice(0, 32_768).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (technology === 'rust') {
    const error = /^[ \t]*error\[(E\d{4})\]:[ \t]*([^\r\n]{1,256})/m.exec(
      bounded,
    );
    if (error) {
      const block = bounded
        .slice(error.index + error[0].length)
        .split(/^[ \t]*error(?:\[[A-Z0-9]+\])?:/m, 1)[0];
      const types =
        /expected `([^`\r\n]{1,128})`, found (?:`([^`\r\n]{1,128})`|(integer|floating-point number|boolean|character|closure)\b)/.exec(
          block,
        ) ??
        /expected (?:type|struct|enum) `([^`\r\n]{1,128})`[ \t]*\r?\n[^\r\n]{0,64}?found (?:type|struct|enum) `([^`\r\n]{1,128})`/.exec(
          block,
        );
      const details = types
        ?.slice(1)
        .filter(Boolean)
        .map((type) => type.trim().replace(/\s+/g, ' '));
      return {
        code: error[1],
        diagnosticHash: digest(
          error[2].trim().replace(/\s+/g, ' '),
          details ?? [],
        ),
      };
    }
    const lint = /\bclippy::([a-z_]{1,96})\b/.exec(bounded);
    if (category === 'lint' && lint)
      return { code: 'CLIPPY_LINT', diagnosticHash: digest(lint[1]) };
  }
  const ts = /\berror TS(\d{3,5}):\s*([^\r\n]{1,256})/.exec(bounded);
  if (ts) {
    return {
      code: `TS${ts[1]}`,
      diagnosticHash: digest(ts[2].trim().replace(/\s+/g, ' ')),
    };
  }
  if (category === 'test') {
    const test =
      /^test ([\w:.-]{1,192}) \.\.\. FAILED\s*$/m.exec(bounded) ??
      /^\s*FAIL\s+([^\r\n]{1,192})/m.exec(bounded);
    if (test)
      return { code: 'TEST_FAILURE', diagnosticHash: digest(test[1].trim()) };
  }
  return {};
}

export function failureSignature({ technology, code, diagnosticHash }) {
  const recognized =
    /^(E\d{4}|TS\d{3,5}|TEST_FAILURE|CLIPPY_LINT|ESLINT_RULE|CI_CHECK)$/;
  if (!technology || typeof code !== 'string' || !recognized.test(code))
    return null;
  if (
    typeof diagnosticHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(diagnosticHash)
  )
    return null;
  return {
    fingerprint: digest(technology, code, diagnosticHash),
    description: diagnosticDescription(code, technology),
  };
}
