// Render the exact production assets embedded by this composition's native build.
import { defineConfig, devices } from '@playwright/test';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const nxRequire = createRequire(require.resolve('@nx/web/package.json'));
const serverPackage = nxRequire.resolve('http-server/package.json');
const server = resolve(
  dirname(serverPackage),
  nxRequire('http-server/package.json').bin['http-server'],
);
const root = resolve(process.env['STELLAR_FINAL_COMPOSITION_ROOT'] ?? '');
if (
  !root
    .replaceAll('\\', '/')
    .endsWith('stellar-339-final-pair-20261113/stellar')
)
  throw Error('Expected explicit final disposable composition');
const dist = join(root, 'dist/apps/stellar-desktop/browser');
const port = 4397;

export default defineConfig({
  testDir: join(root, 'apps/stellar-desktop-e2e/src'),
  testMatch: 'background-updates.spec.ts',
  outputDir: join(root, '../renderer-test-results'),
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `"${process.execPath}" "${server}" "${dist}" -a 127.0.0.1 -p ${port} -c-1`,
    cwd: root,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
