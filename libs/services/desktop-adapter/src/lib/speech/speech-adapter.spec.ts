import { describe, expect, it, vi } from 'vitest';
import { SpeechAdapter } from './speech-adapter';
import {
  initialSpeechSnapshot,
  type SpeechTransport,
} from './speech-transport';

const id = '11111111-2222-4333-8444-555555555555';
const audio = {
  version: 1,
  utterance_id: id,
  sample_rate_hz: 16000,
  pcm: [0, -32768, 32767],
};

describe('speech adapter boundary', () => {
  it('rejects input before transport and sanitizes private transport failures', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error('private path or token'));
    const adapter = new SpeechAdapter({
      invoke,
      listen: async () => () => undefined,
    });
    await expect(
      adapter.transcribe({ ...audio, sample_rate_hz: 48000 }),
    ).rejects.toMatchObject({ kind: 'contract' });
    expect(invoke).not.toHaveBeenCalled();
    await expect(adapter.transcribe(audio)).rejects.toThrow(
      'Speech adapter: transport',
    );
  });

  it('binds transcripts to their requested utterance and preserves typed model failures', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        version: 1,
        utterance_id: '22222222-2222-4333-8444-555555555555',
        text: 'wrong turn',
      })
      .mockRejectedValueOnce('model_missing');
    const adapter = new SpeechAdapter({
      invoke,
      listen: async () => () => undefined,
    });
    await expect(adapter.transcribe(audio)).rejects.toMatchObject({
      kind: 'contract',
    });
    await expect(adapter.transcribe(audio)).rejects.toMatchObject({
      kind: 'native',
      code: 'model_missing',
    });
  });

  it('releases a late listener after disposal and ignores stale callbacks', async () => {
    let resolve!: (stop: () => void) => void;
    let receive!: (payload: unknown) => void;
    const unlisten = vi.fn();
    const transport: SpeechTransport = {
      invoke: vi.fn(),
      listen: (_event, callback) => {
        receive = callback;
        return new Promise((done) => {
          resolve = done;
        });
      },
    };
    const adapter = new SpeechAdapter(transport);
    const changed = vi.fn(),
      failed = vi.fn();
    const listening = adapter.subscribe(changed, failed);
    receive({ ...initialSpeechSnapshot(), state: 'unknown' });
    expect(failed).toHaveBeenCalledOnce();
    adapter.dispose();
    resolve(unlisten);
    await listening;
    receive(initialSpeechSnapshot());
    expect(changed).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
