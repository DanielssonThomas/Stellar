import { expect, test } from '@playwright/test';

test('microphone frames pass through the real detector to one summary and release on dismissal', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      value: async () => {
        document.documentElement.dataset['inputsListed'] = 'true';
        return [
          {
            kind: 'audioinput',
            deviceId: 'usb',
            label: 'USB microphone',
            groupId: '',
          },
          {
            kind: 'audioinput',
            deviceId: 'built-in',
            label: 'Built-in microphone',
            groupId: '',
          },
        ];
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async (constraints: MediaStreamConstraints) => {
        document.documentElement.dataset['captureConstraints'] =
          JSON.stringify(constraints);
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.gain.setValueAtTime(0.2, context.currentTime + 1.1);
        gain.gain.setValueAtTime(0, context.currentTime + 2.5);
        oscillator.start();
        await context.resume();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            document.documentElement.dataset['captureStopped'] = 'true';
            document.documentElement.dataset['captureStopCount'] = String(
              Number(
                document.documentElement.dataset['captureStopCount'] ?? 0,
              ) + 1,
            );
            stop();
            void context.close();
          };
        }
        return destination.stream;
      },
    });
  });
  await page.goto('/');
  const experience = page.locator('stellar-desktop-experience-template');
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-inputs-listed',
    'true',
  );
  await page.getByRole('button', { name: 'Choose microphone' }).click();
  await page
    .getByRole('combobox', { name: 'Microphone', exact: true })
    .selectOption('usb');
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-capture-constraints',
  );
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(
    page.getByRole('meter', { name: 'Microphone input level' }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute(
    'data-capture-constraints',
    /"exact":"usb"/,
  );
  await page
    .getByRole('combobox', { name: 'Microphone', exact: true })
    .selectOption('built-in');
  await expect(page.locator('html')).toHaveAttribute(
    'data-capture-constraints',
    /"exact":"built-in"/,
  );
  await expect(experience).toHaveAttribute('data-phase', 'listening');
  await expect
    .poll(async () =>
      page
        .getByRole('meter', { name: 'Microphone input level' })
        .evaluate((element) => (element as HTMLMeterElement).value),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByText('Activity detected', { exact: true }),
  ).toBeVisible();
  await expect(experience).toHaveAttribute('data-phase', 'presenting', {
    timeout: 10000,
  });
  await expect(page.locator('[data-instance-id]')).toHaveCount(1);
  await expect(
    page.getByText('Microphone activity', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('dd').nth(1)).not.toHaveText('0%');
  await page.getByRole('button', { name: 'Close Activity summary' }).click();
  await expect(experience).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('html')).toHaveAttribute(
    'data-capture-stopped',
    'true',
  );
  await expect(page.locator('html')).toHaveAttribute(
    'data-capture-stop-count',
    '2',
  );
});

test('manual activity repeats, restores keyboard focus and never requests capture', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => {
        throw new Error('Manual activity must not request capture');
      },
    });
  });
  await page.goto('/');
  const experience = page.locator('stellar-desktop-experience-template');
  await expect(experience).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByRole('region', { name: 'Activity summary' }),
  ).toHaveCount(0);
  await page.getByLabel('Reduce motion').check();
  for (let iteration = 0; iteration < 2; iteration++) {
    await page
      .getByRole('button', { name: 'Start activity', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(experience).toHaveAttribute('data-phase', 'listening');
    await page
      .getByRole('button', { name: 'End activity', exact: true })
      .press('Enter');
    await expect(experience).toHaveAttribute('data-phase', 'presenting');
    await expect(page.locator('[data-instance-id]')).toHaveCount(1);
    await expect(page.locator('[data-instance-id]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(experience).toHaveAttribute('data-phase', 'idle');
    await expect(page.locator('[data-instance-id]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Start activity', exact: true }),
    ).toBeFocused();
  }
});

test('denial preserves manual fallback, summary restore and resized bounds', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        throw new DOMException('Denied by test', 'NotAllowedError');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(
    page.getByText(
      'Microphone permission denied. You can still start activity manually.',
    ),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await page.getByRole('button', { name: 'End activity', exact: true }).click();
  await expect(page.locator('[data-instance-id]')).toBeVisible();
  await page.getByRole('button', { name: 'Minimize Activity summary' }).click();
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show activity' }).click();
  await expect(page.locator('[data-instance-id]')).toHaveCount(1);
  await page.setViewportSize({ width: 640, height: 520 });
  await expect
    .poll(async () =>
      page.locator('[data-instance-id]').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.right <= innerWidth &&
          rect.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Close Activity summary' }).click();
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toHaveAttribute('data-phase', 'idle');
});

test('resuming during docking and dismissing during motion cannot open stale summaries', async ({
  page,
}) => {
  await page.goto('/');
  const experience = page.locator('stellar-desktop-experience-template');
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect(experience).toHaveAttribute('data-phase', 'listening');
  await page.getByRole('button', { name: 'End activity', exact: true }).click();
  await expect
    .poll(() => experience.getAttribute('data-phase'), { intervals: [20] })
    .toBe('docking');
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect(experience).toHaveAttribute('data-phase', 'listening');
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(experience).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
});
