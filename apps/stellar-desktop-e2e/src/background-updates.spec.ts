import { expect, test } from '@playwright/test';
import type { IvySnapshot, SpeechSnapshot } from '@stellar/desktop-contracts';
import { decodeIvySnapshot } from '@stellar/desktop-contracts';
import { readFileSync } from 'node:fs';

const fixturePath = process.env['STELLAR_ORDINARY_SNAPSHOT_FIXTURE'];
function readNativeFixture() {
  if (fixturePath === undefined) return null;
  const value: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw Error('Expected disconnected native fixture');
  const data = value as Record<string, unknown>;
  const visible = decodeIvySnapshot(data['visible']);
  const claimed = decodeIvySnapshot(data['claimed']);
  const updates = visible.background_updates;
  const claims = claimed.background_updates;
  if (
    data['fixtureOnly'] !== true ||
    updates?.length !== 1 ||
    updates[0].id !== 'ordinary' ||
    updates[0].text !== 'Ordinary admitted answer 299' ||
    updates[0].speech_claim !== null ||
    claims?.length !== 1 ||
    claims[0].id !== updates[0].id ||
    claims[0].text !== updates[0].text ||
    !claims[0].speech_claim
  )
    throw Error('Missing native ordinary update and persisted claim');
  return { visible, claimed, fixtureOnly: true };
}
const nativeFixture = readNativeFixture();
const answer =
  nativeFixture?.visible.background_updates?.[0]?.text ??
  'The delegated change is ready for review.';

test('background update appears and speaks once without microphone input or another user message', async ({
  page,
}) => {
  await page.addInitScript((native) => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const result = {
      submissions: 0,
      speech: 0,
      lastSpeech: '',
      microphone: 0,
      claims: 0,
      ready: false,
    };
    let revision = 0;
    let state: IvySnapshot = {
      version: 1,
      revision: '0',
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
    let speech: SpeechSnapshot = {
      version: 1,
      revision: '0',
      epoch: '0',
      state: 'idle',
      operation_id: null,
      error: null,
    };
    const emit = (name: string, payload: unknown) =>
      callbacks.get(name)?.({ payload });
    const publish = () => {
      state = { ...state, revision: String(++revision) };
      emit('ivy-state', state);
      return state;
    };
    Object.assign(window, {
      __backgroundFixture: {
        result,
        complete: () => {
          state = {
            ...state,
            background_updates: native?.visible.background_updates ?? [
              {
                id: 'background-299',
                text: 'The delegated change is ready for review.',
                speech_claim: null,
              },
            ],
          };
          publish();
        },
        replay: () => publish(),
      },
      __TAURI__: {
        event: {
          listen: async (
            name: string,
            callback: (event: { payload: unknown }) => void,
          ) => {
            callbacks.set(name, callback);
            return () => callbacks.delete(name);
          },
        },
        core: {
          invoke: async (
            name: string,
            args: { request: Record<string, unknown> },
          ) => {
            if (name === 'app_info')
              return {
                version: 1,
                sequence: args.request['sequence'],
                application: 'Stellar Desktop',
                capabilities: [],
                build_revision: null,
              };
            if (name === 'ivy_connect' || name === 'ivy_snapshot') {
              result.ready = true;
              return publish();
            }
            if (name === 'ivy_submit') {
              result.submissions++;
              return publish();
            }
            if (name === 'ivy_claim_update') {
              result.claims++;
              state = {
                ...state,
                background_updates: state.background_updates?.map((update) =>
                  update.speech_claim
                    ? update
                    : {
                        ...update,
                        speech_claim: String(args.request['request_id']),
                      },
                ),
              };
              return publish();
            }
            if (name === 'speech_snapshot') return speech;
            if (name === 'speech_speak') {
              result.speech++;
              result.lastSpeech = String(args.request['text']);
              speech = {
                ...speech,
                revision: '1',
                operation_id: String(args.request['utterance_id']),
                state: 'speaking',
              };
              emit('speech-state', speech);
              setTimeout(() => {
                speech = { ...speech, revision: '2', state: 'idle' };
                emit('speech-state', speech);
              }, 100);
              return speech;
            }
            if (name === 'speech_stop') {
              speech = { ...speech, revision: '3', state: 'idle' };
              return speech;
            }
            throw new Error('Unexpected fixture command: ' + name);
          },
        },
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        result.microphone++;
        throw new Error('Microphone must remain unused');
      },
    });
  }, nativeFixture);
  await page.goto('/');
  const result = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __backgroundFixture: {
              result: {
                submissions: number;
                speech: number;
                lastSpeech: string;
                microphone: number;
                claims: number;
                ready: boolean;
              };
            };
          }
        ).__backgroundFixture.result,
    );
  await expect.poll(async () => (await result()).ready).toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { __backgroundFixture: { complete(): void } }
    ).__backgroundFixture.complete(),
  );
  await expect(page.locator('.assistant-reply')).toContainText(answer);
  await expect(page.locator('[data-background-update]')).toBeVisible();
  await expect(page.locator('[data-background-update]')).toContainText(answer);
  await expect.poll(async () => (await result()).speech).toBe(1);
  expect((await result()).lastSpeech).toBe(answer);
  await page.evaluate(() =>
    (
      window as unknown as { __backgroundFixture: { replay(): void } }
    ).__backgroundFixture.replay(),
  );
  await expect.poll(async () => (await result()).claims).toBe(1);
  expect(await result()).toMatchObject({
    speech: 1,
    submissions: 0,
    microphone: 0,
  });
  await page.getByRole('button', { name: 'Read update', exact: true }).click();
  await expect(page.locator('.assistant-reply')).toBeVisible();
});
