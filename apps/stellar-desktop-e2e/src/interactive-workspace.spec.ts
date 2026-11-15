import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceRoot } from '@nx/devkit';
import { expect, test, type Page } from '@playwright/test';

async function send(page: Page, operation: Record<string, unknown>) {
  return page.evaluate((operation) => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing root');
    const app = (
      window as unknown as {
        ng: {
          getComponent(element: Element): {
            experience: {
              present(command: unknown): { status: string; reason?: string };
            };
            view(): {
              stage(): {
                nextCommandId(): number;
                inspectPresentations(): unknown;
              };
            };
          };
        };
      }
    ).ng.getComponent(root);
    return app.experience.present({
      contractVersion: 1,
      commandId: app.view().stage().nextCommandId(),
      ...operation,
    });
  }, operation);
}
const text = (id: string) => ({
  action: 'open',
  instanceId: id,
  surface: 'rich-text',
  prominence: id === 'plan' ? 'primary' : 'secondary',
  payload: {
    title: id,
    blocks: [
      {
        kind: 'checklist',
        items: [{ text: 'Review workspace', checked: false }],
      },
    ],
  },
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.setViewportSize({ width: 1400, height: 900 });
});

test('manual dividers, selection, swap, maximize and minimize retain actual mounted content', async ({
  page,
}) => {
  expect((await send(page, text('plan'))).status).toBe('applied');
  await send(page, {
    action: 'open',
    instanceId: 'images',
    surface: 'image',
    prominence: 'secondary',
    payload: {
      title: 'References',
      src: '/emblem/layers/gold-hair.png',
      alt: 'Gold hair',
      images: [
        { src: '/emblem/layers/gold-hair.png', alt: 'Gold hair' },
        { src: '/emblem/layers/gold-body.png', alt: 'Gold body' },
      ],
    },
  });
  const plan = page.locator('[data-instance-id=plan]'),
    images = page.locator('[data-instance-id=images]');
  const image = images.getByRole('img', { name: 'Gold hair' });
  await expect(image).toHaveJSProperty('complete', true);
  await image.evaluate((element) => {
    (element as HTMLElement).dataset['retained'] = 'yes';
  });
  const original = await plan.boundingBox();
  const divider = page.getByRole('separator', {
    name: 'Resize adjacent panes',
  });
  const bounds = await divider.boundingBox();
  if (!bounds || !original) throw Error('Missing divider');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(900, bounds.y + 100, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await plan.boundingBox())?.width ?? 0))
    .toBe(900);
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => Math.round((await plan.boundingBox())?.width ?? 0))
    .toBe(858);
  await images.getByRole('heading', { name: 'References' }).click();
  await expect(images).toHaveClass(/selected-surface/);
  expect(
    (await send(page, { action: 'resize', instanceId: 'plan', percent: 65 }))
      .status,
  ).toBe('applied');
  await expect
    .poll(async () => Math.round((await plan.boundingBox())?.width ?? 0))
    .toBe(910);
  await send(page, { action: 'swap', instanceId: 'plan', otherId: 'images' });
  await expect
    .poll(async () => Math.round((await images.boundingBox())?.x ?? -1))
    .toBe(0);
  await page.keyboard.press('m');
  await page.getByLabel('Show pane controls', { exact: true }).check();
  await page.keyboard.press('Escape');
  await images
    .getByRole('button', { name: 'Maximize pane', exact: true })
    .click();
  await expect(images).toHaveCSS('width', '1400px');
  await expect(plan).toBeHidden();
  await images
    .getByRole('button', { name: 'Restore layout', exact: true })
    .click();
  await expect(plan).toBeVisible();
  await images
    .getByRole('button', { name: 'Minimize pane', exact: true })
    .click();
  await expect(images).toBeHidden();
  await page
    .getByRole('button', { name: 'Restore References', exact: true })
    .click();
  await expect(images).toBeVisible();
  await expect(image).toHaveAttribute('data-retained', 'yes');
  await page.screenshot({
    path: join(workspaceRoot, 'artifacts/workspace/interactive-split.png'),
  });
});

