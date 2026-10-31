import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error('Pass an absolute output directory for screenshots.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.goto('http://127.0.0.1:4200/');
  await page.getByRole('heading', { name: 'Mission Control' }).waitFor();
  await page.screenshot({
    path: path.join(output, 'stellar-operations.png'),
    fullPage: false,
  });
  await page.getByRole('button', { name: 'Character Studio' }).click();
  await page.getByRole('heading', { name: 'Character Studio' }).waitFor();
  await page.screenshot({
    path: path.join(output, 'stellar-character-studio.png'),
    fullPage: false,
  });
} finally {
  await browser.close();
}
