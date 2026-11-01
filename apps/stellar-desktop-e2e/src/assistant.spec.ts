import { expect, test } from '@playwright/test';

test('menu keyboard and explicit trusted presentation retain activity and return ambient on close', async ({
  page,
}) => {
  await page.goto('/');
  const trigger = page.getByRole('button', {
    name: 'Experience menu',
    exact: true,
  });
  await expect(page.locator('[data-desktop-menu]')).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.locator('.emblem-slot').evaluate((element) => {
    element.setAttribute('tabindex', '0');
    (element as HTMLElement).focus();
  });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.getByLabel('Reduce motion').check();
  await page.mouse.click(1000, 650);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
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
  const panel = page.getByRole('region', { name: 'Assistant message' });
  await expect(panel).toContainText('<img src=x> plain text');
  await expect(panel.locator('img')).toHaveCount(0);
  expect(await request(1)).toBe('rejected');
  const emblem = page.locator('.emblem-slot');
  const dock = await emblem.boundingBox();
  expect(dock?.x).toBeGreaterThan(900);
  await trigger.click();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await page.getByRole('button', { name: 'End activity', exact: true }).click();
  await expect(panel).toBeVisible();
  await page
    .getByRole('button', { name: 'Minimize Assistant message' })
    .click();
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await page.getByRole('button', { name: 'Show content', exact: true }).click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Close Assistant message' }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toHaveAttribute('data-phase', 'idle');
  const centered = await emblem.boundingBox();
  expect(centered?.x).toBeLessThan(700);
});
