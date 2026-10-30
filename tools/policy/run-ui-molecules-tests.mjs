/** Run real molecule tests when a component exists; report an empty baseline. */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const componentDirectory = path.join(
  repositoryRoot,
  'libs/ui/molecules/src/lib/molecules',
);

/** The prepared worker may write source under this library, never Nx policy. */
export function assertScopedMoleculeChanges(paths) {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some(
      (entry) =>
        typeof entry !== 'string' ||
        !entry.startsWith('libs/ui/molecules/src/') ||
        entry
          .split('/')
          .some((part) => !part || part === '.' || part === '..') ||
        /[\\\x00-\x1f\x7f]/.test(entry),
    )
  )
    throw new Error('Generator changed a path outside scoped molecule source.');
  return paths;
}

export function moleculeTestPlan(files, { requireAgentStatus = false } = {}) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))
    throw new Error('Molecule test files are invalid.');
  const sources = files.filter((file) =>
    /^[a-z][a-z0-9-]*-molecule\.component\.ts$/.test(file),
  );
  const tests = files.filter((file) =>
    /^[a-z][a-z0-9-]*-molecule\.component\.spec\.ts$/.test(file),
  );
  if (
    sources.some(
      (source) => !tests.includes(source.replace(/\.ts$/, '.spec.ts')),
    ) ||
    tests.some((test) => !sources.includes(test.replace(/\.spec\.ts$/, '.ts')))
  )
    throw new Error('Every molecule component must have its matching test.');
  if (
    requireAgentStatus &&
    !sources.includes('agent-status-molecule.component.ts')
  )
    throw new Error('The agent-status molecule is missing from the candidate.');
  return sources.length === 0 ? 'baseline-skip' : 'run';
}

function main() {
  if (
    process.argv.length > 3 ||
    (process.argv.length === 3 && process.argv[2] !== '--require-agent-status')
  )
    throw new Error('Only the fixed agent-status check is supported.');
  let files;
  try {
    files = readdirSync(componentDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    files = [];
  }
  const plan = moleculeTestPlan(files, {
    requireAgentStatus: process.argv[2] === '--require-agent-status',
  });
  if (plan === 'baseline-skip') {
    process.stdout.write(
      'SKIP ui-molecules unit tests: the trusted baseline has no component.\n',
    );
    return;
  }
  const result = spawnSync(
    process.execPath,
    ['node_modules/nx/bin/nx.js', 'run', 'ui-molecules:unit-test'],
    { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
