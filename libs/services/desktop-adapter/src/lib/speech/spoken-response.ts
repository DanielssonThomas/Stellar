import type { IvySnapshot } from '@stellar/desktop-contracts';

/** Malformed/unfinished structured replies remain visible, but cannot be retracted once spoken. */
export function spokenResponse(items: IvySnapshot['items']): string {
  const text = items
    .flatMap((item) => (item.kind === 'text' ? [item.text] : []))
    .join('\n\n')
    .trim();
  return /^(?:\{|\[|```)|stellar_presentation|<\/?(?:think|analysis|tool_call)\b/i.test(
    text,
  )
    ? ''
    : text;
}
