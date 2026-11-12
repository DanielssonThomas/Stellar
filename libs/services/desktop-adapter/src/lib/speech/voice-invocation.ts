/** Wake spellings only at an utterance prefix, never inside dictation. */
export class VoiceInvocation {
  private invoked = false;
  private acoustic = false;
  private sensitivity: 'standard' | 'high' = 'standard';

  setSensitivity(value: 'standard' | 'high') {
    this.sensitivity = value;
  }

  matches(text: string): boolean {
    return wakePrefix(text, this.sensitivity) !== null;
  }

  active(): boolean {
    return this.invoked;
  }

  activate(): void {
    this.invoked = true;
    this.acoustic = false;
  }

  activateAcoustically(): void {
    this.invoked = true;
    this.acoustic = true;
  }

  reset(): void {
    this.invoked = false;
    this.acoustic = false;
  }

  accept(
    text: string,
    composing: boolean,
  ): { text: string; invoked: boolean } | null {
    const wake = !composing && wakePrefix(text, this.sensitivity);
    if (wake) {
      this.activate();
      return { text: text.slice(wake[0].length), invoked: true };
    }
    if (!this.active() && !composing) return null;
    const invoked = this.acoustic;
    this.activate();
    return { text, invoked };
  }
}

export function wakePrefix(
  text: string,
  sensitivity: 'standard' | 'high' = 'standard',
): RegExpExecArray | null {
  const standard =
    /^\s*(?:hey[\s,]+)?(?:ivy(?=$|[\s,.:;!?])|i\.\s*v(?=\.*(?:$|[\s,:;!?])))[\s,.:;!?]*/iu;
  const sensitive =
    /^\s*(?:hey[\s,]+)?(?:iv|i\s+(?:mean|think)|heidi|eerie|i['’]ve)(?=$|[\s,.:;!?])[\s,.:;!?]*/iu;
  return (
    standard.exec(text) ??
    (sensitivity === 'high' ? sensitive.exec(text) : null)
  );
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
