import { isSealedIvyProseLine } from '@stellar/desktop-contracts';

const destinationPattern = String.raw`<?(?:(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/|\bhttps?:\/\/|\bwww\.|\bmailto:|(?<![a-z\d.-])(?:[a-z\d-]+\.)+[a-z]{2,63}(?=[/?#]))[^\s<>"\x60]+>?`;
const htmlTag = String.raw`<\/?(?<tag>a|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|li|ol|p|pre|s|span|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)(?:[ \t](?:[^<>'"]|"[^"]*"|'[^']*')*)?\/?>`;
const htmlBlock =
  /^(?:blockquote|br|div|h[1-6]|hr|li|ol|p|pre|table|tbody|td|th|thead|tr|ul)$/iu;
const destination = new RegExp(destinationPattern, 'giu');
const inlineToken = new RegExp(
  [
    String.raw`(?<!\x60)(?<delimiter>\x60+)(?!\x60)(?<code>[^\n]*?)\k<delimiter>(?!\x60)`,
    String.raw`\\(?<literal>[\\\x60*_[\]{}()#+.!<>~|\-])`,
    String.raw`!?\[(?<label>[^[\]\n]+)\](?:(?<destination>\()|\[(?<reference>[^[\]\n]*)\])?`,
    htmlTag,
    '(?<url>' + destinationPattern + ')',
  ].join('|'),
  'giu',
);
const fencedCode = /^ {0,3}(\x60{3,}|~{3,})(.*)$/u;
const referenceDefinition = /^ {0,3}\[([^[\]\n]+)\]:[ \t]+/u;
const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u;

function linkName(value: string): string {
  try {
    const url = new URL(
      /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:)/iu.test(value)
        ? value
        : 'https://' + value,
    );
    if (url.protocol === 'mailto:') return 'email address';
    return url.hostname.replace(/^www\./iu, '') || 'link';
  } catch {
    return 'link';
  }
}

function shortenDestinations(text: string): string {
  return text.replace(destination, (match) => {
    const address = match.replace(/^<|>$/gu, '');
    if (match.startsWith('<') && match.endsWith('>')) return linkName(address);
    const trimmed = address.replace(/[.,;!?)}\]']+$/u, '');
    return linkName(trimmed) + address.slice(trimmed.length);
  });
}

function prose(text: string): string {
  return shortenDestinations(text)
    .replace(/<[^@\s<>]+@[^@\s<>]+\.[a-z]{2,63}>/giu, 'email address')
    .replace(/\b(?:https?:\/{0,2}|www\.)[ \t]*(?=$|\n)/giu, '');
}

function stripEmphasis(text: string, urlMarkers: ReadonlySet<number>): string {
  const markers = /\*+|_+|~+/gu;
  const opens = new Map<string, number[]>();
  const remove = new Set(urlMarkers);
  for (const match of text.matchAll(markers)) {
    const marker = match[0];
    if (!/^(?:\*{1,3}|_{1,3}|~~)$/u.test(marker)) continue;
    const before = text[match.index - 1];
    const after = text[match.index + marker.length];
    const pending = opens.get(marker) ?? [];
    const opening = pending.at(-1);
    if (
      opening !== undefined &&
      before &&
      !/\s/u.test(before) &&
      (!after || !/[\p{L}\p{N}\0]/u.test(after))
    ) {
      pending.pop();
      remove.add(opening);
      remove.add(match.index);
    } else if (
      !urlMarkers.has(match.index) &&
      (!before || !/[\p{L}\p{N}\0]/u.test(before)) &&
      after &&
      !/\s/u.test(after)
    ) {
      pending.push(match.index);
      opens.set(marker, pending);
    }
  }
  return text.replace(markers, (marker, index: number) =>
    remove.has(index) ? '' : marker,
  );
}

