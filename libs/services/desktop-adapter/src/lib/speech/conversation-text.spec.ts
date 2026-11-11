import { describe, expect, it } from 'vitest';
import {
  conversationDisplayText,
  conversationSpeechText,
} from './conversation-text';

describe('Desktop conversation text', () => {
  it('keeps words and punctuation from formatted prose', () => {
    const markdown =
      '## Briefing ###\n\n- **First**, check *Ivy*.\n- ~~Old~~ Ready?';
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

  it('keeps surrounding quotes while removing apostrophes inside URL destinations', () => {
    const text = "Visit 'https://example.test/o'reilly?private=yes#end'.";
    const expected = "Visit 'example.test'.";
    expect(conversationDisplayText(text)).toBe(expected);
    expect(conversationSpeechText(text)).toBe(expected);
  });

  it('keeps literal placeholders and strips HTML links and Markdown titles', () => {
    const text =
      'Use <file> and <folder>. ' +
      '<a href="https://example.test/private?token=secret">Guide</a>, ' +
      '[relative](/notes "a ) title"), ' +
      "[angled](<https://example.test/close)> 'another ) title').";
    const expected = 'Use <file> and <folder>. Guide, relative, angled.';
    expect(conversationDisplayText(text)).toBe(expected);
    expect(conversationSpeechText(text)).toBe(expected);
  });

  it('removes the destination and title of a multiline Markdown link', () => {
    const text =
      'See [the guide](\n  https://example.test/private?token=yes\n  "A ) title").';
    expect(conversationDisplayText(text)).toBe('See the guide.');
    expect(conversationSpeechText(text)).toBe('See the guide.');
  });

  it('keeps the final speech fallback closed to structured text', () => {
    for (const structured of [
      '[true]',
      '[123]',
      '<tool_result>private</tool_result>',
      'Here is the result:\n{"unfinished":',
      'Closing </tool_call> marker',
    ]) {
      expect(conversationSpeechText(structured)).toBe('');
      expect(conversationDisplayText(structured)).toBe(structured);
    }
    expect(
      conversationSpeechText('[The notes](https://example.test/private).'),
    ).toBe('The notes.');
    expect(
      conversationSpeechText('<https://example.test/private> has details.'),
    ).toBe('example.test has details.');
  });

  it('preserves long dotted prose and shortens an adjacent valid domain', () => {
    const literal = 'a.'.repeat(32_000) + 'a';
    const input = literal + ' and example.test/private?key=sample.';
    expect(conversationDisplayText(input)).toBe(literal + ' and example.test.');
    expect(conversationSpeechText(input)).toBe(literal + ' and example.test.');
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
