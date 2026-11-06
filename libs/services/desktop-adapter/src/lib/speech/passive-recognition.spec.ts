import { describe, expect, it, vi } from 'vitest';
import { PassiveRecognition } from './passive-recognition';
import type { ActivitySnapshot } from '@stellar/service-audio-activity';
const activity = (active: boolean): ActivitySnapshot => ({
  active,
  starting: active,
  calibrating: false,
  level: 0.1,
  peakLevel: 0.1,
  durationMs: 0,
  noiseFloor: 0.001,
  clipped: false,
});
function fixture() {
  let sequence = 0;
  const collect = vi.fn(async (_pcm: Int16Array, id: string) => ({
    version: 1,
    utterance_id: id,
    text: 'Passive speech',
  }));
  const completed = vi.fn();
  const observer = new PassiveRecognition({
    collect,
    completed,
    id: () => 'utterance',
  });
  const feed = (active: boolean, count: number) => {
    for (let i = 0; i < count; i++) {
      const samples = new Int16Array(640).fill(active ? 3000 : 0);
      observer.push(
        { sampleRate: 16000, sequence: sequence++, samples },
        activity(active),
      );
      samples.fill(0);
    }
  };
  return {
    observer,
    collect,
    completed,
    feed,
    utterance: () => {
      feed(true, 10);
      feed(false, 21);
    },
  };
}
describe('bounded passive recognition', () => {
  it('recognizes one settled local utterance and erases PCM after completion', async () => {
    const f = fixture();
    f.utterance();
    await f.observer.wait();
    expect(f.completed).toHaveBeenCalledExactlyOnceWith('Passive speech');
    expect(f.collect.mock.calls[0][0].every((sample) => sample === 0)).toBe(
      true,
    );
  });
  it('fences recognition after wake, setting-off or reset without canceling a shared keyword worker', async () => {
    const f = fixture();
    let complete!: (value: {
      version: number;
      utterance_id: string;
      text: string;
    }) => void;
    f.collect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    f.utterance();
    const pending = f.observer.wait();
    f.observer.reset();
    f.utterance();
    expect(f.collect).toHaveBeenCalledOnce();
    complete({
      version: 1,
      utterance_id: 'utterance',
      text: 'Must not display',
    });
    await pending;
    expect(f.completed).not.toHaveBeenCalled();
    f.utterance();
    await f.observer.wait();
    expect(f.completed).toHaveBeenCalledOnce();
  });
  it('drops capped continuous speech instead of queueing unbounded audio', async () => {
    const f = fixture();
    f.feed(true, 510);
    f.feed(false, 21);
    await f.observer.wait();
    expect(f.collect).not.toHaveBeenCalled();
  });
});
