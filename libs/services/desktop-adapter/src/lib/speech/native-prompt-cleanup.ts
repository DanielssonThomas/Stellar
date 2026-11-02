import { cleanupRefineCommand, decodeCleanupReply, type CleanupRequest } from '@stellar/desktop-contracts';
import { createPromptCleanup, type PromptCleanupResult } from './prompt-cleanup';

export type CleanupInvoke = (command: typeof cleanupRefineCommand, args: { request: CleanupRequest }) => Promise<unknown>;

export function createNativePromptCleanup(invoke?: CleanupInvoke): (raw: string, signal: AbortSignal) => Promise<PromptCleanupResult> {
  return createPromptCleanup(invoke && (async (raw, signal) => {
    if (signal.aborted) throw new DOMException('Cleanup cancelled', 'AbortError');
    const reply = decodeCleanupReply(await invoke(cleanupRefineCommand, { request: { version: 1, raw } }));
    if (signal.aborted) throw new DOMException('Cleanup cancelled', 'AbortError');
    return reply.text;
  }), 51000);
}
