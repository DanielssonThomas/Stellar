import type {
  SpatialAction,
  SpatialPanel,
  SpatialScene,
  SpatialScore,
  SpatialSegment,
} from '@stellar/desktop-interaction';
import type { StageCatalogue } from './stage-catalogue';
import { boundedJson, plainRecord } from './stage-json';
import { presentationText as text, publicHttps } from './presentation-decoders';

const surfaces = ['rich-text', 'chart', 'image', 'diagram'];
const keys = (value: Record<string, unknown>, allowed: string) =>
  Object.keys(value).every((key) => allowed.split(' ').includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

function scene(value: unknown): SpatialScene | null {
  if (!plainRecord(value) || !keys(value, 'title label description sample'))
    return null;
  const { title, label, description, sample } = value;
  if (
    !text(title, 90) ||
    !text(label, 45) ||
    (description !== undefined && !text(description, 220)) ||
    (sample !== undefined && typeof sample !== 'boolean')
  )
    return null;
  return { title, label, description, sample };
}

function panel(value: unknown, catalogue: StageCatalogue): SpatialPanel | null {
  if (
    !plainRecord(value) ||
    !keys(value, 'id title category summary group emphasis source detail')
  )
    return null;
  const {
    id: panelId,
    title,
    category,
    summary,
    group,
    emphasis,
    source,
    detail,
  } = value;
  if (
    !id(panelId) ||
    !text(title, 120) ||
    !text(category, 36) ||
    !text(summary, 280) ||
    (group !== undefined && !id(group)) ||
    (emphasis !== undefined && emphasis !== 'lead' && emphasis !== 'supporting')
  )
    return null;
  const sourceUrl = source === undefined ? undefined : publicHttps(source);
  if (sourceUrl === null) return null;
  const common: SpatialPanel = {
    id: panelId,
    title,
    category,
    summary,
    group,
    emphasis,
    source: sourceUrl,
  };
  if (detail === undefined) return common;
  if (
    !plainRecord(detail) ||
    !keys(detail, 'surface payload') ||
    typeof detail['surface'] !== 'string' ||
    !surfaces.includes(detail['surface'])
  )
    return null;
  const surface = detail['surface'];
  const payload = catalogue[surface]?.decode(detail['payload']);
  return payload == null ? null : { ...common, detail: { surface, payload } };
}

function action(
  value: unknown,
  catalogue: StageCatalogue,
): SpatialAction | null {
  if (!plainRecord(value)) return null;
  const { kind, ids } = value;
  switch (kind) {
    case 'clear':
    case 'overview':
      return keys(value, 'kind') ? { kind } : null;
    case 'show': {
      const card = panel(value['panel'], catalogue);
      return card && keys(value, 'kind panel') ? { kind, panel: card } : null;
    }
    case 'compare':
      return keys(value, 'kind ids') &&
        Array.isArray(ids) &&
        ids.length === 2 &&
        id(ids[0]) &&
        id(ids[1]) &&
        ids[0] !== ids[1]
        ? { kind, ids: [ids[0], ids[1]] }
        : null;
    case 'focus':
    case 'defocus':
    case 'expand':
    case 'collapse':
    case 'dismiss':
      return keys(value, 'kind id') && id(value['id'])
        ? { kind, id: value['id'] }
        : null;
    default:
      return null;
  }
}

function actions(
  value: unknown,
  catalogue: StageCatalogue,
): readonly SpatialAction[] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const decoded = value.map((entry) => action(entry, catalogue));
  return decoded.every((entry) => entry !== null) ? decoded : null;
}

export function decodeSpatialScore(
  value: unknown,
  catalogue: StageCatalogue,
): SpatialScore | null {
  if (
    !boundedJson(value, 32768, 8000) ||
    !plainRecord(value) ||
    !keys(value, 'begin prepare segments')
  )
    return null;
  const begin =
    value['begin'] === undefined ? undefined : scene(value['begin']);
  const prepare =
    value['prepare'] === undefined ? [] : actions(value['prepare'], catalogue);
  const raw = value['segments'] === undefined ? [] : value['segments'];
  if (begin === null || !prepare || !Array.isArray(raw) || raw.length > 12)
    return null;
  const segments: SpatialSegment[] = [];
  for (const entry of raw) {
    if (
      !plainRecord(entry) ||
      !keys(entry, 'text actions after') ||
      !text(entry['text'], 600)
    )
      return null;
    const start = actions(entry['actions'], catalogue);
    const after =
      entry['after'] === undefined
        ? undefined
        : actions(entry['after'], catalogue);
    if (!start || after === null) return null;
    segments.push({ text: entry['text'], actions: start, after });
  }
  return begin || prepare.length || segments.length
    ? { begin, prepare, segments }
    : null;
}
