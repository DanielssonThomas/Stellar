import { expect, test } from '@playwright/test';

test('Mission Control switches views and refreshes status without navigation', async ({
  page,
}) => {
  let requests = 0;
  const liveAgent = (id: string, name: string, project: string) => ({
    id,
    name,
    project,
    state: 'unknown',
    sessionId: null,
    task: null,
    activity: null,
    tool: null,
    model: null,
    provider: null,
    usage: null,
    startedAt: null,
    lastObservedAt: null,
    source: {
      kind: 'hermes',
      health: 'available',
      observedAt: new Date().toISOString(),
    },
    events: [],
  });
  await page.route('**/api/live/events', (route) => route.abort());
  await page.route('**/api/live', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        sequence: 1,
        observedAt: new Date().toISOString(),
        agents: [
          liveAgent('peon', 'Peon', 'stellar'),
          liveAgent('designer', 'Designer', 'stellar-design'),
          {
            ...liveAgent('codex-example', 'Codex A1B2', 'stellar-design'),
            source: {
              kind: 'codex-local-turn-history',
              health: 'available',
              observedAt: new Date().toISOString(),
            },
          },
        ],
      },
    }),
  );
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
  await expect(
    page.getByRole('heading', { name: 'Stellar Live' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Inspect Peon/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stellar-Design' }).click();
  await expect(page.getByRole('button', { name: /Inspect Peon/ })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: /Inspect Designer/ }).click();
  await expect(page.getByText('No verified running activity')).toBeVisible();
  await page.getByRole('button', { name: /Inspect Codex A1B2/ }).click();
  await expect(page.getByText('Codex desktop history')).toBeVisible();
  await page.getByRole('button', { name: 'All agents' }).click();
  await page.getByRole('button', { name: 'Operations' }).click();
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
