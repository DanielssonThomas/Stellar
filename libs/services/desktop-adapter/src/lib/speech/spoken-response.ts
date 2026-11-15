import type { IvySnapshot } from '@stellar/desktop-contracts';
import { conversationSpeechText } from './conversation-text';

/** Malformed/unfinished structured replies remain visible, but cannot be retracted once spoken. */
export function spokenResponse(items: IvySnapshot['items']): string {
  return conversationSpeechText(
    items
      .flatMap((item) => (item.kind === 'text' ? [item.text] : []))
      .join('\n\n'),
  );
}
