import { Pipe, PipeTransform } from '@angular/core';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );

/** Render only generated semantic elements. Source HTML is always escaped. */
export function inlineMarkdown(text: string, depth = 0): string {
  if (depth > 8) return escape(text);
  const pattern =
    /(`+)([^`\n]+?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|~~([^\n]+?)~~/g;
  let result = '',
    position = 0;
  for (const match of text.matchAll(pattern)) {
    result += escape(text.slice(position, match.index));
    const [
      ,
      ticks,
      code,
      label,
      href,
      bold,
      boldAlt,
      italic,
      italicAlt,
      strike,
    ] = match;
    if (ticks) result += `<code>${escape(code)}</code>`;
    else if (label) {
      let safe = false;
      try {
        safe = ['https:', 'http:', 'mailto:'].includes(new URL(href).protocol);
      } catch {
        /* Literal invalid link. */
      }
      result += safe
        ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(label, depth + 1)}</a>`
        : escape(match[0]);
    } else {
      const tag = bold || boldAlt ? 'strong' : strike ? 'del' : 'em';
      result += `<${tag}>${inlineMarkdown(bold || boldAlt || italic || italicAlt || strike, depth + 1)}</${tag}>`;
    }
    position = match.index + match[0].length;
  }
  return result + escape(text.slice(position));
}

export function presentationMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const result: string[] = [];
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const content: string[] = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(
          lines[i],
        )
      )
        content.push(lines[i++]);
      i++;
      result.push(
        `<pre><code${fence[2] ? ` class="language-${escape(fence[2])}"` : ''}>${escape(content.join('\n'))}</code></pre>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      result.push(
        `<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`,
      );
      i++;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      result.push('<hr>');
      i++;
      continue;
    }
    if (
      i + 1 < lines.length &&
      line.includes('|') &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const headers = cells(line);
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim())
        rows.push(
          `<tr>${cells(lines[i++])
            .map((c) => `<td>${inlineMarkdown(c)}</td>`)
            .join('')}</tr>`,
        );
      result.push(
        `<div class="markdown-table"><table><thead><tr>${headers.map((c) => `<th scope="col">${inlineMarkdown(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]))
        quote.push(lines[i++].replace(/^>\s?/, ''));
      result.push(
        `<blockquote>${quote.map((inline) => inlineMarkdown(inline)).join('<br>')}</blockquote>`,
      );
      continue;
    }
    const list = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      const tag = list[1] ? 'ul' : 'ol',
        items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(lines[i]);
        if (!item || !!item[1] !== !!list[1]) break;
        items.push(`<li>${inlineMarkdown(item[2])}</li>`);
        i++;
      }
      result.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:#{1,6}\s|>|\s*[-+*]\s|\s*\d+[.)]\s|\s*`{3}|\s*~{3})/.test(lines[i])
    ) {
      if (
        i + 1 < lines.length &&
        lines[i].includes('|') &&
        /\|?\s*:?-{3,}/.test(lines[i + 1])
      )
        break;
      paragraph.push(lines[i++]);
    }
    result.push(`<p>${inlineMarkdown(paragraph.join('\n'))}</p>`);
  }
  return result.join('\n');
}

@Pipe({ name: 'presentationMarkdown', standalone: true })
export class PresentationMarkdownPipe implements PipeTransform {
  transform(value: string, inline = false): string {
    return inline ? inlineMarkdown(value) : presentationMarkdown(value);
  }
}
