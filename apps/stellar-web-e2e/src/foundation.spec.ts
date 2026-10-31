import { expect, test } from '@playwright/test';

test('Mission Control switches views and refreshes status without navigation', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/api/status', async (route) => {
    requests += 1;
    await route.fulfill({
      json: {
        observedAt: new Date().toISOString(),
        agents: [
          {
            role: 'Designer',
            id: 'designer',
            mode: 'Independent',
            model: 'gpt-6.1-terra',
            provider: 'openai-codex',
            sessionCount: 1,
            sessionState: 'recorded',
            lastActivity: null,
            usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
            events: [],
            source: 'Hermes',
          },
        ],
        github: {
          state: 'live',
          complete: true,
          issues: [
            {
              number: 161,
              title: 'Dashboard',
              url: 'https://github.com/example/161',
              status: 'in-progress',
              owner: 'owner:codex',
              blocked: false,
            },
          ],
          pulls: [],
          source: 'GitHub',
        },
        characters: [
          {
            state: 'observed',
            id: 'stellar-assistant',
            source: 'Stellar-Design',
            assignedAgent: 'Designer',
            activity: 'unknown',
            workflow: 'phase1 refinement',
            contractApproved: true,
            referenceAvailable: true,
            vroid: {
              achieved: 3,
              total: 18,
              sourceRecorded: false,
              exportRecorded: false,
            },
            blender: { launchAllowed: false, sessionRecorded: false },
            blocker: 'Visual approval pending',
            outstanding: [{ id: 'FACE-001', status: 'visually mismatched' }],
            validation: 'Phase 1 visual approval pending',
          },
        ],
      },
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Mission Control' }),
  ).toBeVisible();
  await expect(page.getByText('Running · no live source')).toBeVisible();
  await page.getByRole('button', { name: 'Character Studio' }).click();
  await expect(
    page.getByText('Visual approval pending', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('FACE-001')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => requests).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Operations' }).click();
  await expect(page.getByText('#161 Dashboard')).toBeVisible();
});
