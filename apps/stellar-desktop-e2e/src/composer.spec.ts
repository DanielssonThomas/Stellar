import { expect, test, type Page } from '@playwright/test';
import type { IvySnapshot } from '@stellar/desktop-contracts';
import { openPane } from './stage-driver';

type ComposerApp = {
  experience: {
    state(): { microphone: { requestId: number | null } };
  };
  voice: {
    audio: {
      start(source: unknown): Promise<void>;
      startMicrophone(): Promise<void>;
      state(): { status: string };
    };
    setModel(model: 'terra' | 'sol'): void;
    setDraft(text: string): void;
    setMuted(muted: boolean): void;
    composition(): { raw: string; refined: string | null; status: string };
    conversation: {
      generation: number;
      recognize(text: string, id: string, generation: number): Promise<void>;
      update(context: unknown): void;
      accept(event: unknown): void;
    };
  };
};
type ComposerFixture = {
  animations: Animation[];
  edits: string[];
  submissions: { text: string; dissolved: boolean }[];
  hold: boolean;
  transcript?: string;
  recognitions: string[];
  cleanups: string[];
  sessions: string[];
  cleanupText?: string;
  panel?: Element;
};
const raw = 'Um, Set up the next Stellar sprint.';
const refined = 'Set up the next Stellar sprint.';

async function install(page: Page, hold = true, autoStart = false) {
  await page.addInitScript(
    ({ hold, refined, autoStart }) => {
      let revision = 0;
      let model: 'terra' | 'sol' = 'terra';
      const fixture: ComposerFixture = {
        animations: [],
        edits: [],
        submissions: [],
        hold,
        recognitions: [],
        cleanups: [],
        sessions: [],
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
        if (this.matches('.brace, .background-tone, .text-stack')) {
          fixture.animations.push(animation);
          if (fixture.hold) animation.pause();
        }
        return animation;
      };
      new MutationObserver(() => {
        const text = document.querySelector('.prompt-text')?.textContent;
        if (text !== undefined && fixture.edits.at(-1) !== text)
          fixture.edits.push(text ?? '');
      }).observe(document, {
        subtree: true,
        characterData: true,
        childList: true,
      });
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
                  capabilities: autoStart ? [{ kind: 'native_window' }] : [],
                  build_revision: null,
                };
              if (command === 'ivy_connect' || command === 'ivy_snapshot')
                return snapshot();
              if (command === 'ivy_select_session') {
                fixture.sessions.push(String(request['model']));
                model = request['model'] as 'terra' | 'sol';
                return snapshot();
              }
              if (command === 'ivy_clear_conversation') {
                model = 'terra';
                return snapshot();
              }
              if (command === 'cleanup_refine') {
                fixture.cleanups.push(String(request['raw']));
                return { version: 1, text: fixture.cleanupText ?? refined };
              }
              if (command === 'speech_collect') {
                if (fixture.transcript !== undefined) {
                  fixture.recognitions.push(fixture.transcript);
                  return {
                    version: 1,
                    utterance_id: request['utterance_id'],
                    text: fixture.transcript,
                  };
                }
                const pcm = request['pcm'] as number[];
                const marker = pcm.some((sample) => sample === 4000);
                const words = pcm.filter((sample) => sample === 2000).length;
                const text = marker
                  ? 'send prompt'
                  : words < 22000
                    ? 'the'
                    : words < 30000
                      ? 'the next'
                      : 'the next Stellar sprint.';
                return {
                  version: 1,
                  utterance_id: request['utterance_id'],
                  text,
                };
              }
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
    { hold, refined, autoStart },
  );
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
}

