import { expect, test } from '@playwright/test';
import { openPane } from './stage-driver';

test('shows truthful awareness state, captures workspace and fences pre-pause events', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let revision = 0;
    let enabled = true;
    const listeners = new Map<
      string,
      Set<(event: { payload: unknown }) => void>
    >();
    const workspaces: unknown[] = [];
    const frame = () => ({
      version: 1,
      revision: String(++revision),
      enabled,
      app_health: enabled ? 'available' : 'paused',
      media_health: enabled ? 'available' : 'paused',
      media_observed_at_ms: enabled ? String(Date.now()) : null,
      foreground: enabled
        ? {
            app: 'game.exe',
            title: 'Racing game',
            observed_at_ms: String(Date.now()),
          }
        : null,
      last_external: null,
      spotify: enabled
        ? {
            title: 'Track',
            artist: 'Artist',
            playing: true,
            observed_at_ms: String(Date.now()),
          }
        : null,
      workspace: null,
    });
    const ivy = () => ({
      version: 1,
      revision: String(++revision),
      turn_id: null,
      model: 'terra',
      verified_model: null,
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      reset_id: null,
      activity: [],
      connection: 'ready',
      turn: 'idle',
      items: [],
      error: null,
    });
    Object.assign(window, {
      __awarenessFixture: {
        workspaces,
        stale: () =>
          listeners
            .get('stellar://awareness')
            ?.forEach((listener) =>
              listener({ payload: { ...frame(), revision: '0' } }),
            ),
      },
      __TAURI__: {
        event: {
          listen: async (
            name: string,
            callback: (event: { payload: unknown }) => void,
          ) => {
            const group = listeners.get(name) ?? new Set();
            group.add(callback);
            listeners.set(name, group);
            return () => group.delete(callback);
          },
        },
        core: {
          invoke: async (
            command: string,
            args?: { request?: Record<string, unknown> },
          ) => {
            if (command === 'awareness_snapshot') return frame();
            if (command === 'awareness_set_enabled') {
              enabled = args?.request?.['enabled'] === true;
              return frame();
            }
            if (command === 'awareness_workspace') {
              workspaces.push(args?.request);
              return;
            }
            if (
              command === 'ivy_connect' ||
              command === 'ivy_snapshot' ||
              command === 'ivy_select_session'
            )
              return ivy();
            if (command === 'app_info')
              return {
                version: 1,
                sequence: args?.request?.['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (command === 'reflex_status')
              return { version: 1, configured: false };
            throw 'unavailable';
          },
        },
      },
    });
  });
  await page.goto('/');
  await page.keyboard.press('m');
  const control = page.getByRole('switch', { name: 'Ivy awareness' });
  await expect(control).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ivy-awareness-status')).toHaveText(
    'App awareness active · Spotify playing',
  );
  await page.keyboard.press('Escape');
  await openPane(
    page,
    101,
    'awareness-pane',
    'Current issue',
    'Synthetic content',
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __awarenessFixture: {
              workspaces: Array<{ panes: Array<{ title: string }> }>;
            };
          }
        ).__awarenessFixture.workspaces.some((workspace) =>
          workspace.panes.some((pane) => pane.title === 'Current issue'),
        ),
      ),
    )
    .toBe(true);
  await page.keyboard.press('m');
  await control.click();
  await expect(control).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#ivy-awareness-status')).toHaveText(
    'Awareness paused',
  );
  await page.evaluate(() =>
    (
      window as unknown as { __awarenessFixture: { stale(): void } }
    ).__awarenessFixture.stale(),
  );
  await expect(control).toHaveAttribute('aria-checked', 'false');
  await control.click();
  await expect(control).toHaveAttribute('aria-checked', 'true');
});
