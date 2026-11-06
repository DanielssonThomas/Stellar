export const waitingCueText = 'One moment.';
export const waitingCueDelayMs = 3000;

export function waitingCueEligible(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(
      /^(?:(?:hey|hi|hello|good morning|good afternoon|good evening|ivy)\s+)+/,
      '',
    );
  if (!words) return false;
  return (
    !/^(?:(?:hey|hi|hello|good morning|good afternoon|good evening|ivy)\s*)+$/.test(
      words,
    ) &&
    !/^(?:there|again|girl|how are you(?: doing)?(?: today)?|how's it going|what's up|thanks(?: ivy| a lot| very much)?|thank you(?: ivy| very much)?|okay|ok|alright|all right|sounds good|great|nice|yes|no|sure|goodbye|bye|good night|never mind|nevermind|cancel(?: that| request)?|stop(?: that| request)?|done|i'm done|clear|new session|reload mcp|prompt cancel)$/.test(
      words,
    )
  );
}
