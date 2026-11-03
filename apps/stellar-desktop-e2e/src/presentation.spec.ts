import { expect, test, type Page } from '@playwright/test';
import { controlPane } from './stage-driver';

const present = (page: Page, command: Record<string, unknown>) =>
  page.evaluate((command) => {
    const root = document.querySelector('stellar-root');
    if (!root) throw new Error('Missing root');
    const app = (
      window as unknown as {
        ng: {
          getComponent(element: Element): {
            experience: { present(command: unknown): { status: string } };
          };
        };
      }
    ).ng.getComponent(root);
    return app.experience.present({ contractVersion: 1, ...command }).status;
  }, command);

test('registered content remains literal and stable through image loading and pane changes', async ({
  page,
}) => {
  await page.goto('/');
  await page.setViewportSize({ width: 1600, height: 1000 });
  expect(
    await present(page, {
      commandId: 1,
      instanceId: 'document',
      action: 'open',
      surface: 'rich-text',
      prominence: 'primary',
      payload: {
        title: 'Implementation plan',
        blocks: [
          {
            kind: 'paragraph',
            text: '<script>literal</script> Requirements remain intact.\n'.repeat(
              30,
            ),
          },
          {
            kind: 'code',
            text: 'const path = "C:\\work\\plan.json";',
            language: 'TypeScript',
          },
          {
            kind: 'table',
            columns: ['Task', 'State'],
            rows: [['Review', 'Pending']],
          },
          {
            kind: 'checklist',
            items: [{ text: 'Retain the raw request', checked: true }],
          },
        ],
      },
    }),
  ).toBe('applied');
  const documentPane = page.locator('[data-instance-id="document"]');
  await expect(documentPane.locator('script')).toHaveCount(0);
  await expect(documentPane.locator('code')).toContainText(
    'C:\\work\\plan.json',
  );
  await expect(
    documentPane.getByRole('cell', { name: 'Pending' }),
  ).toBeVisible();
  await documentPane.evaluate((element) => {
    (element as HTMLElement).dataset['stable'] = 'yes';
  });
  expect(
    await present(page, {
      commandId: 2,
      instanceId: 'reference',
      action: 'open',
      surface: 'image',
      prominence: 'secondary',
      payload: {
        title: 'Original artwork',
        src: '/emblem/layers/gold-hair.png',
        alt: 'Registered golden hair',
      },
    }),
  ).toBe('applied');
  await expect(
    page.getByRole('img', { name: 'Registered golden hair' }),
  ).toHaveJSProperty('naturalWidth', 1280);
  expect(
    await present(page, {
      commandId: 3,
      instanceId: 'flow',
      action: 'open',
      surface: 'diagram',
      prominence: 'secondary',
      payload: {
        title: 'Presentation flow',
        nodes: [
          { id: 'request', label: 'User request' },
          { id: 'render', label: 'Trusted renderer' },
        ],
        edges: [{ from: 'request', to: 'render', label: 'Validate' }],
      },
    }),
  ).toBe('applied');
  await expect(
    page.getByRole('img', { name: 'Presentation flow' }),
  ).toBeVisible();
  await expect(documentPane).toHaveAttribute('data-stable', 'yes');
  expect(
    await present(page, {
      commandId: 4,
      instanceId: 'reference',
      action: 'update',
      surface: 'image',
      payload: {
        title: 'Missing image',
        src: 'data:image/png;base64,AAAA',
        alt: 'Unavailable test raster',
      },
    }),
  ).toBe('applied');
  await expect(
    page.getByText('Image unavailable. Unavailable test raster'),
  ).toBeVisible();
  await controlPane(page, 'close', 'flow');
  await expect(documentPane).toHaveAttribute('data-stable', 'yes');
  const origin = await page.locator('stellar-stage-organism').boundingBox();
  expect(origin?.x).toBe(0);
  expect(origin?.y).toBe(0);
});

test('browser fallback and source selectors expose limits without accepting invented telemetry', async ({
  page,
}) => {
  await page.goto('/');
  expect(
    await present(page, {
      commandId: 1,
      instanceId: 'browser',
      action: 'open',
      surface: 'browser',
      prominence: 'primary',
      payload: { title: 'Documentation', url: 'https://example.com/docs' },
    }),
  ).toBe('applied');
  await expect(
    page.getByText('Embedded browsing requires the native desktop', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(
    await present(page, {
      commandId: 2,
      instanceId: 'workflow',
      action: 'open',
      surface: 'workflow',
      prominence: 'secondary',
      payload: { title: 'Workflow', state: 'running' },
    }),
  ).toBe('rejected');
  expect(
    await present(page, {
      commandId: 3,
      instanceId: 'workflow',
      action: 'open',
      surface: 'workflow',
      prominence: 'secondary',
      payload: { title: 'Stellar workflow' },
    }),
  ).toBe('applied');
  await expect(page.locator('[data-instance-id="workflow"]')).toContainText(
    'Unavailable or stale',
  );
  expect(
    await present(page, {
      commandId: 4,
      instanceId: 'session',
      action: 'open',
      surface: 'session',
      prominence: 'secondary',
      payload: { title: 'Ivy session' },
    }),
  ).toBe('applied');
  await expect(page.locator('[data-instance-id="session"]')).toContainText(
    'Context utilization',
  );
  await expect(page.locator('[data-instance-id="session"]')).toContainText(
    'Unavailable',
  );
});
