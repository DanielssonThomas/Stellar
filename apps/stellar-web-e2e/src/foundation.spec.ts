import { expect, test } from '@playwright/test';

test('the application shell responds to the shared button', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Stellar foundation' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('action-count')).toHaveText('Actions: 1');
});
