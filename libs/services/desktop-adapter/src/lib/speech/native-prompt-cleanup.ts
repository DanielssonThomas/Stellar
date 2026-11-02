import {
  cleanupRefineCommand,
  decodeCleanupReply,
  type CleanupRequest,
} from '@stellar/desktop-contracts';
import {
  createPromptCleanup,
  type PromptCleanupResult,
} from './prompt-cleanup';

export type CleanupInvoke = (
  command: typeof cleanupRefineCommand,
  args: { request: CleanupRequest },
) => Promise<unknown>;

export function createNativePromptCleanup(
  invoke?: CleanupInvoke,
): (raw: string, signal: AbortSignal) => Promise<PromptCleanupResult> {
  // The native child outlives an aborted frontend wait. Serialize until the
  // underlying invocation settles, not until its caller stops waiting.
  let nativeTail: Promise<void> = Promise.resolve();
  return createPromptCleanup(
    invoke &&
      ((raw, signal) => {
        const operation = nativeTail.then(async () => {
          if (signal.aborted)
            throw new DOMException('Cleanup cancelled', 'AbortError');
          const reply = decodeCleanupReply(
            await invoke(cleanupRefineCommand, {
              request: { version: 1, raw },
            }),
          );
          if (signal.aborted)
            throw new DOMException('Cleanup cancelled', 'AbortError');
          return reply.text;
        });
        nativeTail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      }),
    51000,
  );
}
