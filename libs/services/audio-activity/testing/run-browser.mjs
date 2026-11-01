import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./browser/', import.meta.url));
const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0, fs: { allow: [workspace] } },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw Error('Fixture server did not bind TCP');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STELLAR_BROWSER_CHANNEL
      ? { channel: process.env.STELLAR_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 760 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(`${origin}/`)) external.push(request.url());
  });
  await page.addInitScript(() => {
    window.captureRequests = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        window.captureRequests++;
        throw new DOMException('fixture denial', 'NotAllowedError');
      },
    });
  });
  await page.goto(origin);
  await expect(page.locator('#status')).toHaveText('idle');
  expect(await page.evaluate(() => window.captureRequests)).toBe(0);
  await page.getByRole('button', { name: 'Microphone', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('denied');
  expect(await page.evaluate(() => window.captureRequests)).toBe(1);
  await page.getByRole('button', { name: 'Manual demo', exact: true }).click();
  await expect(page.locator('#calibration')).toHaveText('Calibrated');
  await page.getByRole('button', { name: 'Sound on', exact: true }).click();
  await expect(page.locator('#activity')).toHaveText('Audio activity');
  await expect
    .poll(async () =>
      Number((await page.locator('#summary').innerText()).split(' ')[0]),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Sound off', exact: true }).click();
  await expect(page.locator('#activity')).toHaveText('Quiet');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('muted');
  await page.getByRole('button', { name: 'Manual demo', exact: true }).click();
  await page.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('suspended');
  await page.getByRole('button', { name: 'Manual demo', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('idle');
  expect(await page.evaluate(() => window.captureRequests)).toBe(1);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  console.log(
    'Audio browser fixture passed: denied-capture stub, manual activity, calibration, duration, hangover, mute, minimize, stop, and no external requests. Physical microphone was not used.',
  );
} finally {
  await browser?.close();
  await server.close();
}
