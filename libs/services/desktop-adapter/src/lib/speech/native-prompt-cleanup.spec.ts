import { describe, expect, it, vi } from 'vitest';
import { createNativePromptCleanup } from './native-prompt-cleanup';

describe('native prompt cleanup', () => {
  const raw =
    'Um, save C:\\demo\\report.txt for ID ALPHA-42. Actually JSON, not CSV.';
  it('decodes a native reply and keeps protected identifiers', async () => {
    const invoke = vi.fn().mockResolvedValue({
      version: 1,
      text: 'Save C:\\demo\\report.txt for ID ALPHA-42 as JSON.',
    });
    const result = await createNativePromptCleanup(invoke)(
      raw,
      new AbortController().signal,
    );
    expect(result).toEqual({
      raw,
      text: 'Save C:\\demo\\report.txt for ID ALPHA-42 as JSON.',
      status: 'refined',
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
    await Promise.resolve();
    controller.abort();
    settle({ version: 1, text: raw });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
