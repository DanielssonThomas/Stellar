import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWorkspaceIssuePayload } from './issue-codec';
import {
  decodeWorkspaceToolRequest,
  decodeWorkspaceToolOutcome,
} from './workspace-codec';

const fixtures = JSON.parse(
  readFileSync(resolve('tools/native/fixtures/workspace-issue.json'), 'utf8'),
);
const value = () => structuredClone(fixtures.valid);
const request = (payload: unknown) => ({
  version: 1,
  request_id: '1234567890abcdef1234567890abcdef',
  epoch: '2',
  turn_id: '00000000-0000-4000-8000-000000000001',
  expires_at_ms: '1794554249258',
  operation: {
    kind: 'open',
    instance_id: 'issue',
    surface: 'github-issue',
    prominence: 'primary',
    payload_json: JSON.stringify(payload),
  },
});

describe('bounded issue contracts', () => {
  it('round trips and detaches observed lists and references', () => {
    const input = value();
    const decoded = decodeWorkspaceIssuePayload(input);
    expect(decoded).toEqual(input);
    input.issue.labels.push('changed');
    input.issue.blockers[0].title = 'changed';
    expect(decoded.issue?.labels).toEqual(['type:feature']);
    expect(decoded.issue?.blockers?.[0].title).toBe('Dependency');
    expect(
      decodeWorkspaceToolRequest(request(value())).operation,
    ).toMatchObject({ surface: 'github-issue' });
  });
  it.each(fixtures.invalid as { path: string[]; value: unknown }[])(
    'rejects shared malformed case $path',
    (entry) => {
      const invalid = value();
      let parent = invalid;
      for (const key of entry.path.slice(0, -1)) parent = parent[key];
      const field = entry.path.at(-1);
      if (!field) throw Error('Missing fixture path');
      parent[field] = entry.value;
      expect(() => decodeWorkspaceIssuePayload(invalid)).toThrow();
      expect(() => decodeWorkspaceToolRequest(request(invalid))).toThrow();
    },
  );
  it('requires explicit nulls and distinguishes not observed from empty', () => {
    const input = value();
    for (const field of [
      'description',
      'workflow_status',
      'owner',
      'labels',
      'blockers',
      'pull_requests',
    ]) {
      input.issue[field] = null;
      const missing = structuredClone(input);
      delete missing.issue[field];
      expect(() => decodeWorkspaceIssuePayload(missing)).toThrow();
    }
    expect(decodeWorkspaceIssuePayload(input).issue?.labels).toBeNull();
    input.issue.labels = [];
    expect(decodeWorkspaceIssuePayload(input).issue?.labels).toEqual([]);
    for (const status of ['loading', 'error', 'unavailable'])
      expect(
        decodeWorkspaceIssuePayload({
          ...input,
          status,
          issue: null,
          observed_at_ms: null,
        }).status,
      ).toBe(status);
  });
  it('rejects accessors without invoking them, exotic arrays, excessive bytes and references', () => {
    let called = false;
    const input = value();
    Object.defineProperty(input, 'title', {
      enumerable: true,
      get() {
        called = true;
        return 'Unsafe';
      },
    });
    expect(() => decodeWorkspaceIssuePayload(input)).toThrow();
    expect(called).toBe(false);
    for (const title of ['é'.repeat(121), '\ud800'])
      expect(() =>
        decodeWorkspaceIssuePayload({ ...value(), title }),
      ).toThrow();
    for (const labels of [new Array(2), Array(25).fill('a')])
      expect(() =>
        decodeWorkspaceIssuePayload({
          ...value(),
          issue: { ...value().issue, labels },
        }),
      ).toThrow();
  });
  it('validates inspected content as well as commands', () => {
    const req = decodeWorkspaceToolRequest({
      ...request(value()),
      operation: { kind: 'inspect_content', instance_id: 'issue' },
    });
    const outcome = {
      kind: 'content',
      instance_id: 'issue',
      surface: 'github-issue',
      revision: 0,
      payload_json: JSON.stringify(value()),
    };
    expect(decodeWorkspaceToolOutcome(outcome, req)).toEqual(outcome);
    expect(() =>
      decodeWorkspaceToolOutcome({ ...outcome, payload_json: '{}' }, req),
    ).toThrow();
  });
});
