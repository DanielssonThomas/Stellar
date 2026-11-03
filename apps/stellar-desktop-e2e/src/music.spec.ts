import { expect, test } from '@playwright/test';
import type { IvySnapshot } from '@stellar/desktop-contracts';

test('P opens local music controls, adjusts bands, preserves floats and neutralizes for activity', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const calls: boolean[] = [];
    let sequence = 0;
    const frame = (level: number, status = 'capturing') => ({
      version: 1,
      sequence: String(++sequence),
      status,
      levels: { level, bass: level, mid: level, treble: level },
    });
    const ivy: IvySnapshot = {
      version: 1,
      revision: '1',
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
    };
    Object.assign(window, {
      __musicFixture: {
        calls,
        pulse: (value: number) =>
          callbacks.get('stellar://music')?.({ payload: frame(value) }),
      },
      __TAURI__: {
        event: {
          listen: async (
            event: string,
            callback: (value: { payload: unknown }) => void,
          ) => {
            callbacks.set(event, callback);
            return () => callbacks.delete(event);
          },
        },
        core: {
          invoke: async (
            command: string,
            args: { request: Record<string, unknown> },
          ) => {
            if (command === 'music_set_enabled') {
              calls.push(args.request['enabled'] === true);
              return frame(0, args.request['enabled'] ? 'starting' : 'idle');
            }
            if (command === 'ivy_connect' || command === 'ivy_snapshot')
              return ivy;
            if (command === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'stellar-desktop',
                capabilities: [],
                build_revision: null,
              };
            if (command === 'speech_snapshot' || command === 'speech_stop')
              return {
                version: 1,
                revision: '0',
                epoch: '0',
                operation_id: null,
                state: 'idle',
                error: null,
              };
            throw new Error('Unexpected music fixture command');
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.artwork')).toHaveCount(81);
  const floats = () =>
    page
      .locator('.artwork')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAnimations()[0]?.startTime),
      );
  await expect
    .poll(
      async () =>
        (await floats()).filter((value) => value !== undefined).length,
    )
    .toBe(81);
  const initial = await floats();
  const pulse = (value: number) =>
    page.evaluate(
      (value) =>
        (
          window as unknown as {
            __musicFixture: { pulse(value: number): void };
          }
        ).__musicFixture.pulse(value),
      value,
    );
  const calls = () =>
    page.evaluate(
      () =>
        (window as unknown as { __musicFixture: { calls: boolean[] } })
          .__musicFixture.calls,
    );
  expect(await calls()).toEqual([]);
  await page.keyboard.press('p');
  const dialog = page.getByRole('dialog', { name: 'Music visualizer' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('slider')).toHaveCount(4);
  await dialog.getByRole('button', { name: 'Listen to desktop audio' }).click();
  await expect.poll(calls).toEqual([true]);
  await pulse(0.4);
  await expect(dialog.locator('p[role="status"]')).toHaveText(
    'Listening to desktop audio',
  );
  const bass = dialog.getByRole('slider', { name: 'Bass', exact: true });
  await bass.fill('200');
  await expect(dialog.locator('output[for="music-bass"]')).toHaveText('200%');
  await expect(
    dialog.getByRole('meter', { name: 'Bass level', exact: true }),
  ).toHaveAttribute('value', '0.8');
  expect(await floats()).toEqual(initial);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await pulse(0.8);
  const piece = page.locator('.music-piece').nth(1);
  await expect
    .poll(() =>
      piece.evaluate((element) => (element as HTMLElement).style.transform),
    )
    .not.toBe('none');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  const draft = page.getByRole('textbox', { name: 'Message Ivy' });
  await draft.fill('p');
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Start activity', exact: true })
    .click();
  await expect
    .poll(() =>
      piece.evaluate((element) => (element as HTMLElement).style.transform),
    )
    .toBe('none');
  await page.getByRole('button', { name: 'End activity', exact: true }).click();
  await page
    .getByRole('button', { name: 'Music visualizer · P', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Stop listening' }).click();
  await expect.poll(calls).toEqual([true, false]);
});

test('browser preview offers a controlled unavailable state without microphone permission', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('p');
  const dialog = page.getByRole('dialog', { name: 'Music visualizer' });
  await dialog.getByRole('button', { name: 'Listen to desktop audio' }).click();
  await expect(dialog.locator('p[role="status"]')).toContainText(
    'Desktop audio unavailable',
  );
  await expect(
    dialog.getByRole('button', { name: 'Listen to desktop audio' }),
  ).toBeVisible();
});
