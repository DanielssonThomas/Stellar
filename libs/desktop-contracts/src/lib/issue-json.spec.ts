import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceIssueJson } from './issue-json';
import {
  decodeWorkspaceToolRequest,
  decodeWorkspaceToolOutcome,
} from './workspace-codec';

type Fixture = {
  valid_payload_json: string;
  invalid: { name: string; payload_json: string }[];
  spatial_wrappers: { name: string; prefix: string; suffix: string }[];
};
const fixtures: Fixture = JSON.parse(
  readFileSync(
    resolve('tools/native/fixtures/workspace-issue-duplicates.json'),
    'utf8',
  ),
);
const frame = (operation: unknown) => ({
  version: 1,
  request_id: '1234567890abcdef1234567890abcdef',
  epoch: '2',
  turn_id: '00000000-0000-4000-8000-000000000001',
  expires_at_ms: '1794554249258',
  operation,
});
const open = (raw: string) => ({
  kind: 'open',
  instance_id: 'issue',
  surface: 'github-issue',
  prominence: 'primary',
  payload_json: raw,
});
const inspected = (raw: string) => ({
  kind: 'content',
  instance_id: 'issue',
  surface: 'github-issue',
  revision: 0,
  payload_json: raw,
});
const inspectRequest = decodeWorkspaceToolRequest(
  frame({ kind: 'inspect_content', instance_id: 'issue' }),
);

