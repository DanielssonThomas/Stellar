import { expect, test, type Page } from '@playwright/test';

async function reflexFlow(page: Page, input: 'typed' | 'voice') {
  await page.addInitScript(() => {
    const result = {
      calls: [] as string[],
      spoken: '',
      action: '',
      tracks: 0,
      actionsWithMic: -1,
      text: '',
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
                text: 'Ivy, this song is terrible.',
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
              if (!result.action) throw Error('Acknowledged before execution');
              result.spoken = String(request['text']);
              return speech('idle', String(request['utterance_id']));
            }
            throw Error('Unexpected fixture command: ' + command);
          },
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
  });
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
            };
          }
        ).__reflexFixture,
    );
  await page.goto('/');
  await page.keyboard.press('m');
  if (input === 'typed') {
    await page
      .getByPlaceholder('Type a message')
      .fill('Ivy, this song is terrible.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  } else {
    await page
      .getByRole('button', { name: 'Enable microphone', exact: true })
      .click();
    await page.keyboard.press('Escape');
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
}

for (const input of ['typed', 'voice'] as const) {
  test(`${input} request confirms a local media action without Hermes`, async ({
    page,
  }) => {
    await reflexFlow(page, input);
  });
}