function linkEnd(text: string, start: number): number {
  let depth = 1;
  let delimiter: string | undefined;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      i++;
    } else if (delimiter) {
      if (char === delimiter) delimiter = undefined;
    } else if (
      depth === 1 &&
      /[<"']/u.test(char) &&
      (i === start || /[ \t\n]/u.test(text[i - 1]))
    ) {
      delimiter = char === '<' ? '>' : char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && --depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

function referenceId(label: string): string {
  return label.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function inline(
  text: string,
  includeCode: boolean,
  references: ReadonlySet<string>,
): string {
  const tokens = new RegExp(inlineToken);
  const protectedParts: string[] = [];
  const urlMarkers = new Set<number>();
  // Inline atoms stay opaque while emphasis is paired across their boundaries.
  const protect = (value: string) => {
    protectedParts.push(value);
    return '\0';
  };
  let result = '';
  let last = '';
  let separate = false;
  const append = (value: string, literal = false) => {
    if (!value) return;
    if (
      separate &&
      last &&
      !/\s/u.test(last) &&
      !/^[\s.,;:!?)}\]]/u.test(value)
    )
      result += ' ';
    result += literal ? protect(value) : value.replace(/\0/gu, protect);
    last = value.at(-1) ?? '';
    separate = false;
  };
  let end = 0;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    append(prose(text.slice(end, token.index)));
    end = tokens.lastIndex;
    const { code, literal, label, destination, reference, tag, url } =
      token.groups ?? {};
    if (tag !== undefined) {
      separate ||= htmlBlock.test(tag);
    } else if (code !== undefined) {
      append(includeCode ? code : shortenDestinations(code), true);
    } else if (literal !== undefined) {
      append(literal, true);
    } else if (url !== undefined) {
      const trailing = /(?<![*_~])(\*{1,3}|_{1,3}|~~)([.,;!?)}\]']*)$/u.exec(
        url,
      );
      if (trailing) {
        append(prose(url.slice(0, trailing.index)) || 'link', true);
        urlMarkers.add(result.length);
        append(trailing[1] + trailing[2]);
      } else {
        append(shortenDestinations(url), true);
      }
    } else if (
      label &&
      (destination || references.has(referenceId(reference || label)))
    ) {
      append(inline(label, includeCode, references), true);
      if (!destination) continue;
      end = linkEnd(text, end);
      tokens.lastIndex = end;
    } else {
      append(prose(token[0]));
    }
  }
  append(prose(text.slice(end)));
  let atom = 0;
  return stripEmphasis(result, urlMarkers).replace(
    /\0/gu,
    () => protectedParts[atom++],
  );
}

function project(source: string, includeCode: boolean): string {
  const blocks: { text: string; code?: true }[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ text: paragraph.join('\n') });
    paragraph = [];
  };
  const references = new Set<string>();
  let fence: string | undefined;
  for (const line of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const marker = fencedCode.exec(line);
    if (fence) {
      if (marker?.[1].startsWith(fence) && marker[2].trim() === '') {
        fence = undefined;
      } else if (includeCode) {
        blocks.push({ text: line, code: true });
      }
      continue;
    }
    if (marker) {
      flushParagraph();
      fence = marker[1];
      continue;
    }
    const reference = referenceDefinition.exec(line);
    if (reference) {
      flushParagraph();
      references.add(referenceId(reference[1]));
      continue;
    }
    if (/^ {0,3}(?:\*{3,}|-{3,}|_{3,})$/u.test(line)) continue;
    if (!line.trim()) {
      flushParagraph();
      blocks.push({ text: line });
      continue;
    }
    const text = line.replace(/^ {0,3}(?:>[ \t]+)+/u, '');
    const content =
      heading.exec(text)?.[1] ??
      text
        .replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/u, '')
        .replace(/^\[[ xX]\][ \t]+/u, '');
    if (!includeCode && !isSealedIvyProseLine(content)) return '';
    paragraph.push(content);
  }
  flushParagraph();
  return blocks
    .map(({ text, code }) =>
      code ? text : inline(text, includeCode, references),
    )
    .join('\n')
    .replace(/^\n+|\n+$/gu, '');
}

/** Plain visible conversation, with source text retained by the history boundary. */
export function conversationDisplayText(text: string): string {
  return project(text, true);
}

/** Accepts committed prose before any synthesis-sized splitting. */
export function conversationSpeechText(text: string): string {
  if (
    /stellar_presentation|<\/?(?:think|analysis|tool_call)|\p{Cc}/iu.test(
      text.replace(/[\n\t\r]/gu, ''),
    )
  )
    return '';
  return project(text, false).trim();
}
