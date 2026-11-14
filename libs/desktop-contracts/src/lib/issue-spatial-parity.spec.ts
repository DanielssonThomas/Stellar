import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWorkspaceToolRequest } from './workspace-codec';

type Wrapper = {
  name: string;
  prefix: string;
  suffix: string;
  hidden_suffix: string;
  hidden_escaped_suffix: string;
};
const raw: {
  valid_payload_json: string;
  semantic_invalid: { name: string; payload_json: string }[];
  spatial_wrappers: Wrapper[];
} = JSON.parse(
  readFileSync(
    resolve('tools/native/fixtures/workspace-issue-duplicates.json'),
    'utf8',
  ),
);
const semantic: {
  valid: Record<string, unknown>;
  invalid: { path: string[]; value: unknown }[];
} = JSON.parse(
  readFileSync(resolve('tools/native/fixtures/workspace-issue.json'), 'utf8'),
);
const frame = (operation: unknown) => ({
  version: 1,
  request_id: '1234567890abcdef1234567890abcdef',
  epoch: '2',
  turn_id: '00000000-0000-4000-8000-000000000001',
  expires_at_ms: '1794554249258',
  operation,
});
const present = (score_json: string) =>
  decodeWorkspaceToolRequest(frame({ kind: 'present', score_json }));
const score = (wrapper: Wrapper, payload: string) =>
  wrapper.prefix + payload + wrapper.suffix;

describe('issue semantic parity at the spatial request boundary', () => {
  it.each(
    raw.semantic_invalid.flatMap((entry) =>
      raw.spatial_wrappers.map((wrapper) => ({
        ...entry,
        wrapper,
        route: wrapper.name,
      })),
    ),
  )(
    'refuses $name at $route with no duplicate keys',
    ({ payload_json, wrapper }) => {
      expect(() =>
        decodeWorkspaceToolRequest(
          frame({
            kind: 'open',
            instance_id: 'issue',
            surface: 'github-issue',
            prominence: 'primary',
            payload_json,
          }),
        ),
      ).toThrow();
      const input = score(wrapper, payload_json);
      expect(() => present(input)).toThrow();
      expect(() =>
        present(input.replace('"surface"', '"surfac\\u0065"')),
      ).toThrow();
    },
  );
  it.each(semantic.invalid)(
    'applies the existing shared semantic rejection $path to every spatial route',
    (entry) => {
      const invalid = structuredClone(semantic.valid);
      let parent = invalid;
      for (const key of entry.path.slice(0, -1))
        parent = parent[key] as Record<string, unknown>;
      const field = entry.path.at(-1);
      if (!field) throw Error('Missing fixture path');
      parent[field] = entry.value;
      for (const wrapper of raw.spatial_wrappers)
        expect(() =>
          present(score(wrapper, JSON.stringify(invalid))),
        ).toThrow();
    },
  );
  it('admits valid shared issue data without rewriting the raw score', () => {
    for (const wrapper of raw.spatial_wrappers) {
      const score_json = score(wrapper, raw.valid_payload_json);
      expect(present(score_json).operation).toEqual({
        kind: 'present',
        score_json,
      });
      expect(
        present(score_json.replace('"surface"', '"surfac\\u0065"')).operation
          .kind,
      ).toBe('present');
    }
  });
  it('rejects the same hidden duplicate parents and escaped equivalent names as Rust/Python', () => {
    for (const payload of [
      raw.valid_payload_json,
      ...raw.semantic_invalid.map((entry) => entry.payload_json),
    ]) {
      for (const wrapper of raw.spatial_wrappers) {
        const input = score(wrapper, payload);
        for (const suffix of [
          wrapper.hidden_suffix,
          wrapper.hidden_escaped_suffix,
        ]) {
          const hidden = input.slice(0, -1) + suffix;
          expect(() => present(hidden)).toThrow();
          expect(() =>
            present(hidden.replace('"surface"', '"surfac\\u0065"')),
          ).toThrow();
        }
      }
    }
  });
});
