import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  speechSpeakCommand,
  speechSnapshotCommand,
  speechStopCommand,
  speechTranscribeCommand,
} from '@stellar/desktop-contracts';
import {
  initialSpeechSnapshot,
  type SpeechTransport,
} from '../speech/speech-transport';
import {
  SPEECH_TRANSPORT,
  SpeechAdapterService,
} from './speech-adapter.service';

const id = '11111111-2222-4333-8444-555555555555';

describe('speech service ownership', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('clears a local stop failure when a confirmed retry returns the same idle revision', async () => {
    const idle = { ...initialSpeechSnapshot(), revision: '5' };
    let stops = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === speechStopCommand && ++stops === 2)
        throw new Error('private transport failure');
      return idle;
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: { invoke, listen: async () => () => undefined },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    await service.stop();
    await expect(service.stop()).rejects.toThrow();
    expect(service.state()).toMatchObject({
      state: 'unavailable',
      revision: '5',
    });
    await service.stop();
    expect(service.state()).toEqual(idle);
  });

  it('does no model work at startup and preserves newer speech events over older acknowledgements', async () => {
    let receive!: (payload: unknown) => void;
    const order: string[] = [];
    const transport: SpeechTransport = {
      listen: async (_event, callback) => {
        order.push('listen');
        receive = callback;
        return vi.fn(() => undefined);
      },
      invoke: vi.fn(async (command) => {
        order.push(command);
        if (command === speechSnapshotCommand) return initialSpeechSnapshot();
        receive({
          ...initialSpeechSnapshot(),
          revision: '3',
          operation_id: id,
          state: 'speaking',
        });
        return {
          ...initialSpeechSnapshot(),
          revision: '2',
          operation_id: id,
          state: 'synthesizing',
        };
      }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: SPEECH_TRANSPORT, useValue: transport }],
    });
    const service = TestBed.inject(SpeechAdapterService);
    expect(order).toEqual([]);
    await service.speak('A local reply', id);
    expect(order).toEqual([
      'listen',
      speechSnapshotCommand,
      speechSpeakCommand,
    ]);
    expect(service.state().state).toBe('speaking');
    receive({ ...initialSpeechSnapshot(), revision: '1' });
    expect(service.state().revision).toBe('3');
  });

  it.each(['transcribe', 'speak'] as const)(
    'does not dispatch deferred %s after explicit stop',
    async (operation) => {
      let resolve!: (stop: () => void) => void;
      const invoke = vi.fn(async () => ({
        ...initialSpeechSnapshot(),
        revision: '1',
      }));
      TestBed.configureTestingModule({
        providers: [
          {
            provide: SPEECH_TRANSPORT,
            useValue: {
              invoke,
              listen: () =>
                new Promise<() => void>((done) => {
                  resolve = done;
                }),
            },
          },
        ],
      });
      const service = TestBed.inject(SpeechAdapterService);
      const pending =
        operation === 'speak'
          ? service.speak('Must not play', id)
          : service.transcribe(new Int16Array([1]), id);
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'cancelled',
      });
      await service.stop();
      resolve(vi.fn());
      await rejected;
      expect(invoke).toHaveBeenCalledWith(speechStopCommand, {
        request: { version: 1, epoch: '0' },
      });
      expect(invoke).not.toHaveBeenCalledWith(
        operation === 'speak' ? speechSpeakCommand : speechTranscribeCommand,
        expect.anything(),
      );
      expect(service.state().error).toBeNull();
    },
  );

  it('does not dispatch a deferred operation after component disposal', async () => {
    let resolve!: (stop: () => void) => void;
    const invoke = vi.fn(),
      unlisten = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: {
            invoke,
            listen: () =>
              new Promise<() => void>((done) => {
                resolve = done;
              }),
          },
        },
      ],
    });
    const pending = TestBed.inject(SpeechAdapterService).speak(
      'Must not play',
      id,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      kind: 'disposed',
    });
    TestBed.resetTestingModule();
    resolve(unlisten);
    await rejected;
    expect(invoke).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('synchronizes the native epoch after renderer reload and uses the new epoch after stopping', async () => {
    let epoch = '9';
    let revision = 20;
    const invoke = vi.fn<SpeechTransport['invoke']>(async (command, args) => {
      if (command === speechSnapshotCommand)
        return {
          ...initialSpeechSnapshot(),
          epoch,
          revision: String(revision),
        };
      if (command === speechStopCommand) {
        expect(args.request).toEqual({ version: 1, epoch });
        epoch = String(BigInt(epoch) + 1n);
        return {
          ...initialSpeechSnapshot(),
          epoch,
          revision: String(++revision),
        };
      }
      expect(args.request).toMatchObject({ epoch });
      if (command === speechTranscribeCommand)
        return { version: 1, utterance_id: id, text: '' };
      return {
        ...initialSpeechSnapshot(),
        epoch,
        revision: String(++revision),
        state: 'synthesizing',
        operation_id: id,
      };
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: { invoke, listen: async () => () => undefined },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    expect(invoke).not.toHaveBeenCalled();
    await service.speak('A local reply', id);
    await service.stop();
    await service.transcribe(new Int16Array([1]), id);
    expect(epoch).toBe('10');
  });
});