async function wakeCapture(page: Page) {
  await page.evaluate(() => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
      __wakeFeed: (active: boolean, count: number) => Promise<void>;
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    const audio = debug.ng.getComponent(root).voice.audio;
    type Sink = {
      status(value: string): void;
      frame(value: unknown): void;
      pcm?(value: unknown): void;
    };
    let sink: Sink | undefined;
    let sequence = 0,
      timestampMs = 0;
    const source = {
      async start(next: Sink) {
        sink = next;
        next.status('capturing');
      },
      async stop() {
        sink = undefined;
      },
    };
    audio.startMicrophone = () => audio.start(source);
    debug.__wakeFeed = async (active, count) => {
      for (let i = 0; i < count; i++) {
        if (!sink) return;
        timestampMs += 40;
        sink.frame({
          timestampMs,
          rms: active ? 0.1 : 0.001,
          peak: active ? 0.1 : 0.001,
          clipped: false,
        });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        sink?.pcm?.({
          type: 'chunk',
          chunk: {
            sampleRate: 16000,
            sequence: sequence++,
            samples: new Int16Array(640).fill(active ? 2000 : 0),
          },
        });
      }
    };
  });
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Enable microphone', exact: true })
    .click();
  const feed = (active: boolean, count: number) =>
    page.evaluate(
      ({ active, count }) =>
        (
          window as unknown as {
            __wakeFeed(active: boolean, count: number): Promise<void>;
          }
        ).__wakeFeed(active, count),
      { active, count },
    );
  await feed(false, 20);
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  const say = async (text: string) => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector('stellar-root');
          if (!root) throw Error('Root missing');
          return (
            window as unknown as {
              ng: { getComponent(element: Element): ComposerApp };
            }
          ).ng
            .getComponent(root)
            .voice.audio.state().status;
        }),
      )
      .toBe('capturing');
    const before = await page.evaluate((text) => {
      const fixture = (
        window as unknown as { __composerFixture: ComposerFixture }
      ).__composerFixture;
      fixture.transcript = text;
      return fixture.recognitions.length;
    }, text);
    await feed(false, 20);
    await feed(true, 10);
    await feed(false, 60);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __composerFixture: ComposerFixture })
              .__composerFixture.recognitions.length,
        ),
      )
      .toBeGreaterThan(before);
  };
  return Object.assign(say, { feed });
}

test('native startup requests the microphone automatically without assembling the passive emblem', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => {
        document.documentElement.dataset['automaticCaptureRequested'] = 'true';
        return new Promise<MediaStream>(() => undefined);
      },
    });
  });
  await install(page, false, true);
  await expect(page.locator('html')).toHaveAttribute(
    'data-automatic-capture-requested',
    'true',
  );
  await expect(page.locator('.emblem')).toHaveClass(/idle-motion/);
});

test('wake-only foreground flow routes Terra, composes Sol, cancels without cleanup, and requires re-invocation', async ({
  page,
}) => {
  await install(page, false);
  const say = await wakeCapture(page);
  const observed = () =>
    page.evaluate(() => {
      const fixture = (
        window as unknown as { __composerFixture: ComposerFixture }
      ).__composerFixture;
      const root = document.querySelector('stellar-root');
      if (!root) throw Error('Root missing');
      const app = (
        window as unknown as {
          ng: { getComponent(element: Element): ComposerApp };
        }
      ).ng.getComponent(root);
      return {
        submissions: fixture.submissions,
        cleanups: fixture.cleanups,
        sessions: fixture.sessions,
        composition: app.voice.composition(),
      };
    });
  for (const ambient of [
    'ordinary ambient conversation',
    'ivory is a color',
    'prompt',
  ])
    await say(ambient);
  expect((await observed()).sessions).toEqual([]);
  expect((await observed()).submissions).toEqual([]);
  await expect(page.locator('.emblem')).toHaveClass(/idle-motion/);
  await page.evaluate(() => {
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.transcript = 'Ivy, tell me the plan';
  });
  await say.feed(true, 32);
  await expect(page.locator('.emblem')).not.toHaveClass(/idle-motion/);
  expect((await observed()).submissions).toEqual([]);
  await page.evaluate(() => {
    const observed = window as unknown as {
      __foregroundDropped?: boolean;
      __watchForeground?: boolean;
    };
    observed.__watchForeground = true;
    const watch = () => {
      if (!observed.__watchForeground) return;
      if (document.querySelector('.emblem')?.classList.contains('idle-motion'))
        observed.__foregroundDropped = true;
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await say.feed(true, 20);
  await say.feed(false, 60);
  await expect
    .poll(async () => (await observed()).submissions)
    .toEqual([{ text: 'tell me the plan', dissolved: false }]);
  expect((await observed()).sessions).toEqual(['terra']);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __foregroundDropped?: boolean })
          .__foregroundDropped ?? false,
    ),
  ).toBe(false);
  await page.evaluate(() => {
    (window as unknown as { __watchForeground?: boolean }).__watchForeground =
      false;
  });
  await say("I'm done");
  await expect(page.locator('.emblem')).toHaveClass(/idle-motion/);
  await say('another ambient request');
  expect((await observed()).submissions).toHaveLength(1);
  await say('Ivy, prompt');
  await expect(
    page.getByRole('region', { name: 'Spoken prompt' }),
  ).toBeVisible();
  expect((await observed()).composition.status).toBe('composing');
  await say('Keep this draft private. Prompt cancel.');
  await expect(page.getByRole('region', { name: 'Spoken prompt' })).toHaveCount(
    0,
  );
  expect((await observed()).composition).toMatchObject({
    raw: '',
    refined: null,
    status: 'idle',
  });
  expect((await observed()).cleanups).toEqual([]);
  expect((await observed()).submissions).toHaveLength(1);
  await say('prompt');
  await say('unrelated background speech');
  expect((await observed()).composition.status).toBe('idle');
  expect((await observed()).submissions).toHaveLength(1);
  await say('Ivy, prompt new draft');
  await expect(
    page.getByRole('region', { name: 'Spoken prompt' }),
  ).toBeVisible();
  expect((await observed()).composition.raw).toBe('new draft');
  await say('prompt cancel');
  await expect(page.getByRole('region', { name: 'Spoken prompt' })).toHaveCount(
    0,
  );
  expect((await observed()).composition.raw).toBe('');
});

