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
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto('http://127.0.0.1:4200/');
  await page.getByText('gpt-6.1-sol').first().waitFor();
  await page.screenshot({
    path: path.join(output, 'stellar-operations.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Character Studio' }).click();
  await page.getByRole('heading', { name: 'Character Studio' }).waitFor();
  await page.screenshot({
    path: path.join(output, 'stellar-character-studio.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}
