import type { VoiceModel } from './voice-composition';

export interface FinalizedPrompt {
  readonly raw: string;
  readonly refined: string;
  readonly model: VoiceModel;
}

export type PromptPresentation = (
  prompt: FinalizedPrompt,
  signal: AbortSignal,
) => Promise<void>;

export async function awaitPromptPresentation(
  present: PromptPresentation,
  prompt: FinalizedPrompt,
  controller: AbortController,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(new DOMException('Presentation cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        reject(new Error('Presentation timed out'));
        controller.abort();
      }, 10000);
      if (controller.signal.aborted) onAbort();
    });
    await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted)
          throw new DOMException('Presentation cancelled', 'AbortError');
        return present(prompt, controller.signal);
      }),
      interrupted,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}
