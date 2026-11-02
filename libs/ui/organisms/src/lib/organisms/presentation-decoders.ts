import type {
  PresentationDiagramPayload,
  PresentationMediaPayload,
  PresentationTelemetryPayload,
  PresentationTextBlock,
  PresentationTextPayload,
} from '@stellar/ui-molecules';
import { plainRecord } from './stage-json';

const exact = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const text = (value: unknown, limit = 4096): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= limit &&
  ![...value].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return (
      (n < 32 && ![9, 10, 13].includes(n)) ||
      n === 127 ||
      (n >= 0xd800 && n <= 0xdfff)
    );
  });
const array = (value: unknown, maximum: number): value is unknown[] =>
  Array.isArray(value) &&
  value.length <= maximum &&
  Object.getPrototypeOf(value) === Array.prototype &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, i) =>
    Object.getOwnPropertyDescriptor(value, String(i)),
  ).every(
    (descriptor) =>
      descriptor && 'value' in descriptor && descriptor.enumerable,
  );
const list = (value: unknown, maximum: number): value is unknown[] =>
  array(value, maximum) && value.length > 0;

function block(value: unknown): PresentationTextBlock | null {
  if (!plainRecord(value)) return null;
  const kind = value['kind'];
  if (
    (kind === 'paragraph' || kind === 'heading') &&
    exact(value, ['kind', 'text']) &&
    text(value['text'], kind === 'heading' ? 240 : 32768)
  )
    return { kind, text: value['text'] };
  if (
    kind === 'code' &&
    exact(value, ['kind', 'text'], ['language']) &&
    text(value['text'], 32768) &&
    (!Object.hasOwn(value, 'language') || text(value['language'], 32))
  )
    return {
      kind,
      text: value['text'],
      ...(typeof value['language'] === 'string'
        ? { language: value['language'] }
        : {}),
    };
  if (
    kind === 'list' &&
    exact(value, ['kind', 'items']) &&
    list(value['items'], 64) &&
    value['items'].every((item) => text(item, 4096))
  )
    return { kind, items: value['items'] as string[] };
  if (
    kind === 'checklist' &&
    exact(value, ['kind', 'items']) &&
    list(value['items'], 48) &&
    value['items'].every(
      (item) =>
        plainRecord(item) &&
        exact(item, ['text', 'checked']) &&
        text(item['text'], 4096) &&
        typeof item['checked'] === 'boolean',
    )
  )
    return {
      kind,
      items: value['items'] as { text: string; checked: boolean }[],
    };
  if (
    kind === 'table' &&
    exact(value, ['kind', 'columns', 'rows']) &&
    list(value['columns'], 8) &&
    value['columns'].every((item) => text(item, 120)) &&
    list(value['rows'], 24) &&
    value['rows'].every(
      (row) =>
        array(row, 8) &&
        row.length === (value['columns'] as unknown[]).length &&
        row.every(
          (item) =>
            typeof item === 'string' && (item === '' || text(item, 4096)),
        ),
    )
  )
    return {
      kind,
      columns: value['columns'] as string[],
      rows: value['rows'] as string[][],
    };
  return null;
}

export function decodePresentationText(
  value: unknown,
): PresentationTextPayload | null {
  if (
    !plainRecord(value) ||
    !exact(value, ['title', 'blocks']) ||
    !text(value['title'], 240) ||
    !list(value['blocks'], 32)
  )
    return null;
  const blocks = value['blocks'].map(block);
  return blocks.every((item): item is PresentationTextBlock => item !== null)
    ? { title: value['title'], blocks }
    : null;
}

export function decodePresentationImage(
  value: unknown,
): PresentationMediaPayload | null {
  if (
    !plainRecord(value) ||
    !exact(value, ['title', 'src', 'alt'], ['caption', 'kind']) ||
    (Object.hasOwn(value, 'kind') && value['kind'] !== 'image') ||
    !text(value['title'], 240) ||
    !text(value['alt'], 1024) ||
    !text(value['src'], 512 * 1024) ||
    (Object.hasOwn(value, 'caption') && !text(value['caption'], 4096))
  )
    return null;
  const src = value['src'];
  const bundled = /^\/emblem\/layers\/[a-z0-9-]+\.(?:png|webp)$/u.test(src);
  const data =
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(src) &&
    src.slice(src.indexOf(',') + 1).length % 4 === 0;
  if (!bundled && !data) return null;
  return {
    kind: 'image',
    title: value['title'],
    alt: value['alt'],
    src,
    ...(typeof value['caption'] === 'string'
      ? { caption: value['caption'] }
      : {}),
  };
}

export function decodePresentationBrowser(
  value: unknown,
): PresentationMediaPayload | null {
  if (
    !plainRecord(value) ||
    !exact(value, ['title', 'url'], ['kind']) ||
    (Object.hasOwn(value, 'kind') && value['kind'] !== 'browser') ||
    !text(value['title'], 240) ||
    !text(value['url'], 2048)
  )
    return null;
  try {
    const url = new URL(value['url']);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return { kind: 'browser', title: value['title'], url: url.href };
  } catch {
    return null;
  }
}

export function decodePresentationDiagram(
  value: unknown,
): PresentationDiagramPayload | null {
  if (
    !plainRecord(value) ||
    !exact(value, ['title', 'nodes', 'edges']) ||
    !text(value['title'], 240) ||
    !list(value['nodes'], 12) ||
    !array(value['edges'], 24)
  )
    return null;
  const ids = new Set<string>();
  for (const node of value['nodes']) {
    if (
      !plainRecord(node) ||
      !exact(node, ['id', 'label']) ||
      typeof node['id'] !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,31}$/u.test(node['id']) ||
      ids.has(node['id']) ||
      !text(node['label'], 60)
    )
      return null;
    ids.add(node['id']);
  }
  const seen = new Set<string>();
  for (const edge of value['edges']) {
    if (
      !plainRecord(edge) ||
      !exact(edge, ['from', 'to'], ['label']) ||
      typeof edge['from'] !== 'string' ||
      typeof edge['to'] !== 'string' ||
      !ids.has(edge['from']) ||
      !ids.has(edge['to']) ||
      edge['from'] === edge['to'] ||
      (Object.hasOwn(edge, 'label') && !text(edge['label'], 40))
    )
      return null;
    const key = edge['from'] + ':' + edge['to'];
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return value as unknown as PresentationDiagramPayload;
}

const telemetry = (
  value: unknown,
  kind: 'workflow' | 'session',
): PresentationTelemetryPayload | null => {
  if (
    !plainRecord(value) ||
    !exact(
      value,
      ['title'],
      kind === 'workflow' ? ['project', 'kind'] : ['kind'],
    ) ||
    (Object.hasOwn(value, 'kind') && value['kind'] !== kind) ||
    !text(value['title'], 240) ||
    (Object.hasOwn(value, 'project') &&
      value['project'] !== 'stellar' &&
      value['project'] !== 'stellar-design')
  )
    return null;
  return {
    kind,
    title: value['title'],
    ...(value['project'] === 'stellar' || value['project'] === 'stellar-design'
      ? { project: value['project'] }
      : {}),
  };
};
export const decodePresentationWorkflow = (value: unknown) =>
  telemetry(value, 'workflow');
export const decodePresentationSession = (value: unknown) =>
  telemetry(value, 'session');
