import { expect, test } from '@playwright/test';

for (const { reducedMotion, className, animated, model, turn } of [
  {
    reducedMotion: 'no-preference' as const,
    className: /idle-motion/,
    animated: true,
  },
  {
    reducedMotion: 'reduce' as const,
    className: /motion-reduced/,
    animated: false,
  },
].flatMap((motion) => [
  { ...motion, model: 'sol', turn: 'completed' },
  { ...motion, model: 'terra', turn: 'idle' },
])) {
  test(`retained ${turn} ${model} conversation starts exploded with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.addInitScript(
      ({ model, turn }) => {
        let revision = 0;
        Object.assign(window, {
          __TAURI__: {
            event: { listen: async () => () => undefined },
            core: {
              invoke: async (
                command: string,
                args: { request: { sequence: number } },
              ) => {
                if (command === 'app_info')
                  return {
                    version: 1,
                    sequence: args.request.sequence,
                    application: 'Stellar Desktop',
                    capabilities: [],
                    build_revision: null,
                  };
                if (command === 'ivy_connect' || command === 'ivy_snapshot')
                  return {
                    version: 1,
                    revision: String(++revision),
                    model,
                    verified_model: null,
                    workspace_tools: 'unavailable',
                    workspace_epoch: '0',
                    reset_id: null,
                    turn_id: '11111111-2222-4333-8444-555555555555',
                    connection: 'ready',
                    turn,
                    activity: [],
                    items:
                      turn === 'completed'
                        ? [{ kind: 'text', text: 'A previous reply' }]
                        : [],
                    error: null,
                  };
                if (command === 'speech_snapshot')
                  return {
                    version: 1,
                    epoch: '0',
                    revision: '0',
                    operation_id: null,
                    state: 'idle',
                    error: null,
                  };
                throw new Error('Unexpected standby fixture command');
              },
            },
          },
        });
      },
      { model, turn },
    );
    await page.goto('/');
    const emblem = page.locator('.emblem');
    await expect(emblem).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Experience controls' }),
    ).toBeHidden();
    await expect(page.locator('.waiting-ring')).toHaveCount(0);
    for (const size of [
      { width: 1100, height: 760 },
      { width: 480, height: 360 },
    ]) {
      await page.setViewportSize(size);
      await expect
        .poll(() =>
          page
            .locator('.plane')
            .first()
            .evaluate(
              (element) =>
                new DOMMatrix(getComputedStyle(element).transform).m43,
            ),
        )
        .toBeLessThan(-20);
      await expect(emblem).toHaveClass(className);
      await expect
        .poll(() =>
          emblem.evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .some(
                (animation) =>
                  animation.playState === 'running' &&
                  animation.effect?.getTiming().iterations === Infinity,
              ),
          ),
        )
        .toBe(animated);
    }
  });
}
