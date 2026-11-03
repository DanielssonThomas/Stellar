import { expect, test } from '@playwright/test';
import type { IvyPresentation, IvySnapshot } from '@stellar/desktop-contracts';
import { controlPane } from './stage-driver';

type ResponseFixture = {
  complete(items: IvyPresentation[]): void;
  snapshotRead: boolean;
};

test('waiting restores full presence, long content scrolls intact and Ivy closes minimized activity once', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let revision = 0;
    let inputId: string | null = null;
    let notify: (event: { payload: unknown }) => void = () => undefined;
    const snapshot = (
      turn: IvySnapshot['turn'],
      items: IvyPresentation[] = [],
    ): IvySnapshot => ({
      version: 1,
      revision: String(++revision),
      connection: 'ready',
      turn,
      turn_id: inputId,
      model: 'terra',
      verified_model: null,
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      reset_id: null,
      activity: [],
      items,
      error: null,
    });
    Object.assign(window, {
      __responseFixture: {
        snapshotRead: false,
        complete: (items: IvyPresentation[]) =>
          notify({ payload: snapshot('completed', items) }),
      },
      __TAURI__: {
        event: {
          listen: async (
            name: string,
            callback: (event: { payload: unknown }) => void,
          ) => {
            if (name === 'ivy-state') notify = callback;
            return () => undefined;
          },
        },
        core: {
          invoke: async (
            name: string,
            args: { request: Record<string, unknown> },
          ) => {
            if (name === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (name === 'ivy_snapshot') {
              (
                window as unknown as { __responseFixture: ResponseFixture }
              ).__responseFixture.snapshotRead = true;
              return snapshot('idle');
            }
            if (name === 'ivy_connect') return snapshot('idle');
            if (name === 'ivy_submit') {
              inputId = String(args.request['input_id']);
              return snapshot('admitted');
            }
            throw new Error('Unexpected response fixture command');
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __responseFixture: ResponseFixture })
            .__responseFixture.snapshotRead,
      ),
    )
    .toBe(true);
  await expect(
    page.getByText(
      'Conversation state unavailable. Refresh before voice resumes.',
    ),
  ).toHaveCount(0);
  const menu = page.getByRole('button', {
    name: 'Experience menu',
    exact: true,
  });
  await menu.click();
  await page.getByLabel('Reduce motion').check();
  await page
    .getByLabel('Message Ivy', { exact: true })
    .fill('Show all of this content');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.waiting-ring')).toBeVisible();
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '0.68');
  await expect(page.locator('.waiting-ring')).toHaveCSS(
    'animation-play-state',
    'paused',
  );
  const selectAppearance = (model: 'terra' | 'sol') =>
    page.evaluate((model) => {
      const root = document.querySelector('stellar-root');
      if (!root) throw new Error('Missing application');
      const debug = window as unknown as {
        ng: {
          getComponent(element: Element): {
            voice: { setModel(model: 'terra' | 'sol'): void };
          };
        };
      };
      debug.ng.getComponent(root).voice.setModel(model);
    }, model);
  await selectAppearance('sol');
  await expect(page.locator('.sol-ring')).toHaveCount(1);
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '1');
  await expect(page.locator('.camera')).toHaveCSS('opacity', '0.68');
  const redStroke = await page
    .locator('.sol-ring')
    .evaluate((element) => parseFloat(getComputedStyle(element).strokeWidth));
  expect(redStroke).toBeGreaterThanOrEqual(15);
  expect(redStroke).toBeLessThanOrEqual(19);
  await selectAppearance('terra');
  await expect(page.locator('.sol-ring')).toHaveCount(0);
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '0.68');
  const body =
    '🪐 <script>literal</script> "\\\n'.repeat(10000) + 'COMPLETE END';
  await page.evaluate((body) => {
    (
      window as unknown as { __responseFixture: ResponseFixture }
    ).__responseFixture.complete([
      { kind: 'text', text: 'All requested content' },
      {
        kind: 'component',
        component: 'assistant_message',
        title: 'Long requested content',
        body,
      },
    ]);
  }, body);
  const panel = page.getByRole('region', { name: 'Assistant message' });
  const content = panel.locator('.surface-content');
  await expect(panel).toBeVisible();
  await expect(page.locator('.waiting-ring')).toHaveCount(0);
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '1');
  await expect(panel.locator('article p')).toHaveJSProperty(
    'textContent',
    body,
  );
  await expect(panel.locator('script')).toHaveCount(0);
  expect(
    await content.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(
    await content.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await controlPane(
    page,
    'minimize',
    (await panel.getAttribute('data-instance-id')) ?? '',
  );
  await menu.click();
  await page
    .getByLabel('Message Ivy', { exact: true })
    .fill('Close this activity');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.waiting-ring')).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __responseFixture: ResponseFixture }
    ).__responseFixture.complete([
      { kind: 'text', text: 'Closed' },
      { kind: 'close_activity' },
    ]),
  );
  await expect(
    page.getByRole('button', { name: 'Show content', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.waiting-ring')).toHaveCount(0);
  await expect(page.locator('[data-instance-id]')).toHaveCount(0);
});
