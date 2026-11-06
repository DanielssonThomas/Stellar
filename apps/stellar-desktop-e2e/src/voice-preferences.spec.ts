import { expect, test } from '@playwright/test';

test('voice preferences persist and the local recognition overlay shows wake misses', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Experience controls' });
  const sensitivity = dialog.getByRole('switch', {
    name: 'Higher wake sensitivity',
  });
  const recognition = dialog.getByRole('switch', {
    name: 'Show recognition results',
  });
  await expect(sensitivity).toHaveAttribute('aria-checked', 'false');
  await recognition.click();
  await sensitivity.click();
  await expect(sensitivity).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('stellar-voice-transcript-molecule')).toContainText(
    'Listening for speech',
  );
  await page.evaluate(() => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing app');
    const app = (
      window as unknown as {
        ng: {
          getComponent(node: Element): {
            voice: { recognition: { set(value: unknown): void } };
          };
        };
      }
    ).ng.getComponent(root);
    app.voice.recognition.set({
      text: 'A local phrase without a wake word.',
      status: 'No wake detected',
    });
  });
  await expect(page.locator('stellar-voice-transcript-molecule')).toContainText(
    'No wake detected',
  );
  await expect(page.locator('stellar-voice-transcript-molecule')).toContainText(
    'A local phrase without a wake word.',
  );
  await page.screenshot({
    path: testInfo.outputPath('recognition-local-miss.png'),
  });
  await page.reload();
  await expect(page.locator('stellar-voice-transcript-molecule')).toContainText(
    'Listening for speech',
  );
  await page.keyboard.press('m');
  await expect(
    dialog.getByRole('switch', { name: 'Higher wake sensitivity' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    dialog.getByRole('switch', { name: 'Show recognition results' }),
  ).toHaveAttribute('aria-checked', 'true');
  await dialog
    .getByRole('switch', { name: 'Show recognition results' })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.locator('stellar-voice-transcript-molecule')).toHaveCount(
    0,
  );
});
