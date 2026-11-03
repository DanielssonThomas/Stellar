import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validRecording } from './live-recognition-core.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--run-synthetic')
  throw new Error(
    'Expected --run-synthetic; this uses a fake headless microphone.',
  );
const child = spawn(
  process.execPath,
  ['tools/native/live-recognition.mjs', '--collect-calibration'],
  {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, STELLAR_RECORDER_SELF_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let text = '';
let session;
const ready = new Promise((resolve, reject) => {
  const deadline = setTimeout(
    () => reject(new Error('Recorder did not start')),
    10000,
  );
  child.stdout.on('data', (chunk) => {
    text += chunk;
    const first = text.split('\n')[0];
    try {
      session = JSON.parse(first);
      clearTimeout(deadline);
      resolve(session);
    } catch {}
  });
  child.on('exit', (code) => reject(new Error('Recorder exited ' + code)));
});
let browser;
try {
  await ready;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(session.url);
  await page.locator('#enable').click();
  await page.locator('#record').waitFor();
  await page.waitForFunction(
    () => !document.querySelector('#record').disabled,
    { timeout: 10000 },
  );
  await page.locator('#record').click();
  await page.waitForFunction(
    () =>
      /recording (?:[1-9]|0\.[3-9])/.test(
        document.querySelector('#status').textContent,
      ),
    { timeout: 10000 },
  );
  await page.locator('#finish').click();
  await page.waitForFunction(() => !document.querySelector('#next').disabled, {
    timeout: 10000,
  });
  await page.waitForTimeout(300);
  if (await page.locator('#record').isEnabled())
    throw new Error('Saved item can be recorded twice');
  await page.locator('#next').click();
  await page.locator('#record').click();
  await page.waitForFunction(
    () =>
      /recording (?:[1-9]|0\.[3-9])/.test(
        document.querySelector('#status').textContent,
      ),
    { timeout: 10000 },
  );
  await page.locator('#finish').click();
  await page.waitForFunction(() => !document.querySelector('#next').disabled, {
    timeout: 10000,
  });
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('#progress').textContent.includes('3 of 18'),
    { timeout: 10000 },
  );
  await page.locator('#enable').click();
  for (let item = 2; item < 18; item++) {
    await page.locator('#record').click();
    await page.waitForFunction(() =>
      /recording (?:[1-9]|0\.[3-9])/.test(
        document.querySelector('#status').textContent,
      ),
    );
    await page.locator('#finish').click();
    if (item < 17) await page.locator('#next').click();
  }
  await page.waitForFunction(
    () =>
      document
        .querySelector('#prompt')
        .textContent.includes('Calibration set saved') &&
      document.querySelector('#status').textContent === 'idle',
  );
  if (await page.locator('#enable').isEnabled())
    throw new Error('Capture remains enabled after completion');
  const bytes = await readFile(join(session.privateOutput, 'wake.wav'));
  if (!validRecording(bytes)) throw new Error('No captured PCM output');
  const manifest = JSON.parse(
    await readFile(join(session.privateOutput, 'manifest.json'), 'utf8'),
  );
  if (manifest.fixtureKind !== 'synthetic')
    throw new Error('Incorrect fixture label');
  console.log(
    JSON.stringify({
      passed: true,
      scope:
        'Headless synthetic microphone; all 18 recordings, saved-state lock, reload/resume and automatic capture stop; real shared capture/worklet/server path',
      wavBytes: bytes.length,
      physicalMicrophone: false,
    }),
  );
} finally {
  await browser?.close();
  child.kill();
}
