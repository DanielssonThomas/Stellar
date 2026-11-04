import { expect, test, type Page } from '@playwright/test';

async function reflexFlow(
  page: Page,
  input: 'typed' | 'voice',
  scenario:
    | 'on'
    | 'disabled'
    | 'unavailable'
    | 'cancelled'
    | 'github'
    | 'greeting' = 'on',
) {
  const message =
    scenario === 'github'
      ? 'Please show me my latest github issue'
      : scenario === 'greeting'
        ? 'Ivy, how are we doing today?'
        : 'Ivy, this song is terrible.';
  await page.addInitScript(
    ({ scenario, message }) => {
      const result = {
        calls: [] as string[],
        spoken: '',
        action: '',
        tracks: 0,
        actionsWithMic: -1,
        text: '',
        diagnostics: '',
      };
      const listeners = new Map<
        string,
        Set<(event: { payload: unknown }) => void>
      >();
      let revision = 0;
      let currentSpeech = {
        version: 1,
        revision: '0',
        epoch: '0',
        operation_id: null as string | null,
        state: 'idle',
        error: null,
      };
      const speech = (state: string, id: string | null) => {
        currentSpeech = {
          ...currentSpeech,
          revision: String(++revision),
          operation_id: id,
          state,
        };
        listeners
          .get('speech-state')
          ?.forEach((callback) => callback({ payload: currentSpeech }));
        return currentSpeech;
      };
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
        __reflexFixture: result,
        __TAURI__: {
          event: {
            listen: async (
              event: string,
              callback: (event: { payload: unknown }) => void,
            ) => {
              const group = listeners.get(event) ?? new Set();
              group.add(callback);
              listeners.set(event, group);
              return () => group.delete(callback);
            },
          },
          core: {
            invoke: async (
              command: string,
              args?: { request?: Record<string, unknown> },
            ) => {
              result.calls.push(command);
              const request = args?.request ?? {};
              if (command === 'app_info')
                return {
                  version: 1,
                  sequence: request['sequence'],
                  application: 'Stellar Desktop',
                  capabilities: [],
                  build_revision: null,
                };
              if (command === 'ivy_connect' || command === 'ivy_snapshot')
                return ivy();
              if (command === 'ivy_select_session') return ivy();
              if (command === 'ivy_submit') {
                result.text = String(request['text']);
                return {
                  ...ivy(),
                  turn_id: request['input_id'],
                  turn: 'completed',
                  first_text_observed: true,
                  items: [
                    {
                      kind: 'text',
                      text: 'Terra response from the connected session.',
                    },
                  ],
                };
              }
              if (command === 'reflex_route')
                return {
                  version: 1,
                  local: scenario !== 'github' && scenario !== 'greeting',
                };
              if (command === 'reflex_set_enabled') return;
              if (command === 'reflex_status')
                return { version: 1, configured: scenario !== 'unavailable' };
              if (command === 'reflex_prepare')
                return scenario === 'github' || scenario === 'greeting'
                  ? new Promise(() => undefined)
                  : { version: 1, configured: true };
              if (command === 'speech_snapshot') return currentSpeech;
              if (command === 'speech_stop') return speech('idle', null);
              if (command === 'speech_keywords')
                return {
                  sequence: request['sequence'],
                  detection:
                    request['mode'] === 'passive' &&
                    (request['pcm'] as number[]).some((v) => Math.abs(v) > 500)
                      ? { command: 'ivy', end_sample: 0 }
                      : null,
                };
              if (command === 'speech_collect')
                return {
                  version: 1,
                  utterance_id: request['utterance_id'],
                  text: message,
                };
              if (command === 'reflex_media_snapshot')
                return {
                  ticket: '1',
                  player: 'Safe fixture',
                  title: 'A terrible song',
                  playing: true,
                  volume: 50,
                  muted: false,
                  endpoint_id: 'fixture-output',
                  actions: ['next', 'pause', 'play', 'volume_down', 'inspect'],
                };
              if (command === 'reflex_infer') {
                if (scenario === 'cancelled')
                  await new Promise<void>((resolve) =>
                    Object.assign(window, { __finishReflex: resolve }),
                  );
                result.text = String(request['text']);
                const actions = request['actions'] as { id: string }[];
                if (!actions.some((a) => a.id === 'media.next'))
                  throw Error('Registry missing');
                return {
                  version: 1,
                  input_id: request['input_id'],
                  plan: {
                    route: 'action',
                    action_id: 'media.next',
                    reply: 'That song had it coming.',
                  },
                };
              }
              if (command === 'reflex_media_execute') {
                result.action = String(request['action']);
                result.actionsWithMic = result.tracks;
                return 'confirmed';
              }
              if (command === 'reflex_cancel') return;
              if (command === 'speech_speak') {
                if (
                  !result.action &&
                  scenario !== 'github' &&
                  scenario !== 'greeting'
                )
                  throw Error('Acknowledged before execution');
                result.spoken = String(request['text']);
                return speech('idle', String(request['utterance_id']));
              }
              throw Error('Unexpected fixture command: ' + command);
            },
          },
        },
      });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            result.diagnostics = text;
          },
        },
      });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: async () => {
          const context = new AudioContext(),
            oscillator = context.createOscillator(),
            gain = context.createGain(),
            destination = context.createMediaStreamDestination();
          oscillator.connect(gain).connect(destination);
          gain.gain.setValueAtTime(0, context.currentTime);
          gain.gain.setValueAtTime(0.2, context.currentTime + 1.1);
          gain.gain.setValueAtTime(0, context.currentTime + 2.6);
          oscillator.start();
          await context.resume();
          for (const track of destination.stream.getTracks()) {
            result.tracks++;
            const stop = track.stop.bind(track);
            let stopped = false;
            track.stop = () => {
              if (!stopped) result.tracks--;
              stopped = true;
              stop();
              void context.close();
            };
          }
          return destination.stream;
        },
      });
    },
    { scenario, message },
  );
  const fixture = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __reflexFixture: {
              calls: string[];
              action: string;
              spoken: string;
              text: string;
              diagnostics: string;
            };
          }
        ).__reflexFixture,
    );
  await page.goto('/');
  await page.keyboard.press('m');
  if (scenario !== 'unavailable') {
    await expect
      .poll(async () => (await fixture()).calls)
      .toContain('reflex_prepare');
    expect((await fixture()).calls).not.toContain('reflex_infer');
    expect((await fixture()).action).toBe('');
  }
  if (scenario === 'disabled') {
    const toggle = page.getByRole('switch', {
      name: 'Ivy Reflex',
      exact: true,
    });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await page.keyboard.press('m');
    await expect(
      page.getByRole('switch', { name: 'Ivy Reflex', exact: true }),
    ).not.toBeChecked();
    await expect(page.locator('#ivy-reflex-status')).toContainText('Disabled');
    expect((await fixture()).calls).not.toContain('reflex_prepare');
  }
  if (input === 'typed') {
    await page.getByPlaceholder('Type a message').fill(message);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  } else {
    await page
      .getByRole('button', { name: 'Enable microphone', exact: true })
      .click();
    await page.keyboard.press('Escape');
  }
  if (scenario === 'github' || scenario === 'greeting') {
    await expect
      .poll(async () => (await fixture()).calls)
      .toContain('ivy_submit');
    const result = await fixture();
    const admittedMessage =
      input === 'voice' ? message.replace(/^Ivy, /, '') : message;
    expect(result.text).toBe(admittedMessage);
    expect(result.calls).not.toContain('reflex_infer');
    expect(result.calls).not.toContain('reflex_media_snapshot');
    expect(result.action).toBe('');
    if (input === 'voice') await page.keyboard.press('m');
    await page
      .getByRole('button', { name: 'Request status · S', exact: true })
      .click();
    const status = page.locator('[data-request-status]');
    await expect(status).toContainText(admittedMessage);
    await expect(status).toContainText('Routed to Terra');
    await expect(status).toContainText('Response complete');
    await expect(status).not.toContainText('Action confirmed');
    await page
      .getByRole('button', { name: 'Hide request status', exact: true })
      .click();
    await page.keyboard.press('s');
    await expect(status).toBeVisible();
    await page.keyboard.press('s');
    await expect(status).toHaveCount(0);
    return scenario;
  }
  if (scenario === 'disabled' || scenario === 'unavailable') {
    await expect
      .poll(async () => (await fixture()).calls)
      .toContain('ivy_submit');
    expect((await fixture()).calls).not.toContain('reflex_infer');
    expect((await fixture()).action).toBe('');
    if (input === 'voice') await page.keyboard.press('m');
    await expect(page.locator('#ivy-reflex-status')).toContainText('Hermes');
    return scenario;
  }
  if (scenario === 'cancelled') {
    await expect
      .poll(async () => (await fixture()).calls)
      .toContain('reflex_infer');
    if (input === 'voice') await page.keyboard.press('m');
    await page.getByRole('switch', { name: 'Ivy Reflex', exact: true }).click();
    await page.evaluate(() =>
      (window as unknown as { __finishReflex: () => void }).__finishReflex(),
    );
    await expect
      .poll(async () => (await fixture()).calls)
      .toContain('reflex_cancel');
    await expect(page.locator('#ivy-reflex-status')).toContainText('cancelled');
    expect((await fixture()).action).toBe('');
    expect((await fixture()).calls).not.toContain('ivy_submit');
    return scenario;
  }
  await expect
    .poll(async () => (await fixture()).action, { timeout: 15000 })
    .toBe('next');
  if (input === 'voice')
    await expect
      .poll(async () => (await fixture()).spoken)
      .toBe('That song had it coming.');
  expect((await fixture()).calls).not.toContain('ivy_submit');
  expect((await fixture()).calls).not.toContain('ivy_select_session');
  expect((await fixture()).text).toContain('this song is terrible');
  const timings = await page.evaluate(() =>
    performance
      .getEntriesByName('stellar.reflex.latency')
      .map((e) => (e as PerformanceMeasure).detail),
  );
  expect(timings).toContainEqual(
    expect.objectContaining({
      outcome: 'confirmed',
      stages_ms: expect.objectContaining({
        action_complete: expect.any(Number),
      }),
    }),
  );
  if (input === 'voice') await page.keyboard.press('m');
  await expect(page.locator('#ivy-reflex-status')).toContainText(
    'Reflex · confirmed',
  );
  await page
    .getByRole('button', { name: 'Copy Reflex diagnostics', exact: true })
    .click();
  await expect
    .poll(async () => (await fixture()).diagnostics)
    .toContain('reflex_summary');
  const diagnostics = JSON.parse((await fixture()).diagnostics);
  expect(diagnostics.last_route).toBe('Reflex · confirmed');
  expect(diagnostics.reflex_summary.confirmed).toBe(1);
  expect((await fixture()).diagnostics).not.toContain('terrible');
  expect((await fixture()).diagnostics).not.toContain(
    'That song had it coming',
  );
  await page
    .getByRole('button', { name: 'Request status · S', exact: true })
    .click();
  await expect(page.locator('[data-request-status]')).toContainText(
    'Action confirmed',
  );
  await expect(page.locator('[data-request-status]')).toContainText('Reflex');
  if (input === 'voice')
    await expect(page.locator('[data-request-status]')).toContainText(
      'Voice complete',
    );
  if (input === 'typed') {
    await expect(page.locator('[data-request-status]')).toHaveCSS(
      'opacity',
      '1',
    );
    await test.info().attach('request-status-desktop', {
      body: await page.screenshot({
        path: test.info().outputPath('request-status-desktop.png'),
      }),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const status = page.locator('[data-request-status]');
    await expect(status).toBeVisible();
    const bounds = await status.boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390).toBe(
      true,
    );
    await expect(page.locator('[data-request-status] .orbit')).toHaveCSS(
      'animation-name',
      'none',
    );
    await test.info().attach('request-status-narrow', {
      body: await page.screenshot({
        path: test.info().outputPath('request-status-narrow.png'),
      }),
      contentType: 'image/png',
    });
  }
  if (input === 'voice') {
    const voiceTimings = await page.evaluate(() =>
      performance
        .getEntriesByName('stellar.voice.latency')
        .map((e) => (e as PerformanceMeasure).detail),
    );
    expect(voiceTimings).toContainEqual(
      expect.objectContaining({
        stages_ms: expect.objectContaining({
          stt_completed: expect.any(Number),
          action_complete: expect.any(Number),
        }),
      }),
    );
  }
  return scenario;
}

for (const input of ['typed', 'voice'] as const) {
  test(`${input} request confirms a local media action without Hermes`, async ({
    page,
  }) => {
    expect(await reflexFlow(page, input)).toBe('on');
  });
  for (const scenario of [
    'disabled',
    'unavailable',
    'cancelled',
    'github',
    'greeting',
  ] as const) {
    test(`${input} Reflex ${scenario} preserves routing and dispatch safety`, async ({
      page,
    }) => {
      expect(await reflexFlow(page, input, scenario)).toBe(scenario);
    });
  }
}
