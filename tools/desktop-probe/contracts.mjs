import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'src/generated/contracts.ts');
const source = execFileSync(
  'cargo',
  ['run', '--locked', '--quiet', '--bin', 'export_contracts'],
  {
    cwd: path.join(root, 'src-tauri'),
    encoding: 'utf8',
    maxBuffer: 65_536,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
const formatted = await format(source, {
  ...(await resolveConfig(output)),
  parser: 'typescript',
});
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== formatted)
    throw new Error('Generated TypeScript contracts have drifted');
} else {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, formatted);
}
