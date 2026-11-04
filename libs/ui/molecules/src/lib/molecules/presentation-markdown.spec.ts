import { describe, it, expect } from 'vitest';
import { inlineMarkdown, presentationMarkdown } from './presentation-markdown';

describe('safe presentation Markdown', () => {
  it('renders headings, code, emphasis, links, lists, quotes and tables', () => {
    const html = presentationMarkdown(
      '# Main\n\n## Subheading\n\n**Bold** and *italic* with `const x`\n\n```ts\nconst text = "<b>";\n```\n\n- First\n- Second\n\n> Quote\n\n| A | B |\n| --- | --- |\n| One | Two |',
    );
    for (const tag of [
      '<h1>',
      '<h2>',
      '<strong>',
      '<em>',
      '<code>',
      '<pre>',
      '<ul>',
      '<blockquote>',
      '<table>',
    ])
      expect(html).toContain(tag);
    expect(html).toContain('&lt;b&gt;');
    expect(inlineMarkdown('[Source](https://example.com)')).toContain(
      'rel="noopener noreferrer"',
    );
  });
  it('leaves HTML and executable links inert, including entity and quote tricks', () => {
    const input =
      '<img src=x onerror="alert(1)"> [bad](javascript:alert) [entity](&#106;avascript:bad) `**literal**`';
    const html = presentationMarkdown(input);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<code>**literal**</code>');
    expect(inlineMarkdown('[q](https://example.com/"onclick="bad)')).toContain(
      '&quot;',
    );
  });
});