async function draft(page: Page, text = raw, finishOpening = true) {
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
  if (finishOpening) {
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const fixture = (
            window as unknown as { __composerFixture: ComposerFixture }
          ).__composerFixture;
          return (
            fixture.animations.length >= 4 ||
            !!document.querySelector('.composer.opened')
          );
        }),
      )
      .toBe(true);
    await page.evaluate(() =>
      (
        window as unknown as { __composerFixture: ComposerFixture }
      ).__composerFixture.animations.forEach((animation) => animation.finish()),
    );
    await expect(page.locator('.composer')).toHaveClass(/opened/);
  }
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

test('typed submit preserves the form and keeps continuous capture active', async ({
  page,
}) => {
  await install(page, false);
  await wakeCapture(page);
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  const input = page.getByLabel('Message Ivy');
  await input.fill('A typed message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).submissions)
    .toEqual([{ text: 'A typed message', dissolved: false }]);
  await expect(input).toHaveValue('A typed message');
  await expect(
    page.getByRole('button', { name: 'Stop microphone', exact: true }),
  ).toBeVisible();
});
test('synthetic voice preview, stable sentence and cleanup reach one finalized submission', async ({
  page,
}) => {
  await install(page, false);
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture;
    fixture.cleanupText = 'Set up\nthe next Stellar sprint.';
  });
  await page.evaluate(() => {
    type Sink = {
      status(value: string): void;
      frame(value: unknown): void;
      pcm?(value: unknown): void;
    };
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
      __syntheticFeed?: (
        active: boolean,
        count: number,
        marker: number,
      ) => Promise<void>;
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    const audio = debug.ng.getComponent(root).voice.audio;
    let sink: Sink | undefined;
    let sequence = 0;
    let timestampMs = 0;
    const source = {
      async start(next: Sink) {
        sink = next;
        next.status('capturing');
      },
      async stop() {
        sink = undefined;
      },
    };
    audio.startMicrophone = () => audio.start(source);
    debug.__syntheticFeed = async (active, count, marker) => {
      for (let i = 0; i < count; i++) {
        if (!sink) return;
        timestampMs += 40;
        sink.frame({
          timestampMs,
          rms: active ? 0.1 : 0.001,
          peak: active ? 0.1 : 0.001,
          clipped: false,
        });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        sink?.pcm?.({
          type: 'chunk',
          chunk: {
            sampleRate: 16000,
            sequence: sequence++,
            samples: new Int16Array(640).fill(active ? marker : 0),
          },
        });
      }
    };
  });
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Enable microphone', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('stellar-root');
        if (!root) return null;
        const app = (
          window as unknown as {
            ng: { getComponent(element: Element): ComposerApp };
          }
        ).ng.getComponent(root);
        return {
          requestId: app.experience.state().microphone.requestId,
          status: app.voice.audio.state().status,
        };
      }),
    )
    .toMatchObject({ requestId: expect.any(Number), status: 'capturing' });
  const feed = (active: boolean, count: number, marker = 2000) =>
    page.evaluate(
      ({ active, count, marker }) =>
        (
          window as unknown as {
            __syntheticFeed: (
              active: boolean,
              count: number,
              marker: number,
            ) => Promise<void>;
          }
        ).__syntheticFeed(active, count, marker),
      { active, count, marker },
    );
  await feed(false, 18);
  await draft(page, 'Um, Set up', false);
  await expect(page.locator('.composer')).toHaveClass(/opened/);
  await feed(true, 30);
  await expect(page.locator('.prompt-text')).toContainText('the');
  await feed(true, 25);
  await expect(page.locator('.prompt-text')).toContainText('the next');
  await feed(false, 36);
  await expect(page.locator('.text-stack')).toHaveAttribute('aria-live', 'off');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('stellar-root');
        if (!root) return null;
        return (
          window as unknown as {
            ng: { getComponent(element: Element): ComposerApp };
          }
        ).ng
          .getComponent(root)
          .voice.composition();
      }),
    )
    .toMatchObject({
      raw: 'Um, Set up\nthe next Stellar sprint.',
      refined: 'Set up\nthe next Stellar sprint.',
    });
  await expect(page.locator('.prompt-text')).toHaveText(
    'Set up\nthe next Stellar sprint.',
  );
  const sendStarted = await page.evaluate(() => performance.now());
  await feed(true, 12, 4000);
  await feed(false, 36);
  await expect
    .poll(async () => (await state(page)).submissions, { timeout: 12000 })
    .toEqual([{ text: 'Set up\nthe next Stellar sprint.', dissolved: true }]);
  expect(
    (await page.evaluate(() => performance.now())) - sendStarted,
  ).toBeGreaterThanOrEqual(1800);
});

