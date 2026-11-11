const destinationPattern = String.raw`<?(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\bmailto:|\b(?:[a-z\d-]+\.)+[a-z]{2,63}(?=[/?#]))[^\s<>"\x60]+>?`;
const htmlTag = String.raw`<\/?(?:a|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|li|ol|p|pre|s|span|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)(?:[ \t](?:[^<>'"]|"[^"]*"|'[^']*')*)?\/?>`;
const destination = new RegExp(destinationPattern, 'giu');
const inlineToken = new RegExp(
  [
    String.raw`(?<!\x60)(?<delimiter>\x60+)(?!\x60)(?<code>[^\n]*?)\k<delimiter>(?!\x60)`,
    String.raw`\\(?<literal>[\\\x60*_[\]{}()#+.!<>~|\-])`,
    String.raw`!?\[(?<label>[^[\]\n]+)\](?:(?<destination>\()|\[(?<reference>[^[\]\n]*)\])?`,
    '(?<html>' + htmlTag + ')',
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
    .replace(/\b(?:https?:\/{0,2}|www\.)$/iu, '')
    .replace(/(\*{1,3}|~~)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
    .replace(
      /(?<![\p{L}\p{N}])(_{1,3})(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}])/gu,
      '$2',
    )
    .replace(/(?<!\S)(?:\*+|_{2,}|~~)(?=[\p{L}\p{N}])/gu, '')
    .replace(/(?<=[\p{L}\p{N}])(?:\*+|_{2,}|~~)(?=$|[\s\p{P}])/gu, '');
}

function adjoiningProse(
  text: string,
  afterToken: boolean,
  beforeToken: boolean,
): string {
  if (afterToken)
    text = text.replace(/^(?:\*{1,3}|_{1,3}|~~)(?=$|[\s\p{P}])/u, '');
  if (beforeToken) text = text.replace(/(?:\*{1,3}|_{1,3}|~~)$/u, '');
  return prose(text);
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
      (i === start || /[ \t]/u.test(text[i - 1]))
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
  let result = '';
  let end = 0;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    result += adjoiningProse(text.slice(end, token.index), end > 0, true);
    end = tokens.lastIndex;
    const { code, literal, label, destination, reference, html, url } =
      token.groups ?? {};
    if (html !== undefined) continue;
    if (code !== undefined) {
      result += includeCode ? code : shortenDestinations(code);
    } else if (literal !== undefined) {
      result += literal;
    } else if (url !== undefined) {
      result += shortenDestinations(url);
    } else if (
      label &&
      (destination || references.has(referenceId(reference || label)))
    ) {
      result += inline(label, includeCode, references);
      if (!destination) continue;
      end = linkEnd(text, end);
      tokens.lastIndex = end;
    } else {
      result += prose(token[0]);
    }
  }
  return result + adjoiningProse(text.slice(end), end > 0, false);
}

function project(source: string, includeCode: boolean): string {
  const lines: { text: string; code?: true }[] = [];
  const references = new Set<string>();
  let fence: string | undefined;
  for (const line of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const marker = fencedCode.exec(line);
    if (fence) {
      if (marker?.[1].startsWith(fence) && marker[2].trim() === '') {
        fence = undefined;
      } else if (includeCode) {
        lines.push({ text: line, code: true });
      }
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const reference = referenceDefinition.exec(line);
    if (reference) {
      references.add(referenceId(reference[1]));
      continue;
    }
    if (/^ {0,3}(?:\*{3,}|-{3,}|_{3,})$/u.test(line)) continue;
    const text = line.replace(/^ {0,3}(?:>[ \t]+)+/u, '');
    lines.push({
      text:
        heading.exec(text)?.[1] ??
        text
          .replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/u, '')
          .replace(/^\[[ xX]\][ \t]+/u, ''),
    });
  }
  return lines
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
    /(?:^|\n)\s*(?:\{|\[\s*[[{"\]])|stellar_presentation|<\/?(?:think|analysis|tool_call)\b/iu.test(
      text,
    )
  )
    return '';
  return project(text, false).trim();
}
