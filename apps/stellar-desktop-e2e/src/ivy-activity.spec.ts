import { expect, test, type Page } from '@playwright/test';
import type { IvyActivity, IvySnapshot } from '@stellar/desktop-contracts';
import { openPane, controlPane } from './stage-driver';

interface ActivityFixture {
  publish(
    turn: IvySnapshot['turn'],
    actions?: IvyActivity[],
    stale?: boolean,
  ): void;
  commands: string[];
  failReload: boolean;
}
type App = {
  voice: {
    setDraft(text: string): void;
    state(): { passive: boolean };
    composition(): { raw: string; status: string; model: string };
    conversation: {
      generation: number;
      recognize(text: string, id: string, generation: number): Promise<void>;
    };
  };
};
const row: IvyActivity = {
  id: '0123456789abcdef',
  kind: 'shell',
  state: 'running',
};

async function install(page: Page) {
  await page.addInitScript(() => {
    let revision = 0;
    let notify: (event: { payload: unknown }) => void = () => undefined;
    let turnId: string | null = null;
    let resetId: string | null = null;
    const snapshot = (
      turn: IvySnapshot['turn'],
      activity: IvyActivity[] = [],
    ): IvySnapshot => ({
      version: 1,
      revision: String(++revision),
      model: 'sol',
      verified_model: null,
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      reset_id: resetId,
      turn_id: turnId,
      connection: 'ready',
      turn,
      activity,
      items: [],
      error: null,
    });
    const fixture: ActivityFixture = {
      commands: [],
      failReload: false,
      publish(turn, activity = [], stale = false) {
        turnId ??= crypto.randomUUID();
        const state = snapshot(turn, activity);
        if (stale) state.revision = '0';
        notify({ payload: state });
      },
    };
    Object.assign(window, {
      __activityFixture: fixture,
      __TAURI__: {
        event: {
          listen: async (name: string, callback: typeof notify) => {
            if (name === 'ivy-state') notify = callback;
            return () => undefined;
          },
        },
        core: {
          invoke: async (
            name: string,
            args: { request: Record<string, unknown> },
          ) => {
            fixture.commands.push(name);
            if (name === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (name === 'ivy_connect' || name === 'ivy_snapshot')
              return snapshot('idle');
            if (name === 'ivy_new_session') {
              resetId = 'stellar-new-confirmed';
              turnId = null;
              return snapshot('idle');
            }
            if (name === 'ivy_reload_mcp') {
              if (fixture.failReload) throw 'unavailable';
              return snapshot('idle');
            }
            if (name === 'ivy_cancel') return snapshot('cancelled');
            if (name === 'speech_stop' || name === 'speech_snapshot')
              return {
                version: 1,
                revision: '1',
                operation_id: null,
                state: 'idle',
                error: null,
              };
            throw new Error('Unexpected activity fixture command');
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(
    page.locator('stellar-emblem-motion-molecule .emblem'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __activityFixture: ActivityFixture }
        ).__activityFixture.commands.includes('ivy_snapshot'),
      ),
    )
    .toBe(true);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Missing viewport');
  const size = Math.min(480, viewport.width - 48, viewport.height - 48);
  await expect
    .poll(async () => (await page.locator('.emblem-slot').boundingBox())?.width)
    .toBe(size);
}
const publish = (
  page: Page,
  turn: IvySnapshot['turn'],
  actions: IvyActivity[] = [],
  stale = false,
) =>
  page.evaluate(
    ({ turn, actions, stale }) =>
      (
        window as unknown as { __activityFixture: ActivityFixture }
      ).__activityFixture.publish(turn, actions, stale),
    { turn, actions, stale },
  );
const say = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const root = document.querySelector('stellar-root');
    if (!root) throw new Error('Missing app');
    const app = (
      window as unknown as { ng: { getComponent(node: Element): App } }
    ).ng.getComponent(root);
    await app.voice.conversation.recognize(
      text,
      crypto.randomUUID(),
      app.voice.conversation.generation,
    );
  }, text);

test('short requests remain quiet and elapsed time never invents tool activity', async ({
  page,
}) => {
  await install(page);
  await page.clock.install();
  await publish(page, 'admitted');
  await page.clock.runFor(2000);
  await publish(page, 'completed');
  await page.clock.runFor(6000);
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
  await publish(page, 'admitted');
  await page.clock.runFor(5100);
  await expect(page.getByRole('region', { name: 'Ivy actions' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('status').filter({ hasText: /^Working$/ }),
  ).toBeVisible();
  await publish(page, 'cancelled');
  await page.clock.runFor(300);
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
});

test('rapid real actions preserve emblem geometry and stale snapshots cannot reopen panels', async ({
  page,
}, testInfo) => {
  await install(page);
  await publish(page, 'admitted');
  const emblem = page.locator('.emblem-slot');
  const before = await emblem.boundingBox();
  await publish(page, 'admitted', [row]);
  await expect(page.getByLabel('Ivy actions')).toBeVisible();
  const after = await emblem.boundingBox();
  expect(after).toEqual(before);
  for (let i = 0; i < 12; i++)
    await publish(page, 'admitted', [
      { ...row, state: i === 11 ? 'failed' : 'running' },
    ]);
  await expect(page.locator('.action-state')).toHaveText('failed');
  await expect(page.locator('.activity-overlay')).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: testInfo.outputPath('ivy-activity-desktop.png'),
  });
  await publish(page, 'completed');
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
  await publish(page, 'admitted', [row], true);
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
  expect(await emblem.boundingBox()).toEqual(before);
});

test('activity is absent throughout presentation transitions and returns without moving the emblem', async ({
  page,
}) => {
  await install(page);
  await publish(page, 'admitted', [row]);
  await expect(page.getByLabel('Ivy actions')).toBeVisible();
  await openPane(
    page,
    1000,
    'requested-content',
    'Reference',
    'Presentation content',
  );
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
  await controlPane(page, 'close');
  await expect(page.getByLabel('Ivy actions')).toBeVisible();
  await publish(page, 'completed');
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
});

test('new session clears foreground views, preserves Sol and waits passively for Ivy', async ({
  page,
}) => {
  await install(page);
  await openPane(
    page,
    1000,
    'requested-content',
    'Old session',
    'Old presentation',
  );
  await say(page, 'prompt');
  await say(page, 'unsent draft');
  await say(page, 'new session');
  await expect(
    page.getByText('New session. Say Ivy.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.surface')).toHaveCount(0);
  await expect(page.locator('[data-ivy-activity]')).toHaveCount(0);
  await expect(page.locator('.emblem.idle-motion')).toBeVisible();
  await say(page, 'ambient chatter');
  await say(page, 'Ivy');
  const commands = await page.evaluate(
    () =>
      (window as unknown as { __activityFixture: ActivityFixture })
        .__activityFixture.commands,
  );
  expect(commands.filter((name) => name === 'ivy_new_session')).toHaveLength(1);
  expect(commands).not.toContain('ivy_clear_conversation');
  expect(commands).not.toContain('ivy_submit');
});

test('reload MCP confirms supported success and reports failures without clearing the session', async ({
  page,
}) => {
  await install(page);
  await say(page, 'reload mcp');
  await expect(
    page.getByText('MCP integrations reloaded.', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __activityFixture: ActivityFixture }
    ).__activityFixture.failReload = true;
  });
  await say(page, 'reload mcp');
  await expect(
    page.getByText(
      'MCP reload failed or is unsupported. Conversation preserved.',
      { exact: true },
    ),
  ).toBeVisible();
  const commands = await page.evaluate(
    () =>
      (window as unknown as { __activityFixture: ActivityFixture })
        .__activityFixture.commands,
  );
  expect(commands).not.toContain('ivy_new_session');
  expect(commands).not.toContain('ivy_clear_conversation');
});

test('compact panels stay within the window without resizing the emblem', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await install(page);
  await publish(page, 'admitted');
  const before = await page.locator('.emblem-slot').boundingBox();
  await publish(page, 'admitted', [row]);
  await expect(page.getByLabel('Ivy actions')).toBeVisible();
  for (const panel of await page.locator('.activity-panel').all()) {
    const bounds = await panel.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(480);
  }
  expect(await page.locator('.emblem-slot').boundingBox()).toEqual(before);
});
