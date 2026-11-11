import { expect, test, type Page } from '@playwright/test';
import type {
  IvySnapshot,
  IvyResponseSegment,
} from '@stellar/desktop-contracts';
import { openPane } from './stage-driver';

interface SegmentFixture {
  calls: string[];
  spoken: string[];
  publish(text: string, final?: boolean, reused?: boolean): void;
  finishSpeech(): void;
  current(): IvySnapshot;
}
async function install(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('stellar.ivy-reflex.enabled', 'false');
    let revision = 0;
    let segment = 0;
    const listeners = new Map<
      string,
      Set<(event: { payload: unknown }) => void>
    >();
    const emit = (name: string, payload: unknown) =>
      listeners.get(name)?.forEach((callback) => callback({ payload }));
    let current: IvySnapshot = {
      version: 1,
      revision: '0',
      model: 'terra',
      verified_model: 'terra',
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      reset_id: null,
      turn_id: null,
      connection: 'ready',
      turn: 'idle',
      activity: [],
      items: [],
      response_segments: [],
      error: null,
    };
    let speech = {
      version: 1,
      revision: '0',
      epoch: '0',
      operation_id: null as string | null,
      state: 'idle',
      error: null,
    };
    const fixture: SegmentFixture = {
      calls: [],
      spoken: [],
      current: () => current,
      publish(text, final = false, reused = false) {
        const row: IvyResponseSegment = {
          id: (++segment).toString(16).padStart(64, '0'),
          kind: final ? 'final' : 'commentary',
          sequence: final ? null : String(segment),
          text,
          reused,
        };
        current = {
          ...current,
          revision: String(++revision),
          turn: final ? 'completed' : 'admitted',
          response_segments: [...current.response_segments, row],
          items: final ? [{ kind: 'text', text }] : [],
          activity: final
            ? []
            : [{ id: '0123456789abcdef', kind: 'web', state: 'running' }],
        };
        emit('ivy-state', current);
      },
      finishSpeech() {
        speech = { ...speech, revision: String(++revision), state: 'idle' };
        emit('speech-state', speech);
      },
    };
    Object.assign(window, {
      __segments: fixture,
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
            name: string,
            args?: { request?: Record<string, unknown> },
          ) => {
            fixture.calls.push(name);
            const request = args?.request ?? {};
            if (name === 'app_info')
              return {
                version: 1,
                sequence: request['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (name === 'ivy_connect' || name === 'ivy_snapshot')
              return current;
            if (name === 'ivy_submit') {
              current = {
                ...current,
                revision: String(++revision),
                turn_id: String(request['input_id']),
                turn: 'admitted',
                items: [],
                response_segments: [],
              };
              return current;
            }
            if (name === 'speech_snapshot') return speech;
            if (name === 'speech_stop') {
              speech = {
                ...speech,
                epoch: String(BigInt(speech.epoch) + 1n),
                revision: String(++revision),
                state: 'idle',
              };
              emit('speech-state', speech);
              return speech;
            }
            if (name === 'speech_speak') {
              if (speech.state !== 'idle')
                throw Error('Native speech slot overlap');
              fixture.spoken.push(String(request['text']));
              speech = {
                ...speech,
                revision: String(++revision),
                operation_id: String(request['utterance_id']),
                state: 'speaking',
              };
              emit('speech-state', speech);
              return speech;
            }
            if (
              name === 'speech_set_ducking' ||
              name === 'reflex_set_enabled' ||
              name === 'reflex_cancel'
            )
              return;
            throw Error('Unsupported response fixture command');
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.emblem')).toBeVisible();
  await page.keyboard.press('m');
  await page
    .getByPlaceholder('Type a message')
    .fill('Check my day and the news');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __segments: SegmentFixture }
        ).__segments.calls.includes('ivy_submit'),
      ),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
}
const publish = (page: Page, text: string, final = false, reused = false) =>
  page.evaluate(
    ({ text, final, reused }) =>
      (window as unknown as { __segments: SegmentFixture }).__segments.publish(
        text,
        final,
        reused,
      ),
    { text, final, reused },
  );
const finishSpeech = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __segments: SegmentFixture }
    ).__segments.finishSpeech(),
  );
const spoken = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __segments: SegmentFixture }).__segments.spoken,
  );

test('committed updates are visible outside M and speak before completion without consuming existing panes', async ({
  page,
}, testInfo) => {
  await install(page);
  expect(
    await openPane(page, 51, 'retained-notes', 'My notes', 'Keep this content'),
  ).toBe('applied');
  await publish(page, 'Morning! I am checking your calendar and the news.');
  const caption = page.locator('stellar-response-caption-molecule');
  await expect(caption).toContainText('Morning!');
  await expect
    .poll(() => spoken(page))
    .toEqual(['Morning! I am checking your calendar and the news.']);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __segments: SegmentFixture }
        ).__segments.current().turn,
    ),
  ).toBe('admitted');
  await publish(page, 'Your first meeting is at ten.');
  await expect(caption).toContainText('Your first meeting is at ten.');
  expect(await spoken(page)).toHaveLength(1);
  await finishSpeech(page);
  await expect.poll(() => spoken(page)).toHaveLength(2);
  await publish(page, 'Your first meeting is at ten.', true, true);
  await finishSpeech(page);
  await expect(caption.locator('section')).toHaveAttribute(
    'aria-label',
    'Ivy answer',
  );
  expect(await spoken(page)).toHaveLength(2);
  await expect(
    page.getByText('Keep this content', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Experience controls' }),
  ).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath('response-segments-desktop.png'),
  });
  await page.setViewportSize({ width: 440, height: 780 });
  await expect(caption).toBeVisible();
  const bounds = await caption.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(408);
  await page.screenshot({
    path: testInfo.outputPath('response-segments-compact.png'),
  });
});

test('mute fences queued commentary and keeps final text visible without timer filler', async ({
  page,
}) => {
  await install(page);
  await publish(page, 'A first committed update.');
  await expect.poll(() => spoken(page)).toHaveLength(1);
  await publish(page, 'Queued words that should remain silent.');
  await page.keyboard.press('m');
  await page
    .getByRole('switch', { name: 'Spoken replies', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await publish(page, 'The completed answer remains visible.', true);
  await expect(page.locator('stellar-response-caption-molecule')).toContainText(
    'The completed answer remains visible.',
  );
  expect(await spoken(page)).toEqual(['A first committed update.']);
});
