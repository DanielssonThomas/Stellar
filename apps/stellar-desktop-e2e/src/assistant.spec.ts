import { expect, test } from '@playwright/test';
import { controlPane } from './stage-driver';

test('menu keyboard and explicit trusted presentation retain activity and return ambient on close', async ({
  page,
}) => {
  await page.goto('/');
  const desktop = page.locator('stellar-desktop-experience-template');
  const controls = page.getByRole('dialog', { name: 'Experience controls' });
  await expect(
    page.getByRole('button', { name: 'Experience menu', exact: true }),
  ).toHaveCount(0);
  await expect(controls).toBeHidden();
  await desktop.focus();
  await page.keyboard.press('m');
  await expect(controls).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(desktop).toBeFocused();
  await expect(controls).toBeHidden();
  await page.keyboard.press('m');
  await page.getByLabel('Reduce motion').check();
  await page.keyboard.press('Escape');
  const request = (commandId: number, surface = 'assistant-message') =>
    page.evaluate(
      ({ commandId, surface }) => {
        const debug = window as unknown as {
          ng: {
            getComponent(element: Element): {
              experience: { present(command: unknown): { status: string } };
            };
          };
        };
        const root = document.querySelector('stellar-root');
        if (!root) throw new Error('Missing root');
        return debug.ng.getComponent(root).experience.present({
          contractVersion: 1,
          commandId,
          instanceId: 'requested-content',
          action: 'open',
          surface,
          prominence: 'primary',
          payload: {
            title: 'Explicit fixture request',
            body: '<img src=x> plain text',
          },
        }).status;
      },
      { commandId, surface },
    );
  expect(await request(1, 'untrusted-html')).toBe('rejected');
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
  expect(await request(2)).toBe('applied');
  const panel = page.getByRole('region', { name: 'Explicit fixture request' });
  await expect(panel).toContainText('<img src=x> plain text');
  await expect(panel.locator('img')).toHaveCount(0);
  expect(await request(1)).toBe('rejected');
  const emblem = page.locator('.emblem-slot');
  const dock = await emblem.boundingBox();
  expect(dock?.x).toBeGreaterThan(900);
  await page.keyboard.press('m');
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await page.getByRole('button', { name: 'End activity', exact: true }).click();
  await expect(panel).toBeVisible();
  await controlPane(page, 'minimize');
  await expect(panel).toBeHidden();
  await expect(controls).toBeVisible();
  await page.getByRole('button', { name: 'Show content', exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(desktop).toBeFocused();
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toHaveAttribute('data-phase', 'idle');
  const centered = await emblem.boundingBox();
  expect(centered?.x).toBeLessThan(700);
});
