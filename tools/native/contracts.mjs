import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
const generatedFile = resolve(root, 'libs/desktop-contracts/src/generated.ts');
const consumer = resolve(
  root,
  'libs/desktop-contracts/src/lib/capability-label.ts',
);
const normalized = (value) => value.replaceAll('\r\n', '\n');

function diagnostics(generated) {
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, onError, fresh) =>
    resolve(file) === generatedFile
      ? ts.createSourceFile(file, generated, version, true)
      : original(file, version, onError, fresh);
  return ts.getPreEmitDiagnostics(ts.createProgram([consumer], options, host));
}

export function verifyBindings(generate) {
  const first = normalized(generate(false));
  assert.equal(
    normalized(generate(false)),
    first,
    'Rust binding generation is nondeterministic',
  );
  assert.equal(
    normalized(readFileSync(generatedFile, 'utf8')),
    first,
    'Rust bindings drifted; run node tools/native/cargo.mjs contract-generate',
  );
  const current = diagnostics(first);
  assert.equal(
    current.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(current, {
      getCanonicalFileName: (value) => value,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
  const extended = normalized(generate(true));
  assert.notEqual(
    extended,
    first,
    'The Rust enum-variant fixture did not change generated types',
  );
  assert.ok(
    diagnostics(extended).some(
      (issue) =>
        issue.file &&
        resolve(issue.file.fileName) === consumer &&
        issue.code === 2345,
    ),
    'A Rust-added enum variant must fail the real exhaustive TypeScript consumer',
  );
  console.log(
    'Bindings are deterministic and current; a Rust-added enum variant fails the exhaustive consumer.',
  );
}
