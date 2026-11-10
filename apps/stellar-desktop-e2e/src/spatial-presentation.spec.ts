import { expect, test, type Page } from '@playwright/test';
import type {
  IvySnapshot,
  SpeechSnapshot,
  WorkspaceToolReply,
} from '@stellar/desktop-contracts';
import { openPane } from './stage-driver';

type ScorePort = {
  publish(state: 'speaking' | 'idle'): void;
  present(score: unknown): void;
  spoken: string[];
  replies: WorkspaceToolReply[];
};
const briefing = (page: Page) =>
  page.getByRole('region', { name: 'Morning AI briefing' });
const context = (page: Page) =>
  page.getByRole('button', { name: 'Presentation actions', exact: true });
const card = (page: Page, id: string) =>
  page.locator(`[data-panel-id="${id}"]`);
const pagePort = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { spatial: ScorePort }).spatial.spoken.length,
  );
const speech = (page: Page, state: 'speaking' | 'idle') =>
  page.evaluate(
    (state) =>
      (window as unknown as { spatial: ScorePort }).spatial.publish(state),
    state,
  );

async function openSample(page: Page) {
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
  await page.locator('.emblem-slot').evaluate((node) => {
    node.setAttribute('data-original-emblem', '');
  });
  await page.keyboard.press('m');
  await page.getByRole('button', { name: /Morning AI briefing/ }).click();
  await expect(briefing(page)).toBeVisible();
  await expect(briefing(page).getByRole('article')).toHaveCount(5);
}

async function mockNative(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    const emit = (event: string, payload: unknown) =>
      listeners.get(event)?.({ payload });
    const turn = crypto.randomUUID();
    let ivyRevision = 0;
    let admitted = false;
    const ivy = (): IvySnapshot => ({
      version: 1,
      revision: String(++ivyRevision),
      model: 'terra',
      verified_model: null,
      workspace_tools: 'available',
      workspace_epoch: '1',
      reset_id: null,
      turn_id: admitted ? turn : null,
      connection: 'ready',
      turn: admitted ? 'admitted' : 'idle',
      activity: [],
      items: [],
      error: null,
    });
    let revision = 0;
    let snapshot: SpeechSnapshot = {
      version: 1,
      epoch: '1',
      revision: '0',
      state: 'idle',
      operation_id: null,
      error: null,
    };
    const advance = (state: SpeechSnapshot['state'], id: string | null) => {
      snapshot = {
        ...snapshot,
        revision: String(++revision),
        state,
        operation_id: id,
      };
      emit('speech-state', snapshot);
      return snapshot;
    };
    const port: ScorePort = {
      spoken: [],
      replies: [],
      publish(state) {
        advance(state, state === 'idle' ? null : snapshot.operation_id);
      },
      present(score) {
        admitted = true;
        emit('workspace-tool-request', {
          version: 1,
          epoch: '1',
          request_id: crypto.randomUUID().replaceAll('-', ''),
          turn_id: turn,
          expires_at_ms: String(Date.now() + 10000),
          operation: { kind: 'present', score_json: JSON.stringify(score) },
        });
      },
    };
    Object.assign(window, {
      spatial: port,
      __TAURI__: {
        event: {
          listen: async (
            event: string,
            callback: (value: { payload: unknown }) => void,
          ) => {
            listeners.set(event, callback);
            return () => listeners.delete(event);
          },
        },
        core: {
          invoke: async (
            command: string,
            args: { request: Record<string, unknown> },
          ) => {
            if (command === 'ivy_connect' || command === 'ivy_snapshot')
              return ivy();
            if (command === 'speech_snapshot') return snapshot;
            if (command === 'speech_speak') {
              port.spoken.push(String(args.request['text']));
              return advance(
                'synthesizing',
                String(args.request['utterance_id']),
              );
            }
            if (command === 'speech_stop') {
              snapshot = {
                ...snapshot,
                epoch: String(Number(snapshot.epoch) + 1),
              };
              return advance('idle', null);
            }
            if (command === 'workspace_image') {
              if (args.request['url'] !== 'https://example.com/cover.png')
                throw 'unavailable';
              return {
                data_uri:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1gAAAABJRU5ErkJggg==',
                width: 1,
                height: 1,
              };
            }
            if (command === 'workspace_tool_reply') {
              port.replies.push(args.request as unknown as WorkspaceToolReply);
              return undefined;
            }
            if (command === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'stellar-desktop',
                capabilities: [],
                build_revision: null,
              };
            throw 'unavailable';
          },
        },
      },
    });
  });
}