test('braces open from center, text edits by character and dispatch waits for reverse closure exactly once', async ({
  page,
}) => {
  await install(page);
  await draft(page, raw, false);
  const prompt = page.getByRole('region', { name: 'Spoken prompt' });
  await expect(prompt.locator('.brace')).toHaveCount(2);
  await expect(prompt.locator('textarea, input, button')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).animations).toBe(4);
  const centers = await prompt.locator('.brace').evaluateAll((elements) =>
    elements.map((e) => {
      const r = e.getBoundingClientRect();
      return r.x + r.width / 2;
    }),
  );
  expect(Math.abs(centers[0] - centers[1])).toBeLessThan(1);
  await page.evaluate(() =>
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.animations.forEach((animation) => animation.finish()),
  );
  await expect(prompt).toHaveClass(/opened/);
  await finalize(page);
  await expect.poll(async () => (await state(page)).animations).toBe(8);
  expect((await state(page)).submissions).toEqual([]);
  const edits = await page.evaluate(
    () =>
      (window as unknown as { __composerFixture: ComposerFixture })
        .__composerFixture.edits,
  );
  expect(
    edits.some(
      (text) => text !== raw && text !== refined && text.endsWith(refined),
    ),
  ).toBe(true);
  await expect(prompt.locator('.prompt-text')).toHaveText(refined);
  await page.evaluate(() =>
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.animations
      .slice(4, 7)
      .forEach((animation) => animation.finish()),
  );
  expect((await state(page)).submissions).toEqual([]);
  await page.evaluate(() =>
    (
      window as unknown as { __composerFixture: ComposerFixture }
    ).__composerFixture.animations[7].finish(),
  );
  await expect.poll(async () => (await state(page)).submissions.length).toBe(1);
  expect((await state(page)).submissions).toEqual([
    { text: refined, dissolved: true },
  ]);
  await expect(prompt).toHaveCount(0);
});

test('extended dictation scales to fit without scrolling and preserves the same tiled pane component', async ({
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
    const fit = await page.locator('.text-stack').evaluate((element) => ({
      overflow: getComputedStyle(element).overflow,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    }));
    expect(fit.overflow).toBe('hidden');
    expect(fit.scrollHeight).toBeLessThanOrEqual(fit.height + 1);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.width + 1);
    expect(fit.fontSize).toBeLessThan(16);
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
  await expect.poll(async () => (await state(page)).animations).toBe(8);
  await page.evaluate(() => {
    const debug = window as unknown as {
      ng: { getComponent(element: Element): ComposerApp };
    };
    const root = document.querySelector('stellar-root');
    if (!root) throw Error('Root missing');
    debug.ng.getComponent(root).voice.setMuted(true);
  });
  await expect(page.locator('.prompt-text')).toHaveText(refined);
  expect((await state(page)).submissions).toEqual([]);
  expect((await state(page)).animations).toBe(8);
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

test('an impossible text fit retains the draft and refuses submission instead of accepting clipped text', async ({
  page,
}) => {
  await page.setViewportSize({ width: 100, height: 80 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page);
  const text = 'Keep every requirement intact. '.repeat(260);
  await draft(page, text);
  await expect(page.locator('.composer')).toHaveAttribute(
    'data-text-fits',
    'false',
  );
  await finalize(page);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const app = (
          window as unknown as {
            ng: { getComponent(element: Element): ComposerApp };
          }
        ).ng.getComponent(document.querySelector('stellar-root') as Element);
        return app.voice.composition().status;
      }),
    )
    .toBe('error');
  expect((await state(page)).submissions).toEqual([]);
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect(page.locator('.composer')).toHaveAttribute(
    'data-text-fits',
    'true',
  );
  await expect(page.locator('.prompt-text')).toHaveText(text);
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
