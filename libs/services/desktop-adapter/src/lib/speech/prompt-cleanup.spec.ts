import { describe, expect, it, vi } from 'vitest';
import { createPromptCleanup } from './prompt-cleanup';

describe('prompt cleanup', () => {
  it('falls back when a rewrite removes a protected path, including a retracted path', async () => {
    const raw =
      'Um, open C:\\Work\\app.ts, no, use C:\\Work\\main.ts and keep ID ABC-42.';
    const refined = 'Open C:\\Work\\main.ts and keep ID ABC-42.';
    const provider = vi.fn().mockResolvedValue(refined);
    const result = await createPromptCleanup(provider)(
      raw,
      new AbortController().signal,
    );
    expect(result).toEqual({ raw, text: raw, status: 'fallback' });
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][0]).toBe(raw);
  });

  it.each([
    ['Keep ID ALPHA-42', 'Keep ID ALPHA-420'],
    ['Read /tmp/input.txt', 'Read /tmp/input.txt.bak'],
    ['Update src/app/main.ts', 'Update lib/app/main.ts'],
    ['Read ./config.json', 'Read ../config.json'],
    ['Read ../config.json', 'Read ./config.json'],
    ['Update src\\app\\main.ts', 'Update lib\\app\\main.ts'],
  ])(
    'rejects a protected token extended in the rewrite',
    async (raw, output) => {
      expect(
        await createPromptCleanup(vi.fn().mockResolvedValue(output))(
          raw,
          new AbortController().signal,
        ),
      ).toEqual({ raw, text: raw, status: 'fallback' });
    },
  );

  it('accepts an unchanged complete relative path', async () => {
    const raw = 'Um, update src/app/main.ts.';
    const text = 'Update src/app/main.ts.';
    expect(
      await createPromptCleanup(vi.fn().mockResolvedValue(text))(
        raw,
        new AbortController().signal,
      ),
    ).toEqual({ raw, text, status: 'refined' });
  });

  it('keeps the exact raw input on unavailable, rejected, empty, or malformed output', async () => {
    const raw = '  keep ABC-42 and C:\\work\\file.ts  ';
    const signal = new AbortController().signal;
    const providers = [
      undefined,
      vi.fn().mockRejectedValue(new Error('secret')),
      ...['', '  ', null, { text: 'changed' }, 'bad\0text'].map((output) =>
        vi.fn().mockResolvedValue(output),
      ),
    ];
    for (const provider of providers)
      expect(await createPromptCleanup(provider)(raw, signal)).toEqual({
        raw,
        text: raw,
        status: 'fallback',
      });
  });

  it('times out even when the provider ignores cancellation and ignores its late result', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: unknown) => void;
      let providerSignal: AbortSignal | undefined;
      const cleanup = createPromptCleanup((_raw, signal) => {
        providerSignal = signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }, 20);
      const result = cleanup('original', new AbortController().signal);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toEqual({
        raw: 'original',
        text: 'original',
        status: 'fallback',
      });
      expect(providerSignal?.aborted).toBe(true);
      finish('late invented text');
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects cancellation, aborts the provider, and never submits a late rewrite', async () => {
    let finish!: (value: unknown) => void;
    let providerSignal: AbortSignal | undefined;
    const provider = vi.fn((_raw: string, signal: AbortSignal) => {
      providerSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const submit = vi.fn();
    const controller = new AbortController();
    const result = createPromptCleanup(provider)('raw', controller.signal).then(
      (value) => submit(value.text),
    );
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
    finish('late');
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    await expect(
      createPromptCleanup(provider)('raw', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider).toHaveBeenCalledOnce();
  });

  it('does not call the provider when cancelled before dispatch or when input is empty', async () => {
    const provider = vi.fn().mockResolvedValue('rewrite');
    const controller = new AbortController();
    const result = createPromptCleanup(provider)('raw', controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      await createPromptCleanup(provider)('  ', new AbortController().signal),
    ).toEqual({ raw: '  ', text: '  ', status: 'fallback' });
    expect(provider).not.toHaveBeenCalled();
  });
});
