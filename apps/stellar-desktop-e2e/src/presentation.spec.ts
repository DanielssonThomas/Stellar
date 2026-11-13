import { expect, test, type Page } from '@playwright/test';
import { controlPane } from './stage-driver';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const width of [1600, 520]) {
  test(`observed GitHub issue supports ${width}px layout, keyboard, states and reduced motion`, async ({
    page,
  }, info) => {
    const payload = JSON.parse(
      readFileSync(
        resolve(__dirname, 'fixtures/observed-issue-349.json'),
        'utf8',
      ),
    );
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('stellar-root')).toHaveAttribute(
      'data-desktop-ready',
      'true',
    );
    const shared = { instanceId: 'observed-issue', surface: 'github-issue' };
    expect(
      await present(page, {
        ...shared,
        commandId: 1,
        action: 'open',
        prominence: 'primary',
        payload,
      }),
    ).toBe('applied');
    const pane = page.locator('[data-instance-id="observed-issue"]');
    const issue = pane.getByRole('article', { name: 'GitHub issue card' });
    await expect(
      issue.getByRole('heading', { name: payload.title }),
    ).toBeVisible();
    await expect(issue).toContainText('DanielssonThomas/Stellar #349');
    await expect(issue.locator('dd')).toHaveText([
      'open',
      'status:in-progress',
      'worker:foreman-cloud',
    ]);
    await expect(issue.locator('time')).toHaveAttribute(
      'datetime',
      new Date(Number(payload.observed_at_ms)).toISOString(),
    );
    await expect(
      issue.getByRole('region', { name: 'Issue blockers' }),
    ).toContainText('None observed');
    await expect(
      issue.getByRole('region', { name: 'Linked pull requests' }),
    ).toContainText('Not observed');
    const columns = await issue
      .locator('dl')
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
      );
    expect(columns).toBe(width === 1600 ? 3 : 1);
    const source = issue.getByRole('link', { name: /View source/ });
    await pane.getByRole('group').focus();
    await page.keyboard.press('Tab');
    await expect(source).toBeFocused();
    await expect(source).toHaveAttribute('href', payload.source);
    await expect(source).toHaveCSS('outline-style', 'solid');
    await expect
      .poll(() => issue.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await pane.screenshot({
      path: info.outputPath(`observed-issue-349-${width}.png`),
      animations: 'disabled',
    });
    expect(
      await present(page, {
        ...shared,
        commandId: 2,
        action: 'update',
        payload: { ...payload, status: 'stale' },
      }),
    ).toBe('applied');
    await expect(issue.getByText(/Stale observation/)).toBeVisible();
    for (const [index, status] of [
      'loading',
      'unavailable',
      'error',
    ].entries()) {
      expect(
        await present(page, {
          ...shared,
          commandId: index + 3,
          action: 'update',
          payload: { ...payload, status, issue: null, observed_at_ms: null },
        }),
      ).toBe('applied');
      await expect(
        pane.locator('stellar-presentation-issue-molecule'),
      ).toHaveAttribute('data-render-state', status);
      await expect(issue.locator('dd')).toHaveCount(0);
    }
    expect(
      await present(page, {
        ...shared,
        commandId: 6,
        action: 'update',
        payload: { ...payload, source: 'javascript:alert(1)' },
      }),
    ).toBe('rejected');
    await expect(issue.getByText('Issue retrieval failed')).toBeVisible();
  });
}

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
