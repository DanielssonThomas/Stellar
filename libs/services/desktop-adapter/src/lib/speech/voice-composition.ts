export type VoiceModel = 'terra' | 'sol';
export type VoiceCommand =
  | 'prompt'
  | 'prompt cancel'
  | 'end prompt'
  | 'send prompt'
  | 'send'
  | 'clear'
  | 'done'
  | 'new session'
  | 'reload mcp';
export interface VoiceComposition {
  readonly raw: string;
  readonly preview?: string;
  readonly draft?: string;
  readonly refinementRevision?: number;
  readonly refined: string | null;
  readonly lastSubmittedRaw: string;
  readonly model: VoiceModel;
  readonly status:
    | 'idle'
    | 'composing'
    | 'refining'
    | 'finalizing'
    | 'submitting'
    | 'error';
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
    normalized === 'prompt cancel' ||
    normalized === 'end prompt' ||
    normalized === 'send prompt' ||
    normalized === 'send' ||
    normalized === 'clear' ||
    normalized === 'new session' ||
    normalized === 'reload mcp'
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
