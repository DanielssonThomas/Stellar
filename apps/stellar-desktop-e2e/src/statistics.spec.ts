import { expect, test, type Page } from '@playwright/test';

// These are deterministic test observations, never claimed as account telemetry.
const stats = {
  title: 'Fixture statistics',
  source: 'Deterministic browser fixture (not account telemetry)',
  period: 'Fixture observation window A',
  state: 'ready',
  coverage: 'partial',
  freshness: 'stale',
  chartType: 'bar',
  metrics: [
    { name: 'Unobserved', value: null, unit: 'tokens' },
    { name: 'Observed zero', value: 0, unit: 'tokens' },
    {
      name: 'Recorded',
      value: 5,
      unit: 'tokens',
      comparison: {
        value: 2,
        period: 'Fixture window B',
        source: 'Deterministic comparison fixture',
      },
    },
  ],
};
const payload = (statistics: unknown) => ({
  title: 'Statistical report',
  blocks: [
    {
      kind: 'paragraph',
      text: 'Existing text remains literal: <script>not executable</script>',
    },
    { kind: 'statistics', statistics },
  ],
});
const present = (page: Page, command: Record<string, unknown>) =>
  page.evaluate((command) => {
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Missing root');
    const app = (
      window as unknown as {
        ng: {
          getComponent(el: Element): {
            experience: { present(command: unknown): { status: string } };
          };
        };
      }
    ).ng.getComponent(root);
    return app.experience.present({
      contractVersion: 1,
      instanceId: 'statistics',
      ...(command['action'] === 'close' ? {} : { surface: 'rich-text' }),
      ...command,
    }).status;
  }, command);

for (const width of [1600, 520]) {
  test(`statistical workspace at ${width}px supports states, updates, resize and reduced motion`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('stellar-root')).toHaveAttribute(
      'data-desktop-ready',
      'true',
    );
    expect(
      await present(page, {
        commandId: 1,
        action: 'open',
        prominence: 'primary',
        payload: payload(stats),
      }),
    ).toBe('applied');
    const pane = page.locator('[data-instance-id="statistics"]');
    const card = pane.getByRole('region', { name: 'Statistical card' });
    await expect(card).toContainText('Unknown tokens');
    await expect(card).toContainText('0 tokens');
    await expect(card).toContainText('Partial coverage');
    await expect(card).toContainText('Stale data');
    await expect(card).toContainText(stats.source);
    await expect(card).toContainText(stats.period);
    await expect(card).toContainText('Deterministic comparison fixture');
    await expect(pane.locator('script')).toHaveCount(0);
    const chart = card.locator('stellar-presentation-chart-atom');
    await expect(chart).toHaveAttribute('data-render-state', 'ready');
    await expect(chart.locator('table')).toContainText('Observed zero');
    await expect(chart.locator('table')).not.toContainText('Unobserved');
    expect(
      await card
        .locator('dl')
        .evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
        ),
    ).toBe(width === 1600 ? 3 : 1);
    expect(
      await chart.locator('canvas').evaluate((canvas) => {
        const el = canvas as HTMLCanvasElement;
        const context = el.getContext('2d');
        if (!context) throw Error('No canvas context');
        return context
          .getImageData(0, 0, el.width, el.height)
          .data.some((value, index) => index % 4 === 3 && value > 0);
      }),
    ).toBe(true);
    await pane.screenshot({
      path: info.outputPath(`statistics-${width}.png`),
      animations: 'disabled',
    });
    for (const [index, chartType] of ['line', 'doughnut'].entries()) {
      expect(
        await present(page, {
          commandId: index + 2,
          action: 'update',
          payload: payload({ ...stats, chartType }),
        }),
      ).toBe('applied');
      await expect(chart).toHaveAttribute('data-render-state', 'ready');
      await expect(
        card.getByRole('heading', { name: stats.title }),
      ).toBeVisible();
    }
    const before = await chart.locator('canvas').boundingBox();
    await page.setViewportSize({
      width: width === 1600 ? 1000 : 720,
      height: 1000,
    });
    await expect
      .poll(async () => (await chart.locator('canvas').boundingBox())?.width)
      .not.toBe(before?.width);
    await expect
      .poll(() => card.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    for (const [index, state] of ['loading', 'error'].entries()) {
      expect(
        await present(page, {
          commandId: index + 4,
          action: 'update',
          payload: payload({ ...stats, state, metrics: [] }),
        }),
      ).toBe('applied');
      await expect(card).toHaveAttribute('data-state', state);
      await expect(card.locator('canvas')).toHaveCount(0);
      await expect(card.locator('dd')).toHaveCount(0);
    }
    await expect(card).toContainText('Retrieval failed');
    expect(
      await present(page, {
        commandId: 6,
        action: 'update',
        payload: payload({ ...stats, metrics: [] }),
      }),
    ).toBe('applied');
    await expect(card).toContainText('No observations');
    expect(
      await present(page, {
        commandId: 7,
        action: 'update',
        payload: payload({ ...stats, source: '' }),
      }),
    ).toBe('rejected');
    await expect(card).toContainText('No observations');
    expect(
      await present(page, {
        commandId: 8,
        action: 'update',
        payload: payload({
          ...stats,
          coverage: 'complete',
          freshness: 'current',
        }),
      }),
    ).toBe('applied');
    await expect(card).toContainText('Complete coverage');
    await expect(card).not.toContainText('Stale data');
    await expect(chart).toHaveAttribute('data-render-state', 'ready');
    expect(await present(page, { commandId: 9, action: 'close' })).toBe(
      'applied',
    );
    await expect(pane).toHaveCount(0);
  });
}

test('statistical composition uses the same validated spatial detail path and disposes on collapse', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
  const score = {
    begin: { title: 'Statistical scene', label: 'Deterministic fixture' },
    prepare: [
      {
        kind: 'show',
        panel: {
          id: 'stats',
          title: 'Statistical panel',
          category: 'Statistics',
          summary: 'Fixture observations only',
          detail: { surface: 'rich-text', payload: payload(stats) },
        },
      },
      { kind: 'focus', id: 'stats' },
      { kind: 'expand', id: 'stats' },
    ],
  };
  expect(
    await page.evaluate((score) => {
      const root = document.querySelector('stellar-root');
      if (!root) throw Error('Missing root');
      const app = (
        window as unknown as {
          ng: {
            getComponent(el: Element): {
              spatial: { accept(request: unknown): boolean };
            };
          };
        }
      ).ng.getComponent(root);
      return app.spatial.accept({
        epoch: '1',
        turn_id: crypto.randomUUID(),
        operation: { kind: 'present', score_json: JSON.stringify(score) },
      });
    }, score),
  ).toBe(true);
  const panel = page.locator('[data-panel-id="stats"]');
  await expect(
    panel.getByRole('region', { name: 'Statistical card' }),
  ).toContainText('Unknown tokens');
  await expect(
    panel.locator('stellar-presentation-chart-atom'),
  ).toHaveAttribute('data-render-state', 'ready');
  await panel
    .getByRole('button', { name: 'Statistical panel', exact: true })
    .click();
  await expect(panel.locator('canvas')).toHaveCount(0);
  await panel
    .getByRole('button', { name: 'Statistical panel', exact: true })
    .click();
  await expect(
    panel.locator('stellar-presentation-chart-atom'),
  ).toHaveAttribute('data-render-state', 'ready');
});
