import { expect, test, type Page } from '@playwright/test';
import type { IvySnapshot } from '@stellar/desktop-contracts';
import { openPane } from './stage-driver';

type ComposerApp = {
  voice: {
    setModel(model: 'terra' | 'sol'): void;
    setDraft(text: string): void;
    setMuted(muted: boolean): void;
    composition(): { raw: string; refined: string | null; status: string };
    conversation: {
      generation: number;
      recognize(text: string, id: string, generation: number): Promise<void>;
    };
  };
};
type ComposerFixture = {
  animations: Animation[];
  submissions: { text: string; dissolved: boolean }[];
  hold: boolean;
  panel?: Element;
};
const raw = 'Um, set up the next Stellar sprint.';
const refined = 'Set up the next Stellar sprint.';

async function install(page: Page, hold = true) {
  await page.addInitScript(
    ({ hold, refined }) => {
      let revision = 0;
      let model: 'terra' | 'sol' = 'terra';
      const fixture: ComposerFixture = {
        animations: [],
        submissions: [],
        hold,
      };
      const snapshot = (
        turn: IvySnapshot['turn'] = 'idle',
        turn_id: string | null = null,
      ): IvySnapshot => ({
        version: 1,
        revision: String(++revision),
        turn_id,
        model,
        verified_model: turn === 'completed' ? model : null,
        workspace_tools: 'unavailable',
        workspace_epoch: '0',
        connection: 'ready',
        turn,
        items: [],
        error: null,
      });
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (
        ...args: Parameters<Element['animate']>
      ) {
        const animation = animate.apply(this, args);
        if (this.matches('.composer, .raw-text, .refined-text')) {
          fixture.animations.push(animation);
          if (fixture.hold) animation.pause();
        }
        return animation;
      };
      Object.assign(window, {
        __composerFixture: fixture,
        __TAURI__: {
          event: { listen: async () => () => undefined },
          core: {
            invoke: async (
              command: string,
              args: { request: Record<string, unknown> },
            ) => {
              const request = args.request;
              if (command === 'app_info')
                return {
                  version: 1,
                  sequence: request['sequence'],
                  application: 'stellar-desktop',
                  capabilities: [],
                  build_revision: null,
                };
              if (command === 'ivy_connect' || command === 'ivy_snapshot')
                return snapshot();
              if (command === 'ivy_select_session') {
                model = request['model'] as 'terra' | 'sol';
                return snapshot();
              }
              if (command === 'ivy_clear_conversation') {
                model = 'terra';
                return snapshot();
              }
              if (command === 'cleanup_refine')
                return { version: 1, text: refined };
              if (command === 'speech_snapshot' || command === 'speech_stop')
                return {
                  version: 1,
                  revision: '0',
                  epoch: '0',
                  state: 'idle',
                  operation_id: null,
                  error: null,
                };
              if (command === 'ivy_submit') {
                const group = document.querySelector('.composer');
                fixture.submissions.push({
                  text: String(request['text']),
                  dissolved: Boolean(
                    group?.classList.contains('dissolved') &&
                      getComputedStyle(group).opacity === '0',
                  ),
                });
                return snapshot('completed', String(request['input_id']));
              }
              throw Error('Unexpected composer fixture command: ' + command);
            },
          },
        },
      });
    },
    { hold, refined },
  );
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
}

async function draft(page: Page, text = raw) {
  await page.evaluate((text) => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    const app = debug.ng.getComponent(root);
    app.voice.setModel('sol');
    app.voice.setDraft(text);
  }, text);
  await expect(
    page.getByRole('region', { name: 'Spoken prompt' }),
  ).toBeVisible();
}

async function finalize(page: Page) {
  // Recognition is an explicit fixture; real cleanup/selection/port ordering remains in the application.
  await page.evaluate(() => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    const conversation = debug.ng.getComponent(root).voice.conversation;
    void conversation.recognize(
      'end prompt',
      crypto.randomUUID(),
      conversation.generation,
    );
  });
}

