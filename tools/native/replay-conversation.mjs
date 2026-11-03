import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const baseline = process.argv[2] === '--baseline-5410a31';
if (baseline) process.argv.splice(2, 1);
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))(
  'esbuild',
);
const root = resolve(import.meta.dirname, '../..');
const output = resolve(
  root,
  `artifacts/native/replay-conversation${baseline ? '-baseline' : ''}.mjs`,
);
const sourceFile = resolve(
  root,
  'libs/services/desktop-adapter/src/lib/speech/voice-conversation.ts',
);
const source = baseline
  ? execFileSync(
      'git',
      [
        'show',
        '5410a319733d63b5f6c6f5e4e58db35fae4d8cfa:libs/services/desktop-adapter/src/lib/speech/voice-conversation.ts',
      ],
      { cwd: root },
    )
  : await readFile(sourceFile);
await mkdir(resolve(root, 'artifacts/native'), { recursive: true });
await build({
  entryPoints: [resolve(import.meta.dirname, 'replay-conversation.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  define: {
    __REPLAY_SOURCE__: JSON.stringify({
      baseline,
      coordinatorSha256: createHash('sha256').update(source).digest('hex'),
    }),
  },
  plugins: baseline
    ? [
        {
          name: 'frozen-pr-head',
          setup(build) {
            build.onLoad(
              { filter: /(?:voice-conversation|fast-commands)\.ts$/ },
              (args) => ({
                contents: execFileSync(
                  'git',
                  [
                    'show',
                    '5410a319733d63b5f6c6f5e4e58db35fae4d8cfa:' +
                      relative(root, args.path).replaceAll('\\', '/'),
                  ],
                  { cwd: root, encoding: 'utf8' },
                ),
                loader: 'ts',
                resolveDir: dirname(args.path),
              }),
            );
          },
        },
      ]
    : [],
  alias: {
    '@stellar/service-audio-activity': resolve(
      root,
      'libs/services/audio-activity/src/index.ts',
    ),
    '@stellar/desktop-contracts': resolve(
      root,
      'libs/desktop-contracts/src/index.ts',
    ),
  },
});
await import(pathToFileURL(output).href);
