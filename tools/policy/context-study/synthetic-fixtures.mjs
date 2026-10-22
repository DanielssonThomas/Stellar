export const syntheticToolResults = [
  {
    kind: 'directory-listing',
    artifactId: 'synthetic/directory-01',
    exitCode: 0,
    stdout: [
      'libs/ui/atoms/src/lib',
      ...Array.from(
        { length: 30 },
        () => 'libs/ui/atoms/src/lib/skeleton-atom',
      ),
      'button-atom',
      'libs/ui/atoms/src/index.ts',
    ].join('\n'),
  },
  {
    kind: 'search-results',
    artifactId: 'synthetic/search-01',
    exitCode: 0,
    stdout: [
      ...Array.from(
        { length: 40 },
        () => 'libs/ui/atoms/src/lib/skeleton-atom/skeleton-atom.ts:12:avatar',
      ),
      'libs/ui/atoms/src/lib/skeleton-atom/skeleton-atom.spec.ts:8:loading',
    ].join('\n'),
  },
  {
    kind: 'long-command',
    artifactId: 'synthetic/command-01',
    exitCode: 0,
    stdout: [
      'PASS libs/ui/atoms/src/lib/skeleton-atom/skeleton-atom.spec.ts',
      ...Array.from({ length: 200 }, () => 'progress: 6 of 6 checks'),
      'PASS libs/ui/atoms/src/lib/skeleton-atom/skeleton-atom.spec.ts',
    ].join('\n'),
  },
  {
    kind: 'repeated-warnings',
    artifactId: 'synthetic/warnings-01',
    exitCode: 0,
    stdout: [
      ...Array.from(
        { length: 60 },
        () => 'Warning: optional cache was skipped',
      ),
      'Build completed',
    ].join('\n'),
  },
  {
    kind: 'source',
    artifactId: 'synthetic/source-01',
    exitCode: 0,
    stdout: [
      ...Array.from(
        { length: 80 },
        (_, index) =>
          `source excerpt line ${index + 1}: shape-related exact source must remain available`,
      ),
    ].join('\n'),
  },
  {
    kind: 'test-failure',
    artifactId: 'synthetic/test-failure-01',
    exitCode: 1,
    stdout: ' FAIL  skeleton-atom.spec.ts > avatar shape > renders image mask',
    stderr: [
      'AssertionError: expected class "rounded-full"',
      '  at skeleton-atom.spec.ts:41:18',
      '  at runTest (vitest-worker.js:244:9)',
    ].join('\n'),
  },
  {
    kind: 'build-failure',
    artifactId: 'synthetic/build-failure-01',
    exitCode: 2,
    stdout: 'NX   Running target build for project ui-atoms failed',
    stderr: [
      'TS2322: Type "avatar" is not assignable to type SkeletonShape.',
      '  skeleton-atom.component.ts:17:3',
      '  Build failed with 1 error.',
    ].join('\n'),
  },
];

export function syntheticToolCallMessages(results, offset = 0) {
  const calls = results.map((result, index) => ({
    id: `synthetic-call-${offset + index + 1}`,
    type: 'function',
    function: {
      name: ['terminal', 'search_files', 'read_file', 'terminal'][index % 4],
      arguments: JSON.stringify({ query: `synthetic-${offset + index + 1}` }),
    },
  }));
  const assistant = { role: 'assistant', content: null, tool_calls: calls };
  const toolMessages = results.map((result, index) => ({
    role: 'tool',
    tool_call_id: `synthetic-call-${offset + index + 1}`,
    name: calls[index].function.name,
    content: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\nexit=${result.exitCode}`,
  }));
  return [assistant, ...toolMessages];
}
