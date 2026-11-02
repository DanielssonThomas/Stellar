import { describe, expect, it, vi } from 'vitest';
import { createNativePromptCleanup } from './native-prompt-cleanup';

describe('native prompt cleanup', () => {
  const raw =
    'Um, save C:\\demo\\report.txt for ID ALPHA-42. Actually JSON, not CSV.';
  it('waits for the native child after the first caller aborts before invoking the next request', async () => {
    let settle!: (value: unknown) => void;
    const invoke = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValueOnce({ version: 1, text: 'new draft' });
    const cleanup = createNativePromptCleanup(invoke);
    const firstController = new AbortController();
    const first = cleanup('old draft', firstController.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = cleanup('new draft', new AbortController().signal);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    settle({ version: 1, text: 'old draft' });
    await expect(second).resolves.toMatchObject({
      text: 'new draft',
      status: 'refined',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('decodes a native reply with a permitted filler removal', async () => {
    const invoke = vi.fn().mockResolvedValue({
      version: 1,
      text: 'save C:\\demo\\report.txt for ID ALPHA-42. Actually JSON, not CSV.',
    });
    const result = await createNativePromptCleanup(invoke)(
      raw,
      new AbortController().signal,
    );
    expect(result).toEqual({
      raw,
      text: 'save C:\\demo\\report.txt for ID ALPHA-42. Actually JSON, not CSV.',
      status: 'refined',
    });
  });
  it('keeps the raw transcript when a native reply applies an ambiguous revision', async () => {
    const invoke = vi.fn().mockResolvedValue({
      version: 1,
      text: 'Save C:\\demo\\report.txt for ID ALPHA-42 as JSON.',
    });
    expect(
      await createNativePromptCleanup(invoke)(
        raw,
        new AbortController().signal,
      ),
    ).toEqual({
      raw,
      text: raw,
      status: 'fallback',
    });
  });
  it.each([
    { version: 2, text: 'bad' },
    { version: 1, text: 1 },
    { version: 1, text: 'Save as JSON' },
    { version: 1, text: null },
  ])('falls back for malformed or unsafe reply', async (reply) => {
    const result = await createNativePromptCleanup(
      vi.fn().mockResolvedValue(reply),
    )(raw, new AbortController().signal);
    expect(result).toEqual({ raw, text: raw, status: 'fallback' });
  });
  it('does not release a late result after cancellation', async () => {
    let settle!: (reply: unknown) => void;
    const invoke = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const controller = new AbortController();
    const result = createNativePromptCleanup(invoke)(raw, controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort();
    settle({ version: 1, text: raw });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
