import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(root, 'dist'), { recursive: true });
execFileSync(
  process.execPath,
  [
    path.join(root, '../../node_modules/typescript/bin/tsc'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ],
  { stdio: 'inherit' },
);
for (const file of ['index.html', 'style.css'])
  copyFileSync(path.join(root, 'src', file), path.join(root, 'dist', file));