const state = (page: Page) =>
  page.evaluate(() => {
    const fixture = (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture;
    return {
      animations: fixture.animations.length,
      submissions: fixture.submissions,
    };
  });

test('cleaned prompt dispatch waits for real text and brace animation completion exactly once', async ({
  page,
}) => {
  await install(page);
  await draft(page);
  const prompt = page.getByRole('region', { name: 'Spoken prompt' });
  await expect(prompt.locator('.brace')).toHaveCount(2);
  await expect(prompt.locator('textarea, input, button')).toHaveCount(0);
  await finalize(page);
  await expect.poll(async () => (await state(page)).animations).toBe(2);
  expect((await state(page)).submissions).toEqual([]);
  await page.evaluate(() =>
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.animations[0].finish(),
  );
  expect((await state(page)).submissions).toEqual([]);
  await page.evaluate(() =>
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.animations[1].finish(),
  );
  await expect.poll(async () => (await state(page)).animations).toBe(3);
  expect((await state(page)).submissions).toEqual([]);
  await expect(prompt.locator('.refined-text')).toHaveCSS('opacity', '1');
  await expect(prompt.locator('.refined-text')).toHaveText(refined);
  await page.evaluate(() =>
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.animations[2].finish(),
  );
  await expect.poll(async () => (await state(page)).submissions.length).toBe(1);
  expect((await state(page)).submissions).toEqual([
    { text: refined, dissolved: true },
  ]);
  await expect(prompt).toHaveCount(0);
});

test('long dictation remains bounded and composition preserves the same tiled pane component', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page);
  expect(
    await openPane(
      page,
      1,
      'retained-plan',
      'Retained plan',
      'Preserve this content',
    ),
  ).toBe('applied');
  const pane = page.locator('[data-instance-id="retained-plan"]');
  await expect(pane).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.panel =
      document.querySelector('[data-instance-id="retained-plan"]') ?? undefined;
  });
  await draft(
    page,
    'Preserve every meaningful requirement in this extended dictated request.\n'.repeat(
      90,
    ),
  );
  for (const viewport of [
    { width: 1100, height: 760 },
    { width: 480, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(pane).toBeHidden();
    await expect(pane).toHaveAttribute('inert', '');
    await expect
      .poll(async () => {
        const text = await page.locator('.text-stack').boundingBox();
        return Boolean(
          text &&
            text.y >= 0 &&
            text.y + text.height <= viewport.height &&
            text.height >= 40,
        );
      })
      .toBe(true);
    await expect
      .poll(async () =>
        page
          .locator('.experience')
          .evaluate((e) => e.scrollTop === 0 && e.scrollLeft === 0),
      )
      .toBe(true);
  }
  await draft(page);
  await finalize(page);
  // Reduced motion must render the finalized frame and complete the same port without held animations.
  await expect.poll(async () => (await state(page)).submissions.length).toBe(1);
  await expect(pane).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __composerFixture: ComposerFixture })
          .__composerFixture.panel ===
        document.querySelector('[data-instance-id="retained-plan"]'),
    ),
  ).toBe(true);
});

test('muting during finalization retains raw and cleaned text and blocks late submission', async ({
  page,
}) => {
  await install(page);
  await draft(page);
  await finalize(page);
  await expect.poll(async () => (await state(page)).animations).toBe(2);
  await page.evaluate(() => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    debug.ng.getComponent(root).voice.setMuted(true);
  });
  await expect(page.locator('.refined-ready .refined-text')).toHaveText(
    refined,
  );
  expect((await state(page)).submissions).toEqual([]);
  expect((await state(page)).animations).toBe(2);
  const composition = await page.evaluate(() => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    return debug.ng.getComponent(root).voice.composition();
  });
  expect(composition).toMatchObject({ raw, refined, status: 'error' });
});

test('finalized Terra drafts preserve immediate dispatch without a hidden Sol presentation', async ({
  page,
}) => {
  await install(page);
  await page.evaluate((text) => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    const app = debug.ng.getComponent(root);
    app.voice.setModel('terra');
    app.voice.setDraft(text);
  }, raw);
  await finalize(page);
  await expect.poll(async () => (await state(page)).submissions.length).toBe(1);
  expect((await state(page)).animations).toBe(0);
  await expect(page.getByRole('region', { name: 'Spoken prompt' })).toHaveCount(
    0,
  );
});
