import { describe, expect, it } from 'vitest';
import {
  conversationDisplayText,
  conversationSpeechText,
} from './conversation-text';

describe('Desktop conversation text', () => {
  it('keeps words and punctuation from formatted prose', () => {
    const markdown =
      '## Briefing\n\n- **First**, check *Ivy*.\n- ~~Old~~ Ready?';
    expect(conversationDisplayText(markdown)).toBe(
      'Briefing\n\nFirst, check Ivy.\nOld Ready?',
    );
    expect(conversationSpeechText(markdown)).toBe(
      'Briefing\n\nFirst, check Ivy.\nOld Ready?',
    );
  });

  it('keeps meaningful labels and replaces bare destinations with site names', () => {
    const source =
      '[Release **notes**](https://example.test/docs(a)?query=long#private), ' +
      '<https://www.docs.test/a?secret=xyz#title>, ' +
      'https://bare.test/path?key=7890#hidden, and github.com/team/repo/issues/1.';
    const prose = 'Release notes, docs.test, bare.test, and github.com.';
    expect(conversationDisplayText(source)).toBe(prose);
    expect(conversationSpeechText(source)).toBe(prose);
  });

  it('processes the full committed text when delimiters or destinations span deltas', () => {
    const deltas = [
      'Here is *',
      '*the answer',
      '**: [the guide](ht',
      'tps://example.test/long?',
      'private=value#section).',
    ];
    expect(conversationSpeechText(deltas.join(''))).toBe(
      'Here is the answer: the guide.',
    );
  });

  it('never exposes a URL from incomplete markup, inline code, or a literal link label', () => {
    expect(
      conversationSpeechText('See [the guide](https://example.test/path?key='),
    ).toBe('See the guide');
    expect(
      conversationSpeechText(
        'Open `https://example.test/private?token=abc#xyz` or [www.example.test/a](https://another.test).',
      ),
    ).toBe('Open example.test or example.test.');
  });

  it('preserves reference labels and ordinary brackets without using destinations', () => {
    const source =
      'See [the guide][guide] or [status]. Email <ivy@example.test>.\n\n' +
      '[guide]: https://example.test/path?token=private';
    expect(conversationSpeechText(source)).toBe(
      'See the guide or [status]. Email email address.',
    );
  });

  it('shortens a bare destination before handling punctuation inside it', () => {
    expect(
      conversationSpeechText(
        String.raw`**[Documentation](https://docs.test/a)** and **https://example.test/path\_name[part]?key=private#anchor**.`,
      ),
    ).toBe('Documentation and example.test.');
  });

  it('preserves literal expressions, fenced code, and explicitly quoted destinations on screen', () => {
    const source = [
      'Calculate 2 ** 3, leave file_name alone, and enter `a*b`.',
      '',
      '```sh',
      'curl "https://example.test/private?token=abc"',
      '```',
    ].join('\n');
    expect(conversationDisplayText(source)).toBe(
      'Calculate 2 ** 3, leave file_name alone, and enter a*b.\n\ncurl "https://example.test/private?token=abc"',
    );
    expect(conversationSpeechText(source)).toBe(
      'Calculate 2 ** 3, leave file_name alone, and enter a*b.',
    );
  });
});
