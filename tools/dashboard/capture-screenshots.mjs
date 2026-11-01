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
  await page.getByRole('button', { name: /^Inspect Peon,/ }).waitFor();
  await page.screenshot({
    path: path.join(output, 'stellar-live.png'),
    fullPage: false,
  });
  await page.getByRole('button', { name: 'Operations' }).click();
  await page.getByText('Running · no live source').waitFor();
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Live/ }).click();
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  await page
    .getByRole('heading', { name: 'Activity', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, 'stellar-live-mobile.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}
