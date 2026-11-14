import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  speechSpeakCommand,
  speechSetDuckingCommand,
  speechStopCommand,
} from '@stellar/desktop-contracts';
import { initialSpeechSnapshot } from '../speech/speech-transport';
import {
  SPEECH_TRANSPORT,
  SpeechAdapterService,
} from './speech-adapter.service';

describe('definitive speech refusal bookkeeping', () => {
  afterEach(() => TestBed.resetTestingModule());

  it.each(['busy', 'malformed_request', 'unsupported_version'] as const)(
    'retains used IDs without exhausting operations after native %s',
    async (code) => {
      let state = initialSpeechSnapshot();
      let refused = true;
      let attempts = 0;
      const invoke = vi.fn(
        async (command: string, args: { request: Record<string, unknown> }) => {
          if (command === speechSetDuckingCommand) return null;
          if (command === speechSpeakCommand) {
            attempts++;
            if (refused) throw code;
            state = {
              ...state,
              revision: String(BigInt(state.revision) + 1n),
              operation_id: String(args.request['utterance_id']),
              operation_instance: 'a'.repeat(32),
              state: 'speaking',
            };
          }
          if (command === speechStopCommand)
            state = {
              ...state,
              epoch: String(BigInt(state.epoch) + 1n),
              revision: String(BigInt(state.revision) + 1n),
              state: 'idle',
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
      const used = crypto.randomUUID();
      for (let n = 0; n < 40; n++) {
        await expect(
          service.speak('Refused', n === 0 ? used : crypto.randomUUID()),
        ).rejects.toMatchObject({ kind: 'native', code });
        await service.stop();
      }
      expect(attempts).toBe(40);
      await expect(service.speak('Reused', used)).rejects.toMatchObject({
        code: 'busy',
      });
      expect(attempts).toBe(40);
      refused = false;
      await expect(
        service.speak('Accepted', crypto.randomUUID()),
      ).resolves.toMatchObject({ state: 'speaking' });
      expect(attempts).toBe(41);
    },
  );

  it.each([
    'transport',
    'contract',
    'unavailable',
    'timeout',
    'cancelled',
  ] as const)(
    'does not retire uncertain %s dispatches after global recovery',
    async (failure) => {
      let state = initialSpeechSnapshot();
      let attempts = 0;
      const invoke = vi.fn(async (command: string) => {
        if (command === speechSetDuckingCommand) return null;
        if (command === speechSpeakCommand) {
          attempts++;
          if (failure === 'contract') return {};
          if (failure === 'transport')
            throw new Error('Unknown acknowledgment');
          throw failure;
        }
        if (command === speechStopCommand)
          state = {
            ...state,
            epoch: String(BigInt(state.epoch) + 1n),
            revision: String(BigInt(state.revision) + 1n),
          };
        return state;
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
      for (let n = 0; n < 32; n++) {
        await expect(
          service.speak('Unknown', crypto.randomUUID()),
        ).rejects.toBeDefined();
        await service.stop();
      }
      await expect(
        service.speak('Capacity', crypto.randomUUID()),
      ).rejects.toMatchObject({ code: 'busy' });
      expect(attempts).toBe(32);
    },
  );
});
