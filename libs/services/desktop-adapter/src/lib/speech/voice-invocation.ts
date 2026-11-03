/** Wake spellings only at an utterance prefix, never inside dictation. */
export class VoiceInvocation {
  private invoked = false;

  active(): boolean {
    return this.invoked;
  }

  activate(): void {
    this.invoked = true;
  }

  reset(): void {
    this.invoked = false;
  }

  accept(
    text: string,
    composing: boolean,
  ): { text: string; invoked: boolean } | null {
    const wake =
      !composing &&
      /^\s*(?:ivy(?=$|[\s,.:;!?])|i\.v(?=\.*(?:$|[\s,:;!?])))[\s,.:;!?]*/iu.exec(
        text,
      );
    if (wake) {
      this.activate();
      return { text: text.slice(wake[0].length), invoked: true };
    }
    if (!this.active() && !composing) return null;
    this.activate();
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