test('directs the sample from overview through detail and comparison at playback boundaries', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockNative(page);
  await openSample(page);
  const dialog = briefing(page);
  const emblem = page.locator('.emblem-slot[data-original-emblem]');
  await expect(
    dialog.locator('xpath=ancestor::stellar-stage-organism'),
  ).toHaveCount(1);
  await expect(page.locator('stellar-emblem-motion-molecule')).toHaveCount(1);
  await expect(emblem).toHaveCSS('width', '238px');
  await expect(dialog.getByText('Fictional sample')).toBeVisible();
  await expect(
    dialog.getByRole('img', { name: /Illustration of/ }),
  ).toHaveCount(5);
  await expect(card(page, 'juniper').getByRole('img')).toBeVisible();
  await expect(card(page, 'harbor').getByRole('img')).toBeVisible();
  await expect.poll(() => pagePort(page)).toBe(1);
  await expect(dialog.getByRole('status')).toHaveText('Preparing narration');
  await expect(
    dialog.getByRole('button', {
      name: /Next segment|Stop narration|Close presentation|Compact panels|Details|Less|Dismiss/,
    }),
  ).toHaveCount(0);
  await dialog.screenshot({
    path: info.outputPath('overview.png'),
    animations: 'disabled',
  });

  const begin = async (number: number) => {
    await expect.poll(() => pagePort(page)).toBe(number);
    await speech(page, 'speaking');
    await expect(dialog.getByRole('status')).toHaveText('Ivy speaking');
  };
  await begin(1);
  await expect(dialog.locator('.is-focused')).toHaveCount(0);
  await speech(page, 'idle');
  await begin(2);
  await expect(dialog.locator('.projection-caption')).toContainText(
    'My pick for your local AI work',
  );
  await expect(card(page, 'juniper')).toHaveClass(/is-focused/);
  await speech(page, 'idle');
  await begin(3);
  await expect(
    card(page, 'juniper').getByText(/independent checker/),
  ).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath('focus.png'),
    animations: 'disabled',
  });
  await speech(page, 'idle');
  await begin(4);
  await expect(card(page, 'mosaic')).toHaveClass(/is-focused/);
  await speech(page, 'idle');
  await begin(5);
  await expect(dialog.locator('.is-focused')).toHaveCount(2);
  await expect(emblem).toHaveCSS('width', '160px');
  await dialog.screenshot({
    path: info.outputPath('comparison.png'),
    animations: 'disabled',
  });
  await speech(page, 'idle');
  await begin(6);
  await expect(dialog.locator('.projection-caption')).toContainText(
    'Elsewhere in AI',
  );
  await expect(card(page, 'relay')).toHaveClass(
    /is-focused is-expanded|is-expanded is-focused/,
  );
  await speech(page, 'idle');
  await begin(7);
  await expect(card(page, 'meridian')).toHaveClass(/is-focused/);
  await speech(page, 'idle');
  await begin(8);
  await expect(card(page, 'harbor')).toHaveClass(/is-focused/);
  await speech(page, 'idle');
  await begin(9);
  await speech(page, 'idle');
  await expect(dialog.getByRole('status')).toHaveText('Presentation ready');
  await expect(dialog.locator('.projection-caption')).toHaveCount(0);
  await expect(dialog.locator('.is-focused')).toHaveCount(0);
  await expect(dialog.getByRole('article')).toHaveCount(5);

  await card(page, 'juniper').click({ position: { x: 24, y: 75 } });
  await expect(card(page, 'juniper')).toHaveClass(/is-focused/);
  await card(page, 'juniper').locator('.card-title').click();
  await expect(
    card(page, 'juniper').getByText(/independent checker/),
  ).toBeVisible();
  await card(page, 'relay').locator('.card-title').dispatchEvent('click');
  await expect(card(page, 'relay')).toHaveClass(/is-focused/);
  await expect(card(page, 'juniper')).not.toHaveClass(/is-focused/);
  await context(page).click();
  await dialog.getByRole('button', { name: 'Compact panels' }).click();
  await expect(dialog).toHaveClass(/is-compact/);
  await dialog.getByRole('button', { name: 'View transcript' }).click();
  await expect(
    dialog.getByRole('region', { name: 'Transcript' }).getByRole('listitem'),
  ).toHaveCount(9);
  await dialog.getByRole('button', { name: 'Close presentation' }).click();
  await expect(dialog).toBeHidden();
  await expect(emblem).toHaveCSS('width', '480px');
});

