import type {
  WorkspaceIssuePayload,
  WorkspaceIssueReference,
  WorkspaceIssueStatus,
  WorkspaceIssueState,
} from '../generated';
import { boundedString, DesktopContractError, record } from './wire-validation';

function invalid(): never {
  throw new DesktopContractError('malformed');
}
function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object') return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== 'string' ||
        !descriptor?.enumerable ||
        !('value' in descriptor)
      );
    })
  )
    return invalid();
  return record(value, fields);
}
function text(value: unknown, limit: number): string {
  const result = boundedString(value, limit);
  if (
    !result.trim() ||
    Array.from(result).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return invalid();
  return result;
}
function repository(value: unknown): string {
  const result = text(value, 201);
  const parts = result.split('/');
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..',
    )
  )
    return invalid();
  return result;
}
function number(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 4294967295
  )
    return invalid();
  return value;
}
function choice<T extends string>(value: unknown, choices: Record<T, true>): T {
  if (typeof value !== 'string' || !Object.hasOwn(choices, value))
    return invalid();
  return value as T;
}
function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
  return value === null ? null : decode(value);
}
function list<T>(
  value: unknown,
  limit: number,
  decode: (value: unknown) => T,
): T[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  const result: T[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    result.push(decode(descriptor.value));
  }
  return result;
}
function references(value: unknown): WorkspaceIssueReference[] {
  const items = list(value, 8, (entry) => {
    const data = object(entry, ['repository', 'number', 'title']);
    return {
      repository: repository(data['repository']),
      number: number(data['number']),
      title: text(data['title'], 240),
    };
  });
  if (
    new Set(
      items.map((item) => `${item.repository.toLowerCase()}#${item.number}`),
    ).size !== items.length
  )
    return invalid();
  return items;
}

export function decodeWorkspaceIssuePayload(
  value: unknown,
): WorkspaceIssuePayload {
  const data = object(value, [
    'title',
    'repository',
    'issue_number',
    'source',
    'observed_at_ms',
    'status',
    'issue',
  ]);
  const repo = repository(data['repository']);
  const issue_number = number(data['issue_number']);
  const source = text(data['source'], 260);
  if (source !== `https://github.com/${repo}/issues/${issue_number}`)
    return invalid();
  const status = choice<WorkspaceIssueStatus>(data['status'], {
    ready: true,
    stale: true,
    loading: true,
    unavailable: true,
    error: true,
  });
  const observed_at_ms = nullable(data['observed_at_ms'], (value) => {
    if (
      typeof value !== 'string' ||
      !/^[1-9][0-9]{0,15}$/.test(value) ||
      Number(value) > 8640000000000000
    )
      return invalid();
    return value;
  });
  const issue = nullable(data['issue'], (value) => {
    const item = object(value, [
      'state',
      'description',
      'workflow_status',
      'labels',
      'owner',
      'blockers',
      'pull_requests',
    ]);
    const labels = nullable(item['labels'], (value) =>
      list(value, 24, (value) => text(value, 80)),
    );
    if (labels && new Set(labels).size !== labels.length) return invalid();
    return {
      state: choice<WorkspaceIssueState>(item['state'], {
        open: true,
        closed: true,
      }),
      description: nullable(item['description'], (value) => text(value, 1200)),
      workflow_status: nullable(item['workflow_status'], (value) =>
        text(value, 80),
      ),
      labels,
      owner: nullable(item['owner'], (value) => text(value, 100)),
      blockers: nullable(item['blockers'], references),
      pull_requests: nullable(item['pull_requests'], references),
    };
  });
  if (status === 'ready' || status === 'stale') {
    if (!observed_at_ms || !issue) return invalid();
  } else if (observed_at_ms !== null || issue !== null) return invalid();
  const result = {
    title: text(data['title'], 240),
    repository: repo,
    issue_number,
    source,
    observed_at_ms,
    status,
    issue,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384)
    return invalid();
  return result;
}
