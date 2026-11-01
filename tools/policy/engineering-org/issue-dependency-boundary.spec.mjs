import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const policyRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureModule = new URL(
  '../issue-dependency-fixtures.mjs',
  import.meta.url,
).href;

for (const [script, args] of [
  [
    'manage-issue-worktree.mjs',
    ['claim', '42', '--worker', 'codex', '--session-id', 'identity-regression'],
  ],
  [
    'update-issue.mjs',
    [
      'status',
      '42',
      '--worker',
      'codex',
      '--expected',
      'ready',
      '--status',
      'in-progress',
    ],
  ],
  ['prepare-pr.mjs', ['42', '--worker', 'codex']],
])
  test(`${script} rejects foreign dependency evidence before any claim, label or Git write`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'stellar-dependency-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const preload = path.join(root, 'read-only-fixture.mjs');
    const callsPath = path.join(root, 'calls.jsonl');
    await writeFile(
      preload,
      `
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createDependencyFixture } from ${JSON.stringify(fixtureModule)};
const fixture = createDependencyFixture();
fixture.state.native[0].repository_url = 'https://api.github.com/repos/foreign/project';
fixture.state.native[0].state = 'open';
childProcess.spawnSync = (command, args) => {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({command,args}) + '\\n');
  if (command === 'gh') return { status: 0, stdout: fixture.runCommand(command, args), stderr: '' };
  if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel')
    return { status: 0, stdout: process.cwd(), stderr: '' };
  throw new Error('Unexpected operation after invalid dependency identity.');
};
childProcess.execFileSync = () => { throw new Error('Git execution reached after invalid dependency identity.'); };
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        path.join(policyRoot, script),
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        env: {
          SystemRoot: process.env.SystemRoot ?? '',
          GITHUB_REPOSITORY: 'DanielssonThomas/Stellar',
          GITHUB_API_URL: 'https://api.github.com',
        },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /invalid identity/);
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.command === 'gh').length, 2);
    assert.ok(
      calls.every((call) =>
        call.command === 'gh'
          ? call.args.includes('GET') &&
            !call.args.some((arg) =>
              ['PATCH', 'POST', 'PUT', 'DELETE'].includes(arg),
            )
          : call.command === 'git' &&
            call.args.join(' ') === 'rev-parse --show-toplevel',
      ),
    );
    assert.deepEqual((await readdir(root)).sort(), [
      'calls.jsonl',
      'read-only-fixture.mjs',
    ]);
  });
