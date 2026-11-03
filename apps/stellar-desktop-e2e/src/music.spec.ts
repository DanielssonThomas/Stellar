import { expect, test } from '@playwright/test';
import type { IvySnapshot } from '@stellar/desktop-contracts';

test('P opens local music controls, adjusts bands, preserves floats and neutralizes for activity', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const calls: boolean[] = [];
    let sequence = 0;
    const frame = (
      level: number,
      status = 'capturing',
      tone: number | null = 69,
    ) => ({
      version: 1,
      sequence: String(++sequence),
      status,
      levels: { level, bass: level, mid: level, treble: level },
      tone: level > 0 ? tone : null,
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
        pulse: (value: number, tone?: number) =>
          callbacks.get('stellar://music')?.({
            payload: frame(value, 'capturing', tone),
          }),
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
              return frame(0, args.request['enabled'] ? 'capturing' : 'idle');
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
        (await floats()).filter((value) => typeof value === 'number').length,
    )
    .toBe(81);
  const initial = await floats();
  const pulse = (value: number, tone = 69) =>
    page.evaluate(
      ({ value, tone }) =>
        (
          window as unknown as {
            __musicFixture: { pulse(value: number, tone: number): void };
          }
        ).__musicFixture.pulse(value, tone),
      { value, tone },
    );
  const calls = () =>
    page.evaluate(
      () =>
        (window as unknown as { __musicFixture: { calls: boolean[] } })
          .__musicFixture.calls,
    );
  expect(await calls()).toEqual([]);
  await page.locator('stellar-desktop-experience-template').focus();
  await page.keyboard.press('p');
  const dialog = page.getByRole('dialog', { name: 'Music visualizer' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('slider')).toHaveCount(4);
  await expect(
    dialog.getByRole('button', { name: 'Dynamic', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Flashy', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Flashy', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Listen to desktop audio' }).click();
  await expect.poll(calls).toEqual([true]);
  await expect(dialog.locator('p[role="status"]')).toHaveText(
    'Listening to desktop audio',
  );
  await pulse(0.4);
  await expect(page.locator('.light-region')).toHaveCount(136);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.music-piece')].some(
      (element) => element.getAnimations().length > 0,
    ),
  );
  const pulseCounts = await page
    .locator('.music-piece')
    .evaluateAll((elements) => ({
      rings: elements.filter(
        (element) =>
          element.parentElement?.matches('.spin-counter, .spin-clockwise') &&
          element
            .getAnimations()
            .some((animation) =>
              animation.effect
                ?.getKeyframes()
                .some((frame) =>
                  String(frame.transform).includes('translate('),
                ),
            ),
      ).length,
      bassRings: elements.filter((element) =>
        element
          .getAnimations()
          .some((animation) =>
            animation.effect
              ?.getKeyframes()
              .some((frame) => String(frame.transform).startsWith('scale(')),
          ),
      ).length,
      blinks: [...document.querySelectorAll('.light-region')].filter(
        (element) =>
          element
            .getAnimations()
            .some((animation) =>
              animation.effect
                ?.getKeyframes()
                .some((frame) => frame.opacity === '1'),
            ),
      ).length,
    }));
  expect(pulseCounts.rings).toBe(6);
  expect(pulseCounts.bassRings).toBe(6);
  expect(pulseCounts.blinks).toBe(21);
  expect(
    await page.locator('.light-region').evaluateAll((regions) =>
      regions.every((region) => {
        const image = region.parentElement?.querySelector('img');
        return (
          image &&
          (region as HTMLElement).style.backgroundImage.includes(
            image.currentSrc,
          ) &&
          (region as HTMLElement).style.maskImage.includes('radial-gradient')
        );
      }),
    ),
  ).toBe(true);
  expect(
    await page
      .locator('.music-piece')
      .evaluateAll((elements) =>
        elements.every(
          (element) =>
            (element as HTMLElement).style.opacity === '1' &&
            (element as HTMLElement).style.filter === 'brightness(0.72)',
        ),
      ),
  ).toBe(true);
  const sizeDecay = await page
    .locator('.music-piece')
    .filter({ has: page.locator('img[src$="/inner-circle-2-arc-1.png"]') })
    .evaluate((element) => {
      const animation = element
        .getAnimations()
        .find((animation) =>
          animation.effect
            ?.getKeyframes()
            .some((frame) => String(frame.transform).startsWith('scale(')),
        );
      if (!animation) throw new Error('Missing bass size pulse');
      animation.pause();
      animation.currentTime = 100;
      const early = new DOMMatrix(getComputedStyle(element).transform).m11;
      animation.currentTime = 200;
      const late = new DOMMatrix(getComputedStyle(element).transform).m11;
      animation.play();
      return early - late;
    });
  expect(sizeDecay).toBeCloseTo(0.016, 3);
  const takeHighlights = () =>
    page.locator('.light-region').evaluateAll((regions) =>
      regions.flatMap((region, index) => {
        const animations = region.getAnimations();
        for (const animation of animations) animation.finish();
        return animations.length ? [index] : [];
      }),
    );
  const firstHighlights = await takeHighlights();
  await page.waitForTimeout(140);
  await pulse(0.4, 70);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.light-region')].some(
      (region) => region.getAnimations().length > 0,
    ),
  );
  const nextHighlights = await takeHighlights();
  expect(nextHighlights).toHaveLength(21);
  expect(nextHighlights).not.toEqual(firstHighlights);
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
  await dialog.getByRole('button', { name: 'Calm', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Calm', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('output[for="music-bass"]')).toHaveText('200%');
  expect(
    await page
      .locator('.music-piece')
      .evaluateAll((elements) =>
        elements.every(
          (element) => (element as HTMLElement).style.opacity === '1',
        ),
      ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await pulse(0.8);
  const piece = page.locator('.music-piece').nth(1);
  await expect
    .poll(() =>
      piece.evaluate((element) => (element as HTMLElement).style.transform),
    )
    .not.toBe('none');
  await page.keyboard.press('m');
  const draft = page.getByRole('textbox', { name: 'Message Ivy' });
  await draft.fill('p');
  await expect(dialog).toBeHidden();
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
  await page.locator('stellar-desktop-experience-template').focus();
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
