import { expect, test, type Page } from '@playwright/test';
import type { IvySnapshot } from '@stellar/desktop-contracts';

interface InspectorFixture {
  calls: { command: string; request: Record<string, unknown> }[];
  busy: boolean;
  unavailable: boolean;
  invalid: boolean;
  active: string;
  publishBusy(): void;
}

async function install(page: Page) {
  await page.addInitScript(() => {
    let revision = 0;
    let notify: (event: { payload: unknown }) => void = () => undefined;
    const fixture: InspectorFixture = {
      calls: [],
      busy: false,
      unavailable: false,
      invalid: false,
      active: 'current-ivy-session',
      publishBusy() {
        this.busy = true;
        notify({ payload: assistant() });
      },
    };
    const assistant = (): IvySnapshot => ({
      version: 1,
      revision: String(++revision),
      turn_id: fixture.busy ? '00000000-0000-4000-8000-000000000001' : null,
      model: 'terra',
      verified_model: 'terra',
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      connection: 'ready',
      turn: fixture.busy ? 'admitted' : 'idle',
      activity: [],
      reset_id: null,
      items: [],
      error: null,
    });
    const inspect = (request: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const selected =
        typeof request['session_id'] === 'string'
          ? request['session_id']
          : fixture.active;
      const result = {
        version: 1,
        observed_at: now,
        active_session_id: fixture.active,
        active_stored_session_id: fixture.active,
        selected_session_id: selected,
        history_available: true,
        sessions: [
          {
            id: fixture.active,
            title: 'Current issue discussion',
            model: 'gpt-6.1-terra',
            started_at: now,
            last_activity_at: now,
            message_count: 4,
          },
          {
            id: 'older-ivy-session',
            title: 'Earlier music discussion',
            model: 'gpt-6.1-sol',
            started_at: '2026-11-01T10:00:00Z',
            last_activity_at: '2026-11-01T10:15:00Z',
            message_count: 2,
          },
        ],
        next_offset: null,
        messages: [
          {
            id: 1,
            role: 'user',
            text:
              selected === 'older-ivy-session'
                ? 'Find my racing playlist.'
                : 'Check the current issue.',
            at: now,
          },
          {
            id: 2,
            role: 'assistant',
            text:
              selected === 'older-ivy-session'
                ? 'Here is your racing playlist.'
                : 'The current issue is ready for review.',
            at: now,
          },
        ],
        next_before: null,
        context: {
          observed_at: now,
          used: 24000,
          limit: 128000,
          compactions: 1,
        },
        account: {
          state: 'available',
          observed_at: now,
          windows: [
            {
              label: 'Five-hour allowance',
              used_percent: 25,
              reset_at: new Date(Date.now() + 3600000).toISOString(),
              scope: 'account',
            },
          ],
        },
      };
      return fixture.invalid
        ? { ...result, context: { ...result.context, used: 999999 } }
        : result;
    };
    Object.assign(window, {
      __inspectorFixture: fixture,
      __TAURI__: {
        event: {
          listen: async (name: string, callback: typeof notify) => {
            if (name === 'ivy-state') notify = callback;
            return () => undefined;
          },
        },
        core: {
          invoke: async (
            command: string,
            args?: { request?: Record<string, unknown> },
          ) => {
            const request = args?.request ?? {};
            fixture.calls.push({ command, request });
            if (command === 'app_info')
              return {
                version: 1,
                sequence: request['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (command === 'ivy_snapshot' || command === 'ivy_connect')
              return assistant();
            if (command === 'ivy_inspect') {
              if (fixture.unavailable) throw new Error('Inspector unavailable');
              return inspect(request);
            }
            if (command === 'ivy_new_session') {
              fixture.active = 'new-ivy-session';
              return { ...assistant(), reset_id: 'stellar-new-confirmed' };
            }
            if (command === 'speech_snapshot' || command === 'speech_stop')
              return {
                version: 1,
                revision: '1',
                epoch: '0',
                operation_id: null,
                state: 'idle',
                error: null,
              };
            throw new Error('Unsupported inspector fixture command');
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __inspectorFixture: InspectorFixture }
        ).__inspectorFixture.calls.some(
          (call) => call.command === 'ivy_snapshot',
        ),
      ),
    )
    .toBe(true);
}

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Ivy sessions' });
const calls = (page: Page, command: string) =>
  page.evaluate(
    (command) =>
      (
        window as unknown as { __inspectorFixture: InspectorFixture }
      ).__inspectorFixture.calls.filter((call) => call.command === command)
        .length,
    command,
  );

test('C shows real-shaped context, allowance and history without changing the active session', async ({
  page,
}, testInfo) => {
  await install(page);
  await page.keyboard.press('c');
  const panel = dialog(page);
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText('The current issue is ready for review.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/75%/)).toBeVisible();
  await expect(panel.getByText(/24[,.\s]?000/).first()).toBeVisible();
  const initial = await panel.boundingBox();
  await panel.getByRole('button', { name: /Earlier music discussion/ }).click();
  await expect(
    panel.getByText('Here is your racing playlist.', { exact: true }),
  ).toBeVisible();
  expect(await calls(page, 'ivy_new_session')).toBe(0);
  expect(await calls(page, 'ivy_select_session')).toBe(0);
  expect(await calls(page, 'ivy_submit')).toBe(0);
  const after = await panel.boundingBox();
  if (!after || !initial)
    throw new Error('Session inspector has no rendered bounds');
  expect(after.height).toBeCloseTo(initial.height, 1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __inspectorFixture: InspectorFixture })
          .__inspectorFixture.active,
    ),
  ).toBe('current-ivy-session');
  await page.screenshot({
    path: testInfo.outputPath('ivy-sessions-desktop.png'),
  });
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
});

test('session shortcut ignores typing and modifiers; busy work cannot be reset', async ({
  page,
}) => {
  await install(page);
  await page.keyboard.press('Control+c');
  await expect(dialog(page)).not.toBeVisible();
  const shifted = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'C',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(shifted).toBe(false);
  await expect(dialog(page)).not.toBeVisible();
  await page.keyboard.press('m');
  const input = page.getByLabel('Message Ivy', { exact: true });
  await input.fill('Ivy ');
  await input.press('c');
  await expect(input).toHaveValue('Ivy c');
  await expect(dialog(page)).not.toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    (
      window as unknown as { __inspectorFixture: InspectorFixture }
    ).__inspectorFixture.publishBusy(),
  );
  await page.keyboard.press('c');
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole('button', { name: 'New session', exact: true }),
  ).toBeDisabled();
  expect(await calls(page, 'ivy_new_session')).toBe(0);
});

test('unavailable and malformed inspector data remain explicit', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    (
      window as unknown as { __inspectorFixture: InspectorFixture }
    ).__inspectorFixture.unavailable = true;
  });
  await page.keyboard.press('c');
  await expect(
    dialog(page).getByText(/Session details unavailable/),
  ).toBeVisible();
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { __inspectorFixture: InspectorFixture }
    ).__inspectorFixture;
    fixture.unavailable = false;
    fixture.invalid = true;
  });
  await dialog(page)
    .getByRole('button', { name: /Refresh|Retry/ })
    .click();
  await expect(
    dialog(page).getByText(/Session details unavailable/),
  ).toBeVisible();
  await expect(dialog(page).getByText(/999[,.\s]?999/)).toHaveCount(0);
});

test('New session uses the existing guarded lifecycle exactly once', async ({
  page,
}) => {
  await install(page);
  await page.keyboard.press('c');
  const panel = dialog(page);
  await expect(
    panel.getByText('The current issue is ready for review.', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'New session', exact: true }).click();
  await expect.poll(() => calls(page, 'ivy_new_session')).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __inspectorFixture: InspectorFixture })
            .__inspectorFixture.active,
      ),
    )
    .toBe('new-ivy-session');
  expect(await calls(page, 'ivy_select_session')).toBe(0);
  expect(await calls(page, 'ivy_submit')).toBe(0);
});

test('compact session inspector stays within the viewport and closes with C', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page);
  await page.keyboard.press('c');
  const panel = dialog(page);
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText('The current issue is ready for review.', { exact: true }),
  ).toBeVisible();
  const box = await panel.boundingBox();
  if (!box) throw new Error('Session inspector has no rendered bounds');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: testInfo.outputPath('ivy-sessions-compact.png'),
  });
  await panel.getByRole('button', { name: 'Close Ivy sessions' }).focus();
  await page.keyboard.press('c');
  await expect(panel).not.toBeVisible();
});
