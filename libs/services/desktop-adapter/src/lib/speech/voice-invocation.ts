export const VOICE_FOLLOW_UP_MS = 60_000;

/** An exact utterance-prefix gate; never interpret wake words inside dictation. */
export class VoiceInvocation {
  private expires = 0;

  active(now: number): boolean {
    return now < this.expires;
  }

  activate(now: number): void {
    this.expires = now + VOICE_FOLLOW_UP_MS;
  }

  reset(): void {
    this.expires = 0;
  }

  accept(
    text: string,
    now: number,
    composing: boolean,
  ): { text: string; invoked: boolean } | null {
    const wake =
      !composing && /^\s*ivy(?=$|[\s,.:;!?])(?:[\s,.:;!?]*)/iu.exec(text);
    if (wake) {
      this.activate(now);
      return { text: text.slice(wake[0].length), invoked: true };
    }
    if (!this.active(now) && !composing) return null;
    this.activate(now);
    return { text, invoked: false };
  }
}

/** A suffix is deliberately fail-closed against dispatch, even after dictation. */
export function cancelsPrompt(text: string): boolean {
  return /(?:^|[\s,.;:!?])prompt[\s,]+cancel(?:[\s.!?,;:]*(?:(?:end|send)\s+prompt|send))?[\s.!?,;:]*$/iu.test(
    text,
  );
}

export function promptInvocation(text: string): string | null {
  const command = /^\s*prompt(?=$|[\s,.:;!?])(?:[\s,.:;!?]*)/iu.exec(text);
  return command ? text.slice(command[0].length) : null;
}