test('checklist and gallery edits advance revisions and reject stale assistant replacements', async ({
  page,
}) => {
  await send(page, text('plan'));
  const plan = page.locator('[data-instance-id=plan]');
  await plan.getByRole('button', { name: 'Incomplete', exact: true }).click();
  await expect(
    plan.getByRole('button', { name: 'Complete', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const replacement = { ...text('plan'), action: 'update' };
  delete (replacement as Record<string, unknown>)['prominence'];
  expect((await send(page, replacement)).reason).toBe('revision-conflict');
  expect(
    (await send(page, { ...replacement, expectedRevision: 0 })).reason,
  ).toBe('revision-conflict');
  expect(
    (await send(page, { ...replacement, expectedRevision: 1 })).status,
  ).toBe('applied');
  await send(page, {
    action: 'open',
    instanceId: 'gallery',
    surface: 'image',
    prominence: 'secondary',
    payload: {
      title: 'Gallery',
      src: '/emblem/layers/gold-hair.png',
      alt: 'Hair',
      images: [
        {
          src: '/emblem/layers/gold-hair.png',
          alt: 'Hair',
          caption: 'First reference',
        },
        {
          src: '/emblem/layers/gold-body.png',
          alt: 'Body',
          caption: 'Second reference',
        },
      ],
    },
  });
  const gallery = page.locator('[data-instance-id=gallery]');
  await gallery.getByRole('button', { name: 'Next image' }).click();
  await expect(
    gallery.getByRole('img', { name: 'Body', exact: true }),
  ).toBeVisible();
  await gallery.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(
    gallery.getByRole('button', { name: 'Reset image view' }),
  ).toHaveText('150%');
  await gallery.getByRole('button', { name: 'Previous image' }).click();
  await expect(
    gallery.getByRole('img', { name: 'Hair', exact: true }),
  ).toBeVisible();
  await expect(
    gallery.getByRole('button', { name: 'Reset image view' }),
  ).toHaveText('100%');
});

test('four responsive panes, unsafe sources and unavailable browser/telemetry remain explicit', async ({
  page,
}) => {
  for (const id of ['plan', 'reference', 'third', 'fourth'])
    expect((await send(page, text(id))).status).toBe('applied');
  await page.setViewportSize({ width: 640, height: 600 });
  const rectangles = await page
    .locator('section[data-instance-id]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }),
    );
  expect(rectangles).toHaveLength(4);
  expect(rectangles.every((r) => r.width >= 220 && r.height >= 140)).toBe(true);
  for (let index = 5; index <= 12; index++)
    expect((await send(page, text(`extra${index}`))).status).toBe('applied');
  expect((await send(page, text('excess'))).status).toBe('rejected');
  await send(page, { action: 'clear' });
  for (const url of [
    'https://127.0.0.1/',
    'https://169.254.169.254/',
    'file:///secret',
    'javascript:alert(1)',
    'http://example.com/',
  ])
    expect(
      (
        await send(page, {
          action: 'open',
          instanceId: 'unsafe',
          surface: 'browser',
          prominence: 'primary',
          payload: { title: 'Unsafe', url },
        })
      ).status,
    ).toBe('rejected');
  await send(page, {
    action: 'open',
    instanceId: 'browser',
    surface: 'browser',
    prominence: 'primary',
    payload: { title: 'Documentation', url: 'https://example.com/' },
  });
  await expect(
    page.getByText('Embedded browsing requires the native desktop.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await send(page, {
    action: 'open',
    instanceId: 'agents',
    surface: 'workflow',
    prominence: 'secondary',
    payload: { title: 'Observed agents', agentId: 'unobserved-designer' },
  });
  await expect(page.locator('[data-instance-id=agents]')).toContainText(
    /unavailable|unobserved|No observed/i,
  );
  await page.screenshot({
    path: join(workspaceRoot, 'artifacts/workspace/narrow-fallback.png'),
  });
});

test('layout commands have bounded frame latency during repeated edits', async ({
  page,
}) => {
  await send(page, text('plan'));
  await send(page, text('reference'));
  const measurement = await page.evaluate(async () => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing root');
    const app = (
      window as unknown as {
        ng: {
          getComponent(element: Element): {
            experience: { present(command: unknown): unknown };
            view(): { stage(): { nextCommandId(): number } };
          };
        };
      }
    ).ng.getComponent(root);
    const latencies: number[] = [],
      frames: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 90; i++) {
      const start = performance.now();
      app.experience.present({
        contractVersion: 1,
        commandId: app.view().stage().nextCommandId(),
        action: 'resize',
        instanceId: 'plan',
        percent: 40 + (i % 30),
      });
      latencies.push(performance.now() - start);
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    const percentile = (values: number[], p: number) =>
      [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
    const memory =
      (performance as Performance & { memory?: { usedJSHeapSize: number } })
        .memory?.usedJSHeapSize ?? null;
    return {
      operations: latencies.length,
      commandP95Ms: percentile(latencies, 0.95),
      frameP95Ms: percentile(frames, 0.95),
      maxCommandMs: Math.max(...latencies),
      usedJsHeapBytes: memory,
    };
  });
  expect(measurement.commandP95Ms).toBeLessThan(50);
  mkdirSync(join(workspaceRoot, 'artifacts/workspace'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'artifacts/workspace/performance.json'),
    JSON.stringify(measurement, null, 2),
  );
  await test.info().attach('workspace-performance', {
    body: JSON.stringify(measurement, null, 2),
    contentType: 'application/json',
  });
});