test('runs all five stories as automatic read-along when voice is unavailable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await openSample(page);
  const dialog = briefing(page);
  await expect(
    dialog.getByText('Audio unavailable / Read along'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Next segment' }),
  ).toHaveCount(0);
  const advance = () => page.clock.fastForward(15000);
  await advance();
  await expect(card(page, 'juniper')).toHaveClass(/is-focused/);
  await advance();
  await expect(card(page, 'juniper')).toHaveClass(/is-expanded/);
  await advance();
  await expect(card(page, 'mosaic')).toHaveClass(/is-focused/);
  await advance();
  await expect(dialog.locator('.is-focused')).toHaveCount(2);
  await advance();
  await expect(card(page, 'relay')).toHaveClass(/is-focused/);
  await advance();
  await expect(card(page, 'meridian')).toHaveClass(/is-focused/);
  await advance();
  await expect(card(page, 'harbor')).toHaveClass(/is-focused/);
  await advance();
  await expect(dialog.locator('.is-focused')).toHaveCount(0);
  await advance();
  await expect(dialog.getByRole('status')).toHaveText('Presentation ready');
  await expect(dialog.locator('.projection-caption')).toHaveCount(0);
  await expect(dialog.getByRole('article')).toHaveCount(5);
});

test('offers pause and deliberate stepping through the contextual actions', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await openSample(page);
  const stage = briefing(page);
  await expect(stage.getByText('Audio unavailable / Read along')).toBeVisible();
  await context(page).focus();
  await page.keyboard.press('Enter');
  await stage.getByRole('button', { name: 'Pause read-along' }).click();
  await page.clock.fastForward(15000);
  await expect(
    stage.getByText('Audio unavailable / Read-along paused'),
  ).toBeVisible();
  await expect(stage.locator('.is-focused')).toHaveCount(0);
  await stage.getByRole('button', { name: 'Next segment' }).click();
  await expect(card(page, 'juniper')).toHaveClass(/is-focused/);
  await stage.getByRole('button', { name: 'Resume read-along' }).click();
  await page.keyboard.press('Escape');
  await expect(context(page)).toBeFocused();
  await page.clock.fastForward(15000);
  await expect(card(page, 'juniper')).toHaveClass(/is-expanded/);
});

test('allows manual focus, interruption and dismissal with reduced motion on a narrow viewport', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 412, height: 820 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockNative(page);
  await openSample(page);
  const dialog = briefing(page);
  await dialog.screenshot({
    path: info.outputPath('compact-viewport.png'),
    animations: 'disabled',
  });
  const research = card(page, 'mosaic').getByRole('button', {
    name: 'A benchmark puts long context to work',
    exact: true,
  });
  await research.focus();
  await page.keyboard.press('Enter');
  await expect(research).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pagePort(page)).toBe(1);
  await speech(page, 'speaking');
  await speech(page, 'idle');
  await expect.poll(() => pagePort(page)).toBe(2);
  await speech(page, 'speaking');
  await expect(card(page, 'mosaic')).toHaveClass(/is-focused/);
  await page.keyboard.press('f');
  await speech(page, 'idle');
  await expect.poll(() => pagePort(page)).toBe(3);
  await speech(page, 'speaking');
  await expect(card(page, 'juniper')).toHaveClass(/is-focused/);
  await page.keyboard.press('Alt+s');
  await expect(dialog.getByRole('status')).toHaveText('Presentation ready');
  await card(page, 'juniper').locator('.card-title').focus();
  await page.keyboard.press('Delete');
  await expect(card(page, 'juniper')).toHaveCount(0);
  await expect(
    dialog.getByRole('heading', { name: 'Morning AI briefing' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator('stellar-desktop-experience-template'),
  ).toBeFocused();
});

