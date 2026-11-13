import { boundedString, DesktopContractError } from './wire-validation';
import { decodeWorkspaceIssuePayload } from './issue-codec';

function malformed(): never {
  throw new DesktopContractError('malformed');
}

/** JSON.parse owns syntax; this structural walk retains every decoded member name. */
function scan(raw: string) {
  boundedString(raw, 32768);
  const value: unknown = JSON.parse(raw);
  let cursor = 0;
  let duplicate = false;
  let issueSurface = false;
  const whitespace = () => {
    while ([' ', '\t', '\r', '\n'].includes(raw[cursor])) cursor++;
  };
  const string = (): string => {
    whitespace();
    if (raw[cursor] !== '"') return malformed();
    const start = cursor++;
    while (cursor < raw.length) {
      if (raw[cursor] === '\\') cursor += 2;
      else if (raw[cursor++] === '"')
        return JSON.parse(raw.slice(start, cursor));
    }
    return malformed();
  };
  const visit = (depth: number): string | undefined => {
    if (depth > 128) return malformed();
    whitespace();
    const token = raw[cursor];
    if (token === '"') return string();
    if (token === '{') {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (raw[cursor] === '}') {
        cursor++;
        return;
      }
      while (cursor < raw.length) {
        const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        if (raw[cursor++] !== ':') return malformed();
        const member = visit(depth + 1);
        if (key === 'surface' && member === 'github-issue') issueSurface = true;
        whitespace();
        if (raw[cursor] === '}') {
          cursor++;
          return;
        }
        if (raw[cursor++] !== ',') return malformed();
      }
      return malformed();
    }
    if (token === '[') {
      cursor++;
      whitespace();
      if (raw[cursor] === ']') {
        cursor++;
        return;
      }
      while (cursor < raw.length) {
        visit(depth + 1);
        whitespace();
        if (raw[cursor] === ']') {
          cursor++;
          return;
        }
        if (raw[cursor++] !== ',') return malformed();
      }
      return malformed();
    }
    const start = cursor;
    while (
      cursor < raw.length &&
      ![',', '}', ']', ' ', '\t', '\r', '\n'].includes(raw[cursor])
    )
      cursor++;
    if (cursor === start) return malformed();
    return;
  };
  visit(0);
  whitespace();
  if (cursor !== raw.length) return malformed();
  return { value, duplicate, issueSurface };
}

export function parseWorkspaceIssueJson(raw: string): unknown {
  const parsed = scan(raw);
  if (parsed.duplicate) return malformed();
  return parsed.value;
}

function objectData(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Check issue details at the native/bridge routes, without imposing other surface schemas. */
export function validateWorkspaceIssueScoreJson(raw: string): void {
  let parsed: ReturnType<typeof scan>;
  try {
    parsed = scan(raw);
  } catch {
    return malformed();
  }
  if (parsed.issueSurface && parsed.duplicate) malformed();
  const root = objectData(parsed.value);
  const groups = [root?.['prepare']];
  const segments = root?.['segments'];
  if (Array.isArray(segments)) {
    for (const segment of segments) {
      const data = objectData(segment);
      groups.push(data?.['actions'], data?.['after']);
    }
  }
  for (const actions of groups) {
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const data = objectData(action);
      if (data?.['kind'] !== 'show') continue;
      const panel = objectData(data['panel']);
      const detail = objectData(panel?.['detail']);
      if (detail?.['surface'] === 'github-issue')
        decodeWorkspaceIssuePayload(detail['payload']);
    }
  }
}
