import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmblemImagePreparation } from './emblem-image-preparation';

function image(url: string, decode = vi.fn(() => Promise.resolve())) {
  const element = document.createElement('img');
  element.src = url;
  element.decode = decode;
  return element;
}

describe('emblem image preparation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces responsive resize/load bursts and decodes only the latest selected sources', async () => {
    const prepare = createEmblemImagePreparation(window);
    const small = image('/small.png');
    const large = image('/large.png');
    prepare.schedule([small]);
    await vi.advanceTimersByTimeAsync(100);
    prepare.schedule([large]);
    await vi.advanceTimersByTimeAsync(119);
    expect(small.decode).not.toHaveBeenCalled();
    expect(large.decode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(large.decode).toHaveBeenCalledOnce();
    prepare.dispose();
  });

  it('deduplicates shared originals by currentSrc and bounds concurrent work', async () => {
    const prepare = createEmblemImagePreparation(window);
    const finish: (() => void)[] = [];
    const images = Array.from({ length: 6 }, (_, index) =>
      image(
        `/source-${index}.png`,
        vi.fn(() => new Promise<void>((resolve) => finish.push(resolve))),
      ),
    );
    const duplicate = image('/source-0.png');
    Object.defineProperty(duplicate, 'currentSrc', { value: images[0].src });
    prepare.schedule([duplicate, ...images]);
    await vi.advanceTimersByTimeAsync(120);
    expect(duplicate.decode).not.toHaveBeenCalled();
    expect(
      images.map((element) => vi.mocked(element.decode).mock.calls.length),
    ).toEqual([1, 1, 1, 1, 0, 0]);
    finish[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(images[4].decode).toHaveBeenCalledOnce();
    prepare.cancel();
    for (const resolve of finish) resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(images[5].decode).not.toHaveBeenCalled();
    prepare.dispose();
  });

  it('does not let replaced/disposed jobs decode the remaining old images', async () => {
    const prepare = createEmblemImagePreparation(window);
    const finish: (() => void)[] = [];
    const old = Array.from({ length: 6 }, (_, index) =>
      image(
        `/old-${index}.png`,
        vi.fn(() => new Promise<void>((resolve) => finish.push(resolve))),
      ),
    );
    prepare.schedule(old);
    await vi.advanceTimersByTimeAsync(120);
    const replacement = image('/replacement.png');
    prepare.schedule([replacement]);
    for (const resolve of finish) resolve();
    await vi.advanceTimersByTimeAsync(120);
    expect(old[4].decode).not.toHaveBeenCalled();
    expect(old[5].decode).not.toHaveBeenCalled();
    expect(replacement.decode).toHaveBeenCalledOnce();
    prepare.schedule([replacement]);
    prepare.dispose();
    await vi.runAllTimersAsync();
    expect(replacement.decode).toHaveBeenCalledOnce();
  });

  it('tolerates source-change decode rejection and unsupported decoding without blocking other images', async () => {
    const prepare = createEmblemImagePreparation(window);
    const rejected = image(
      '/replaced.png',
      vi.fn(() => Promise.reject(new Error('source replaced'))),
    );
    const healthy = image('/healthy.png');
    const unsupported = document.createElement('img');
    prepare.schedule([rejected, healthy, unsupported]);
    await vi.runAllTimersAsync();
    expect(healthy.decode).toHaveBeenCalledOnce();
    prepare.dispose();
    const server = createEmblemImagePreparation(null);
    server.schedule([healthy]);
    expect(healthy.decode).toHaveBeenCalledOnce();
    server.dispose();
  });
});