test('accepts an admitted score and a later workspace tool update', async ({
  page,
}) => {
  await mockNative(page);
  await page.goto('/');
  await expect(page.locator('stellar-root')).toHaveAttribute(
    'data-desktop-ready',
    'true',
  );
  const submit = (score: unknown) =>
    page.evaluate(
      (score) =>
        (window as unknown as { spatial: ScorePort }).spatial.present(score),
      score,
    );
  const statuses = () =>
    page.evaluate(() =>
      (window as unknown as { spatial: ScorePort }).spatial.replies.map(
        (reply) => reply.outcome.kind,
      ),
    );
  expect(
    await openPane(page, 1, 'retained-note', 'Desk note', 'Still here'),
  ).toBe('applied');
  const note = page.locator('[data-instance-id="retained-note"]');
  await expect(note).toBeVisible();
  await note.evaluate((element) =>
    element.setAttribute('data-retained-node', ''),
  );
  const controls = page.getByRole('dialog', { name: 'Experience controls' });
  await page.keyboard.press('m');
  await expect(controls).toBeVisible();
  const panel = {
    id: 'signal',
    title: 'Evidence is arriving',
    category: 'Research',
    summary: 'First verified result.',
    source: 'https://example.com/research',
    thumbnail: { src: 'https://example.com/cover.png', alt: 'Research cover' },
  };
  await submit({
    begin: { title: 'A developing story', label: 'Research' },
    prepare: [{ kind: 'show', panel }],
    segments: [
      {
        text: 'The first result is here.',
        actions: [{ kind: 'focus', id: panel.id }],
      },
    ],
  });
  await expect.poll(statuses).toEqual(['applied']);
  await expect(controls).toBeHidden();
  await expect(note).toBeHidden();
  await expect(note).toHaveAttribute('inert', '');
  await expect(
    page.getByRole('heading', { name: 'A developing story' }),
  ).toBeFocused();
  await expect(card(page, 'signal')).toBeVisible();
  await expect(
    card(page, 'signal').getByRole('img', { name: 'Research cover' }),
  ).toBeVisible();
  await expect.poll(() => pagePort(page)).toBe(1);
  await submit({
    prepare: [
      {
        kind: 'show',
        panel: {
          ...panel,
          summary: 'The second result has arrived.',
          thumbnail: {
            src: 'https://example.com/missing.png',
            alt: 'Missing cover',
          },
        },
      },
    ],
  });
  await expect.poll(statuses).toEqual(['applied', 'applied']);
  await expect(
    card(page, 'signal').getByText('The second result has arrived.'),
  ).toBeVisible();
  await expect(card(page, 'signal').locator('.card-thumbnail')).toBeHidden();
  await expect(card(page, 'signal')).not.toHaveClass(/is-focused/);
  await expect(
    card(page, 'signal').getByRole('link', { name: 'Source' }),
  ).toHaveCount(0);
  await speech(page, 'speaking');
  await expect(card(page, 'signal')).toHaveClass(/is-focused/);
  await expect(
    card(page, 'signal').getByRole('link', { name: 'Source' }),
  ).toHaveAttribute('href', panel.source);
  await speech(page, 'idle');
  await context(page).click();
  await page.getByRole('button', { name: 'Close presentation' }).click();
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('data-retained-node', '');
  await expect(note).not.toHaveAttribute('inert', '');
});