describe('raw issue duplicate-key boundaries', () => {
  it('preserves valid semantics at all five boundaries using the shared raw bytes', () => {
    const raw = fixtures.valid_payload_json;
    expect(parseWorkspaceIssueJson(raw)).toEqual(JSON.parse(raw));
    expect(decodeWorkspaceToolRequest(frame(open(raw))).operation).toEqual(
      open(raw),
    );
    expect(decodeWorkspaceToolOutcome(inspected(raw), inspectRequest)).toEqual(
      inspected(raw),
    );
    for (const wrapper of fixtures.spatial_wrappers) {
      const operation = {
        kind: 'present',
        score_json: wrapper.prefix + raw + wrapper.suffix,
      };
      expect(decodeWorkspaceToolRequest(frame(operation)).operation).toEqual(
        operation,
      );
    }
  });
  it.each(fixtures.invalid)(
    'refuses $name before decoded metadata can be consumed',
    ({ payload_json: raw }) => {
      expect(() => parseWorkspaceIssueJson(raw)).toThrow();
      expect(() => decodeWorkspaceToolRequest(frame(open(raw)))).toThrow();
      expect(() =>
        decodeWorkspaceToolRequest(
          frame({
            kind: 'update',
            instance_id: 'issue',
            surface: 'github-issue',
            payload_json: raw,
            expected_revision: 0,
          }),
        ),
      ).toThrow();
      expect(() =>
        decodeWorkspaceToolOutcome(inspected(raw), inspectRequest),
      ).toThrow();
      for (const wrapper of fixtures.spatial_wrappers)
        expect(() =>
          decodeWorkspaceToolRequest(
            frame({
              kind: 'present',
              score_json: wrapper.prefix + raw + wrapper.suffix,
            }),
          ),
        ).toThrow();
    },
  );
  it.each(['before', 'after'])(
    'fails closed on an unrelated over-depth value %s any issue surface',
    (position) => {
      const deep = '['.repeat(130) + '0' + ']'.repeat(130);
      for (const fixture of fixtures.invalid) {
        for (const wrapper of fixtures.spatial_wrappers) {
          const score = wrapper.prefix + fixture.payload_json + wrapper.suffix;
          for (const raw of [
            score,
            score.replace('"surface"', '"surfac\\u0065"'),
          ]) {
            const score_json =
              position === 'before'
                ? '{"extra":' + deep + ',' + raw.slice(1)
                : raw.slice(0, -1) + ',"extra":' + deep + '}';
            expect(() =>
              decodeWorkspaceToolRequest(
                frame({ kind: 'present', score_json }),
              ),
            ).toThrow();
          }
        }
      }
    },
  );
  it.each(['prepare', '\\u0070repare'])(
    'fails closed when an over-depth value accompanies hidden duplicate parent %s',
    (key) => {
      const deep = '['.repeat(130) + '0' + ']'.repeat(130);
      const wrapper = fixtures.spatial_wrappers[0];
      const score =
        wrapper.prefix + fixtures.valid_payload_json + wrapper.suffix;
      const hidden = score.slice(0, -1) + ',"' + key + '":[]}';
      for (const score_json of [
        '{"extra":' + deep + ',' + hidden.slice(1),
        hidden.slice(0, -1) + ',"extra":' + deep + '}',
      ]) {
        expect(() =>
          decodeWorkspaceToolRequest(frame({ kind: 'present', score_json })),
        ).toThrow();
      }
      expect(() =>
        decodeWorkspaceToolRequest(
          frame({ kind: 'present', score_json: hidden }),
        ),
      ).toThrow();
    },
  );
  it('does not infer non-issue admission from an incomplete scan', () => {
    for (const score_json of [
      '{"prepare":',
      '{"extra":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}',
    ]) {
      expect(() =>
        decodeWorkspaceToolRequest(frame({ kind: 'present', score_json })),
      ).toThrow();
    }
    const operation = {
      kind: 'present',
      score_json: JSON.stringify({
        prepare: [
          {
            kind: 'show',
            panel: {
              id: 'message',
              title: 'Message',
              category: 'Note',
              summary: 'Observed text',
              detail: {
                surface: 'assistant-message',
                payload: {
                  title: 'Message',
                  body: 'Literal "surface":"github-issue" is not a surface member',
                },
              },
            },
          },
        ],
        segments: [{ text: 'Message', actions: [], after: [] }],
      }),
    };
    expect(decodeWorkspaceToolRequest(frame(operation)).operation).toEqual(
      operation,
    );
  });
  it('scopes member names to each object and handles escaped quotes, arrays and primitive tokens', () => {
    const value = {
      title: 'Literal "title","title": \\ not keys',
      nested: { title: 'Allowed' },
      items: [{ title: 'Another' }, null, true, -1.5e10],
    };
    expect(parseWorkspaceIssueJson(JSON.stringify(value))).toEqual(value);
    expect(() =>
      parseWorkspaceIssueJson('{"title":1,"tit\\u006ce":2}'),
    ).toThrow();
    for (const raw of ['{"a":}', '{"a":1} trailing', '[1,]', '"unterminated'])
      expect(() => parseWorkspaceIssueJson(raw)).toThrow();
    expect(() =>
      parseWorkspaceIssueJson('['.repeat(130) + '0' + ']'.repeat(130)),
    ).toThrow();
  });
  it('does not alter the legacy non-issue command, content or score policy', () => {
    const operation = {
      ...open('{"title":"First","title":"Second","body":"Visible"}'),
      surface: 'assistant-message',
    };
    expect(decodeWorkspaceToolRequest(frame(operation)).operation).toEqual(
      operation,
    );
    const outcome = {
      ...inspected(
        '{"title":"First","title":"Second","blocks":[{"kind":"paragraph","text":"Visible"}]}',
      ),
      surface: 'rich-text',
    };
    expect(decodeWorkspaceToolOutcome(outcome, inspectRequest)).toEqual(
      outcome,
    );
    const nonIssue = {
      kind: 'present',
      score_json: '{"prepare":[],"prepare":[]}',
    };
    expect(decodeWorkspaceToolRequest(frame(nonIssue)).operation).toEqual(
      nonIssue,
    );
  });
  it('detects issue surfaces even when duplicate parent fields would hide them after JSON.parse', () => {
    const raw =
      fixtures.spatial_wrappers[0].prefix +
      fixtures.valid_payload_json +
      fixtures.spatial_wrappers[0].suffix;
    const hidden = raw.slice(0, -1) + ',"prepare":[]}';
    expect(() =>
      decodeWorkspaceToolRequest(
        frame({ kind: 'present', score_json: hidden }),
      ),
    ).toThrow();
  });
});
