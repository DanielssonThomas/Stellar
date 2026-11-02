export type VoiceModel = 'terra' | 'sol';
export type VoiceCommand = 'prompt' | 'end prompt' | 'clear' | 'done';
export interface VoiceComposition {
  readonly raw: string;
  readonly lastSubmittedRaw: string;
  readonly model: VoiceModel;
  readonly status: 'idle' | 'composing' | 'finalizing' | 'error';
  readonly error: string;
}

export function voiceCommand(text: string): VoiceCommand | null {
  const normalized = text
    .toLocaleLowerCase('en-US')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    normalized === 'prompt' ||
    normalized === 'end prompt' ||
    normalized === 'clear'
  )
    return normalized;
  if (
    ['done', 'thats all', 'that is all', 'im done', 'i am done'].includes(
      normalized,
    )
  )
    return 'done';
  return null;
}

export const VOICE_PROMPT_LIMIT = 8192;
export function fitsVoicePrompt(text: string): boolean {
  return new TextEncoder().encode(text).length <= VOICE_PROMPT_LIMIT;
}
