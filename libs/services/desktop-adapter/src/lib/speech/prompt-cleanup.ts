export type PromptCleanupProvider = (
  raw: string,
  signal: AbortSignal,
) => Promise<unknown>;

export type PromptCleanupResult = Readonly<{
  raw: string;
  text: string;
  status: 'refined' | 'fallback';
}>;

/**
 * Call only with a finalized transcript and an independently verified local,
 * no-tool provider. Shape validation cannot prove that a rewrite preserves intent.
 * Callers must fence downstream submission on cancellation and retain `raw` for
 * diagnostics; this utility does not submit or persist either string.
 */
export function createPromptCleanup(
  provider?: PromptCleanupProvider,
  timeoutMs = 5000,
): (raw: string, signal: AbortSignal) => Promise<PromptCleanupResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('Cleanup timeout must be positive and finite');

  return async (raw, signal) => {
    const fallback: PromptCleanupResult = {
      raw,
      text: raw,
      status: 'fallback',
    };
    const cancelled = () => new DOMException('Cleanup cancelled', 'AbortError');
    if (signal.aborted) throw cancelled();
    if (!provider || !raw.trim() || new TextEncoder().encode(raw).length > 8192) return fallback;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interruption = new Promise<never>((_, reject) => {
        onAbort = () => {
          controller.abort();
          reject(cancelled());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Cleanup timed out'));
        }, timeoutMs);
      });
      const output = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw cancelled();
          return provider(raw, controller.signal);
        }),
        interruption,
      ]);
      if (signal.aborted) throw cancelled();
      if (
        typeof output !== 'string' ||
        !output.trim() ||
        [...output].some((character) => {
          const code = character.charCodeAt(0);
          return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
        })
      )
        return fallback;
      const tokens = (text: string) => (text.match(/(?:[A-Za-z]:\\|\/)[^\s,;]+|\b[\w.-]*\d[\w.-]*\b/g) ?? []).map((token) => token.replace(/[.,;:!?]+$/, ''));
      const outputTokens = new Set(tokens(output));
      if (tokens(raw).some((token) => !outputTokens.has(token))) return fallback;
      return { raw, text: output, status: 'refined' };
    } catch {
      if (signal.aborted) throw cancelled();
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}
