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
  const pcm = await page.evaluate(
    async ({ sourceUrl, workletUrl }) => {
      const { WebAudioSource } = await import(sourceUrl);
      const generator = new AudioContext({ sampleRate: 44100 });
      const oscillator = generator.createOscillator();
      const destination = generator.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      await generator.resume();
      let acquisitions = 0;
      const capture = new WebAudioSource({
        acquire: async () => {
          acquisitions++;
          return destination.stream;
        },
        audio: () => new AudioContext({ sampleRate: 44100 }),
        pcm: { url: workletUrl },
      });
      const chunks = [];
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error('PCM fixture timed out')),
            5000,
          );
          void capture.start({
            frame: () => undefined,
            status: () => undefined,
            pcm: (event) => {
              if (event.type === 'unavailable')
                reject(Error('Worklet unavailable'));
              if (event.type !== 'chunk') return;
              chunks.push(event.chunk);
              if (chunks.length === 5) resolve();
            },
          });
        });
        await capture.stop();
        return {
          acquisitions,
          sequences: chunks.map((chunk) => chunk.sequence),
          rates: chunks.map((chunk) => chunk.sampleRate),
          sizes: chunks.map((chunk) => chunk.samples.length),
          audibleData: chunks.some((chunk) =>
            chunk.samples.some((value) => value !== 0),
          ),
          stopped: destination.stream
            .getTracks()
            .every((track) => track.readyState === 'ended'),
        };
      } finally {
        clearTimeout(timer);
        await capture.stop();
        oscillator.stop();
        oscillator.disconnect();
        await generator.close();
      }
    },
    {
      sourceUrl: `/@fs/${workspace.replaceAll('\\', '/')}/libs/services/audio-activity/src/lib/web-audio-source.ts`,
      workletUrl: `/@fs/${workspace.replaceAll('\\', '/')}/libs/services/audio-activity/worklet/stellar-pcm-worklet.js`,
    },
  );
  expect(pcm).toEqual({
    acquisitions: 1,
    sequences: [0, 1, 2, 3, 4],
    rates: [16000, 16000, 16000, 16000, 16000],
    sizes: [640, 640, 640, 640, 640],
    audibleData: true,
    stopped: true,
  });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  console.log(
    'Audio browser fixture passed: denied-capture stub, manual activity, lifecycle cleanup, actual44100Hz oscillator-to-stream AudioWorklet producing contiguous16000Hz PCM, and no external requests. Physical microphone and speakers were not used.',
  );
} finally {
  await browser?.close();
  await server.close();
}
