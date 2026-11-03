import { expect, test } from '@playwright/test';
import type { IvySnapshot, SpeechSnapshot } from '@stellar/desktop-contracts';

test('continuous synthetic audio reaches one Ivy turn, local playback and requested content', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    const results = {
      calls,
      inputId: '',
      speechId: '',
      sampleCount: 0,
      stopped: false,
      acquisitions: 0,
      activeTracks: 0,
      transcribeActive: -1,
      speakActive: -1,
      submitActive: -1,
    };
    const callbacks = new Map<
      string,
      Set<(event: { payload: unknown }) => void>
    >();
    const emit = (event: string, payload: unknown) =>
      callbacks.get(event)?.forEach((callback) => callback({ payload }));
    let initialSnapshot = true;
    let ivyRevision = 0,
      speechRevision = 0;
    let currentSpeech: SpeechSnapshot = {
      version: 1,
      revision: '0',
      epoch: '0',
      operation_id: null,
      state: 'idle',
      error: null,
    };
    const ivy = (turn_id: string | null = null): IvySnapshot => ({
      version: 1,
      revision: String(++ivyRevision),
      turn_id,
      model: 'terra',
      verified_model: null,
      workspace_tools: 'unavailable',
      workspace_epoch: '0',
      connection: 'ready',
      turn: 'idle',
      items: [],
      error: null,
    });
    const speech = (
      state: SpeechSnapshot['state'],
      operation_id: string,
    ): SpeechSnapshot =>
      (currentSpeech = {
        version: 1,
        epoch: currentSpeech.epoch,
        revision: String(++speechRevision),
        operation_id,
        state,
        error: null,
      });
    Object.assign(window, {
      __voiceFixture: results,
      __TAURI__: {
        event: {
          listen: async (
            event: string,
            callback: (event: { payload: unknown }) => void,
          ) => {
            const entries = callbacks.get(event) ?? new Set();
            entries.add(callback);
            callbacks.set(event, entries);
            return () => {
              entries.delete(callback);
            };
          },
        },
        core: {
          invoke: async (
            command: string,
            args: { request: Record<string, unknown> },
          ) => {
            calls.push(command);
            const request = args.request;
            if (command === 'app_info')
              return {
                version: 1,
                sequence: request['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (command === 'ivy_connect') return ivy();
            if (command === 'ivy_snapshot') {
              if (initialSnapshot) {
                initialSnapshot = false;
                throw new Error('Temporary snapshot failure');
              }
              return ivy();
            }
            if (command === 'ivy_select_session')
              return { ...ivy(), model: request['model'] };
            if (command === 'speech_snapshot') return currentSpeech;
            if (command === 'speech_collect') {
              results.transcribeActive = results.activeTracks;
              results.speechId = String(request['utterance_id']);
              results.sampleCount = (request['pcm'] as number[]).length;
              emit('speech-state', speech('collecting', results.speechId));
              await new Promise((done) => setTimeout(done, 20));
              emit('speech-state', speech('idle', results.speechId));
              return {
                version: 1,
                utterance_id: results.speechId,
                text: 'Ivy, Show the requested fixture content',
              };
            }
            if (command === 'ivy_submit') {
              results.submitActive = results.activeTracks;
              results.inputId = String(request['input_id']);
              const completed: IvySnapshot = {
                ...ivy(results.inputId),
                turn: 'completed',
                items: [
                  { kind: 'text', text: 'Voice fixture reply' },
                  {
                    kind: 'component',
                    component: 'assistant_message',
                    title: 'Requested voice content',
                    body: 'Trusted synthetic fixture',
                  },
                ],
              };
              emit('ivy-state', completed);
              return completed;
            }
            if (command === 'speech_speak') {
              results.speakActive = results.activeTracks;
              const accepted = speech(
                'synthesizing',
                String(request['utterance_id']),
              );
              emit('speech-state', accepted);
              setTimeout(
                () =>
                  emit(
                    'speech-state',
                    speech('speaking', String(request['utterance_id'])),
                  ),
                1800,
              );
              setTimeout(
                () =>
                  emit(
                    'speech-state',
                    speech('idle', String(request['utterance_id'])),
                  ),
                3600,
              );
              return accepted;
            }
            if (command === 'speech_stop') {
              currentSpeech = {
                ...currentSpeech,
                epoch: String(BigInt(currentSpeech.epoch) + 1n),
              };
              return speech('idle', results.speechId);
            }
            throw new Error('Unexpected fixture command');
          },
        },
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        results.acquisitions++;
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.gain.setValueAtTime(0.2, context.currentTime + 1.1);
        gain.gain.setValueAtTime(0, context.currentTime + 2.6);
        oscillator.start();
        await context.resume();
        for (const track of destination.stream.getTracks()) {
          results.activeTracks++;
          let stopped = false;
          const stop = track.stop.bind(track);
          track.stop = () => {
            if (!stopped) results.activeTracks--;
            stopped = true;
            results.stopped = true;
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
            __voiceFixture: {
              calls: string[];
              inputId: string;
              speechId: string;
              sampleCount: number;
              stopped: boolean;
              acquisitions: number;
              activeTracks: number;
              transcribeActive: number;
              speakActive: number;
              submitActive: number;
            };
          }
        ).__voiceFixture,
    );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page.getByRole('button', { name: 'Retry voice', exact: true }).click();
  await expect(page.getByText('Ivy connected', { exact: true })).toBeVisible();
  expect(
    (await fixture()).calls.filter(
      (command) => command.startsWith('speech_') || command === 'ivy_submit',
    ),
  ).toEqual([]);
  await page
    .getByRole('button', { name: 'Enable microphone', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Assistant message' });
  await expect(panel).toContainText('Requested voice content', {
    timeout: 15000,
  });
  await expect
    .poll(
      async () =>
        (await fixture()).calls.filter((command) => command === 'speech_speak')
          .length,
    )
    .toBe(1);
  await expect(page.locator('.waiting-ring')).toBeVisible();
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '0.68');
  await expect(page.locator('.waiting-ring')).toHaveCount(0);
  await expect(page.locator('.emblem-presence')).toHaveCSS('opacity', '1');
  const result = await fixture();
  expect(result.inputId).toBe(result.speechId);
  expect(result.transcribeActive).toBe(1);
  expect(result.speakActive).toBe(0);
  expect(result.submitActive).toBe(0);
  await expect.poll(async () => (await fixture()).acquisitions).toBe(2);
  await expect.poll(async () => (await fixture()).activeTracks).toBe(1);
  expect(result.sampleCount).toBeGreaterThan(24000);
  expect(result.sampleCount).toBeLessThanOrEqual(320000);
  expect(
    result.calls.filter((command) => command === 'ivy_submit'),
  ).toHaveLength(1);
  await expect
    .poll(
      async () => (await page.locator('.emblem-slot').boundingBox())?.x ?? 0,
    )
    .toBeGreaterThan(900);
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Stop microphone', exact: true })
    .click();
  await expect.poll(async () => (await fixture()).activeTracks).toBe(0);
  await expect(panel).toBeVisible();
  await page
    .getByRole('button', { name: 'Experience menu', exact: true })
    .click();
  await panel.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(
    (await fixture()).calls.filter((command) => command === 'ivy_submit'),
  ).toHaveLength(1);
});
