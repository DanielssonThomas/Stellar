import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  speechSpeakCommand,
  speechSetDuckingCommand,
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

  it('retires exact-instance idle evidence across global stop epochs beyond capacity', async () => {
    let state = initialSpeechSnapshot();
    let serial = 0;
    const invoke = vi.fn(
      async (command: string, args: { request: Record<string, unknown> }) => {
        if (command === speechSetDuckingCommand) return null;
        if (command === speechSpeakCommand)
          state = {
            ...state,
            operation_id: String(args.request['utterance_id']),
            operation_instance: (++serial).toString(16).padStart(32, '0'),
            state: 'synthesizing',
            revision: String(BigInt(state.revision) + 1n),
          };
        if (command === speechStopCommand)
          state = {
            ...state,
            epoch: String(BigInt(state.epoch) + 1n),
            state: 'idle',
            revision: String(BigInt(state.revision) + 1n),
          };
        return state;
      },
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: { invoke, listen: async () => () => undefined },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    for (let n = 0; n < 40; n++) {
      await service.speak('Ordinary user narration', crypto.randomUUID());
      await service.stop();
    }
    expect(serial).toBe(40);
    expect(service.state().state).toBe('idle');
  });

  it('does not retain custody for failed preparation when no dispatch occurred', async () => {
    let attempts = 0;
    const invoke = vi.fn(async () => {
      attempts++;
      throw new Error('Fixture unavailable');
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
    for (let n = 0; n < 40; n++)
      await expect(
        service.speak('Not dispatched', crypto.randomUUID()),
      ).rejects.toMatchObject({ kind: 'transport' });
    expect(attempts).toBe(40);
    expect(invoke).not.toHaveBeenCalledWith(
      speechSpeakCommand,
      expect.anything(),
    );
  });

  it('fences revoked speech after preparation without stopping foreground workers', async () => {
    let ready!: (value: () => void) => void;
    let current = true;
    const invoke = vi.fn(async () => initialSpeechSnapshot());
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: {
            invoke,
            listen: () =>
              new Promise<() => void>((done) => {
                ready = done;
              }),
          },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    const pending = service.speak(
      'Revoked before native dispatch',
      id,
      () => current,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
    });
    current = false;
    await service.stopOperation(id);
    ready(() => undefined);
    await rejected;
    expect(invoke).not.toHaveBeenCalledWith(
      speechSpeakCommand,
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      speechStopCommand,
      expect.anything(),
    );
  });

  it('uses the late original ACK for exact stop while preserving a replacement snapshot', async () => {
    let ack!: (value: unknown) => void;
    let receive!: (value: unknown) => void;
    const original = {
      ...initialSpeechSnapshot(),
      operation_id: id,
      operation_instance: 'a'.repeat(32),
      revision: '1',
      state: 'synthesizing' as const,
    };
    const replacement = {
      ...original,
      operation_instance: 'b'.repeat(32),
      revision: '3',
      state: 'speaking' as const,
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === speechSpeakCommand)
        return new Promise((done) => {
          ack = done;
        });
      if (command === speechStopCommand) return replacement;
      return initialSpeechSnapshot();
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: {
            invoke,
            listen: async (_: string, callback: (value: unknown) => void) => {
              receive = callback;
              return () => undefined;
            },
          },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    const pending = service.speak('Original notification', id);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
    });
    await vi.waitFor(() => expect(ack).toBeTypeOf('function'));
    await service.stopOperation(id); // No receipt yet: no global stop or invented success.
    receive(replacement);
    ack(original);
    await rejected;
    expect(invoke).toHaveBeenCalledWith(speechStopCommand, {
      request: {
        version: 1,
        epoch: '0',
        target: { operation_id: id, operation_instance: 'a'.repeat(32) },
      },
    });
    expect(service.state()).toEqual(replacement);
    await expect(
      service.speak('Same ID cannot redirect old cancellation', id),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('retains active and unknown cancellation custody under capacity pressure', async () => {
    const original = {
      ...initialSpeechSnapshot(),
      operation_id: id,
      operation_instance: 'a'.repeat(32),
      revision: '1',
      state: 'synthesizing' as const,
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === speechSpeakCommand) return original;
      return initialSpeechSnapshot();
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
    await service.speak('Original', id);
    for (let n = 0; n < 32; n++)
      await service.speak('Other', crypto.randomUUID()).catch(() => undefined);
    await service.stopOperation(id);
    expect(invoke).toHaveBeenCalledWith(speechStopCommand, {
      request: {
        version: 1,
        epoch: '0',
        target: { operation_id: id, operation_instance: 'a'.repeat(32) },
      },
    });
  });

  it('initializes native readiness once without loading models or transcribing audio', async () => {
    const invoke = vi.fn(async () => initialSpeechSnapshot());
    const listen = vi.fn(async () => () => undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: SPEECH_TRANSPORT, useValue: { invoke, listen } }],
    });
    const service = TestBed.inject(SpeechAdapterService);
    await Promise.all([service.initialize(), service.initialize()]);
    expect(listen).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith(speechSnapshotCommand, {
      request: { version: 1 },
    });
  });

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
        if (command === speechSetDuckingCommand) return null;
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
      speechSetDuckingCommand,
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
      if (command === speechSetDuckingCommand) return null;
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

  it('ducks for unprompted speech without a microphone and retains ownership through playback', async () => {
    let receive!: (payload: unknown) => void;
    const levels: boolean[] = [];
    const invoke = vi.fn<SpeechTransport['invoke']>(async (command, args) => {
      if (command === speechSetDuckingCommand) {
        levels.push((args.request as { active: boolean }).active);
        return null;
      }
      if (command === speechSpeakCommand)
        return {
          ...initialSpeechSnapshot(),
          state: 'synthesizing',
          operation_id: id,
          revision: '1',
        };
      return initialSpeechSnapshot();
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: {
            invoke,
            listen: async (
              _event: string,
              callback: (payload: unknown) => void,
            ) => {
              receive = callback;
              return () => undefined;
            },
          },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    await service.speak('Your delegated task is finished.', id);
    await vi.waitFor(() => expect(levels).toEqual([true]));
    service.setDucking(false);
    receive({
      ...initialSpeechSnapshot(),
      state: 'speaking',
      operation_id: id,
      revision: '2',
    });
    await Promise.resolve();
    expect(levels).toEqual([true]);
    receive({ ...initialSpeechSnapshot(), revision: '3' });
    await vi.waitFor(() => expect(levels).toEqual([true, false]));
  });

  it('releases failed speech and preserves an overlapping foreground voice lease', async () => {
    const levels: boolean[] = [];
    const invoke = vi.fn<SpeechTransport['invoke']>(async (command, args) => {
      if (command === speechSetDuckingCommand) {
        levels.push((args.request as { active: boolean }).active);
        return null;
      }
      if (command === speechSpeakCommand) throw 'unavailable';
      return initialSpeechSnapshot();
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SPEECH_TRANSPORT,
          useValue: {
            invoke,
            listen: async () => () => undefined,
          },
        },
      ],
    });
    const service = TestBed.inject(SpeechAdapterService);
    service.setDucking(true);
    await expect(service.speak('Update', id)).rejects.toThrow();
    await vi.waitFor(() => expect(levels).toEqual([true]));
    service.setDucking(false);
    await vi.waitFor(() => expect(levels).toEqual([true, false]));
  });
});
