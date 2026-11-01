import { expect, test } from '@playwright/test';

test('renders the application shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Stellar Desktop' }),
  ).toBeVisible();
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-event',
    'true',
  );
});
