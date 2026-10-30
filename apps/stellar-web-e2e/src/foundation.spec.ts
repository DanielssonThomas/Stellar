import { expect, test } from '@playwright/test';

test('operations and character studio show source status and honest empty states', async ({
  page,
}) => {
  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      json: {
        observedAt: '2026-10-30T21:00:00Z',
        agents: [
          {
            role: 'Architect',
            id: 'architect-cloud',
            mode: 'Cloud',
            model: 'gpt-6.1-sol',
            provider: 'openai-codex',
            sessionCount: 1,
            sessionState: 'recorded',
            lastActivity: '2026-10-30T20:00:00Z',
            usage: { inputTokens: 100, outputTokens: 20, apiCalls: 1 },
            events: [],
            source: 'Hermes local profile',
          },
        ],
        github: {
          state: 'live',
          issues: [],
          pulls: [],
          source: 'Public GitHub API',
        },
      },
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Operations Overview' }),
  ).toBeVisible();
  await expect(page.getByText('gpt-6.1-sol')).toBeVisible();
  await expect(page.getByText('Session recorded')).toBeVisible();
  await page.getByRole('button', { name: 'Character Studio' }).click();
  await expect(
    page.getByRole('heading', { name: 'Character Studio' }),
  ).toBeVisible();
  await expect(
    page.getByText('No approved references or design contract linked.'),
  ).toBeVisible();
});
