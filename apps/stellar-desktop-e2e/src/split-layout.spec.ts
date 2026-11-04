import { test, expect, type Page } from '@playwright/test';
import type { WorkspaceLayoutNode } from '@stellar/desktop-contracts';

async function send(page: Page, operation: object) {
  return page.evaluate((operation) => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing root');
    const app = (
      window as unknown as {
        ng: {
          getComponent(element: Element): {
            experience: { present(command: unknown): { status: string } };
            view(): { stage(): { nextCommandId(): number } };
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
const settle = (page: Page) =>
  page.evaluate(async () => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing root');
    const stage = (
      window as unknown as {
        ng: {
          getComponent(element: Element): {
            view(): {
              stage(): {
                settlePresentations(current: () => boolean): Promise<void>;
              };
            };
          };
        };
      }
    ).ng
      .getComponent(root)
      .view()
      .stage();
    await stage.settlePresentations(() => true);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
const pane = (instance_id: string): WorkspaceLayoutNode => ({
  kind: 'pane',
  instance_id,
});
const rows = (prefix: string): WorkspaceLayoutNode => ({
  kind: 'split',
  split_id: prefix,
  axis: 'horizontal',
  percent: 33,
  equal_panes: true,
  first: pane(prefix + '1'),
  second: {
    kind: 'split',
    split_id: prefix + 'rest',
    axis: 'horizontal',
    percent: 50,
    first: pane(prefix + '2'),
    second: pane(prefix + '3'),
  },
});

test('six readable panes preserve content through targeted movement, resizing and viewport changes', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  for (const id of ['left1', 'left2', 'left3', 'right1', 'right2', 'right3']) {
    expect(
      (
        await send(page, {
          action: 'open',
          instanceId: id,
          surface: 'rich-text',
          prominence: 'secondary',
          payload: {
            typography: {
              family: id === 'left1' ? 'serif' : 'sans',
              fontSize: 18,
            },
            blocks: [
              {
                kind: 'markdown',
                text: `# ${id}\n\n## Details\n\n**Bold** and *italic* with \`inline code\`.\n\n- Retained contents\n- Readable layout\n\n\`\`\`ts\nconst pane = "${id}";\n\`\`\``,
              },
            ],
          },
        })
      ).status,
    ).toBe('applied');
  }
  const tree: WorkspaceLayoutNode = {
    kind: 'split',
    split_id: 'main',
    axis: 'vertical',
    percent: 50,
    first: rows('left'),
    second: rows('right'),
  };
  expect((await send(page, { action: 'set-layout', tree })).status).toBe(
    'applied',
  );
  const first = page.locator('[data-instance-id=left1]');
  await expect(first.locator('h1')).toHaveText('left1');
  await expect(first.locator('strong')).toHaveCSS('font-weight', '700');
  await expect(first.locator('em')).toHaveCSS('font-style', 'italic');
  await first.locator('article').evaluate((element) => {
    element.dataset['retained'] = 'yes';
  });
  await expect(page.locator('.surface')).toHaveCount(6);
  await settle(page);
  await page.screenshot({
    path: info.outputPath('six-pane-layout.png'),
    animations: 'disabled',
  });
  expect(
    (
      await send(page, {
        action: 'split-pane',
        instanceId: 'right1',
        otherId: 'left1',
        splitId: 'moved',
        placement: 'below',
      })
    ).status,
  ).toBe('applied');
  await expect(first.locator('article')).toHaveAttribute(
    'data-retained',
    'yes',
  );
  expect(
    (await send(page, { action: 'resize-split', splitId: 'main', percent: 65 }))
      .status,
  ).toBe('applied');
  expect(
    (await send(page, { action: 'resize-split', splitId: 'main', percent: 50 }))
      .status,
  ).toBe('applied');
  await page.setViewportSize({ width: 420, height: 350 });
  const boxes = await page.locator('.surface').evaluateAll((elements) =>
    elements.map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(280);
    expect(box.height).toBeGreaterThanOrEqual(180);
  }
  await expect(first.locator('article')).toHaveAttribute(
    'data-retained',
    'yes',
  );
});

test('headerless browser uses the whole pane with no emblem clearance', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  expect(
    (
      await send(page, {
        action: 'open',
        instanceId: 'web',
        surface: 'browser',
        prominence: 'primary',
        payload: { url: 'https://example.com/', chrome: false },
      })
    ).status,
  ).toBe('applied');
  const panel = page.locator('[data-instance-id=web]');
  await expect(panel.locator('h2')).toHaveCount(0);
  await expect(
    panel.getByRole('navigation', { name: 'Browser controls' }),
  ).toHaveCount(0);
  const geometry = await panel.evaluate((element) => {
    const panel = element.getBoundingClientRect(),
      browser = element.querySelector('.browser-body')?.getBoundingClientRect();
    if (!browser) throw Error('Missing browser');
    return [
      panel.x,
      panel.y,
      panel.width,
      panel.height,
      browser.x,
      browser.y,
      browser.width,
      browser.height,
    ];
  });
  expect(geometry.slice(4)).toEqual(geometry.slice(0, 4));
  await expect(page.locator('.emblem-slot')).toHaveCSS('position', 'absolute');
  await settle(page);
  await page.screenshot({
    path: info.outputPath('full-pane-browser.png'),
    animations: 'disabled',
  });
});
