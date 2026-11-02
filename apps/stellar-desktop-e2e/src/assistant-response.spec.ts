import { expect, test } from '@playwright/test';
import type { IvyPresentation, IvySnapshot } from '@stellar/desktop-contracts';

type ResponseFixture = {
  complete(items: IvyPresentation[]): void;
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
      items,
      error: null,
    });
    Object.assign(window, {
      __responseFixture: {
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
  await expect(panel).toBeVisible();
  await expect(page.locator('.waiting-ring')).toHaveCount(0);
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '1');
  await expect(panel.locator('article p')).toHaveJSProperty(
    'textContent',
    body,
  );
  await expect(panel.locator('script')).toHaveCount(0);
  expect(
    await panel.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Minimize Assistant message', exact: true })
    .click();
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
