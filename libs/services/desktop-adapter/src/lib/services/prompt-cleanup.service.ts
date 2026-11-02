import { Injectable } from '@angular/core';
import { createNativePromptCleanup, type CleanupInvoke } from '../speech/native-prompt-cleanup';

@Injectable({ providedIn: 'root' })
export class PromptCleanupService {
  private readonly refinePrompt = createNativePromptCleanup(
    (globalThis as typeof globalThis & { __TAURI__?: { core: { invoke: CleanupInvoke } } }).__TAURI__?.core.invoke,
  );

  refine(raw: string, signal: AbortSignal) {
    return this.refinePrompt(raw, signal);
  }
}
