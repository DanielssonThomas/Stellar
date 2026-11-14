import { describe, it, expect } from 'vitest';
import {
  decodeIvyClaimUpdate,
  decodeIvySnapshot,
  decodeIvySubmitRequest,
  decodeIvyQuestionReply,
} from './ivy-codec';
const id = '00000000-0000-4000-8000-000000000001';

describe('background update contract', () => {
  it('retains bounded text and a native speech claim while rejecting duplicates and executable fields', () => {
    const update = {
      id: 'background',
      text: 'Completed update',
      speech_claim: null,
    };
    expect(
      decodeIvySnapshot({ ...snapshot(), background_updates: [update] })
        .background_updates,
    ).toEqual([update]);
    for (const updates of [
      [update, update],
      [{ ...update, action: 'close_activity' }],
      [{ ...update, speech_claim: 'bad' }],
      [{ ...update, text: 'x'.repeat(262145) }],
    ]) {
      expect(() =>
        decodeIvySnapshot({ ...snapshot(), background_updates: updates }),
      ).toThrow();
    }
    expect(
      decodeIvyClaimUpdate({
        version: 1,
        update_id: 'background',
        request_id: id,
      }),
    ).toMatchObject({ update_id: 'background' });
    expect(() =>
      decodeIvyClaimUpdate({
        version: 1,
        update_id: 'background',
        request_id: id,
        permission: 'allow',
      }),
    ).toThrow();
  });
});
const snapshot = () => ({
  version: 1,
  revision: '18446744073709551615',
  turn_id: id,
  model: 'terra',
  verified_model: null,
  workspace_tools: 'unavailable',
  workspace_epoch: '0',
  reset_id: null,
  activity: [],
  response_segments: [],
  connection: 'ready',
  turn: 'completed',
  items: [
    { kind: 'text', text: 'Done' },
    {
      kind: 'component',
      component: 'assistant_message',
      title: 'Requested result',
      body: 'Plain <script> text',
    },
  ],
  error: null,
});
describe('Ivy wire validation', () => {
  it('validates bounded sealed response segments and preserves the final reuse marker', () => {
    const commentary = {
      id: '1'.repeat(64),
      kind: 'commentary',
      text: 'Your meeting is at ten.',
      sequence: '18446744073709551615',
      reused: false,
    };
    const final = {
      ...commentary,
      id: '2'.repeat(64),
      kind: 'final',
      sequence: null,
      reused: true,
    };
    expect(
      decodeIvySnapshot({
        ...snapshot(),
        response_segments: [commentary, final],
      }).response_segments,
    ).toEqual([commentary, final]);
    for (const text of [
      '[The notes](https://example.test/notes) are ready.',
      '[The notes](\n  https://example.test/notes\n  "Report title") are ready.',
      '<https://example.test/notes> has the notes.',
      '<mailto:hello@example.test> is the contact address.',
      '\x60npm test\x60 has finished.',
    ]) {
      const row = { ...commentary, text };
      expect(
        decodeIvySnapshot({ ...snapshot(), response_segments: [row] })
          .response_segments,
      ).toEqual([row]);
    }
    for (const rows of [
      [commentary, commentary],
      [{ ...commentary, id: 'foreign' }],
      [{ ...commentary, kind: 'reasoning' }],
      [{ ...commentary, sequence: null }],
      [{ ...commentary, reused: true }],
      [{ ...commentary, text: '😀'.repeat(1025) }],
      [{ ...commentary, text: 'Description\n{"partial":' }],
      [{ ...commentary, text: '<think>private</think>' }],
      [{ ...commentary, text: '["private"]' }],
      [{ ...commentary, text: '<script>private</script>' }],
      [{ ...commentary, text: '\x60\x60\x60js\nprivate\n\x60\x60\x60' }],
      [{ ...commentary, text: '\x60{"private":true}\x60' }],
      [{ ...commentary, text: '<https://example.test/notes' }],
      [{ ...commentary, text: 'Closing </tool_call> marker' }],
      [final, commentary],
      Array.from({ length: 17 }, (_, index) => ({
        ...commentary,
        id: index.toString(16).padStart(64, '0'),
      })),
    ])
      expect(() =>
        decodeIvySnapshot({ ...snapshot(), response_segments: rows }),
      ).toThrow();
  });
  it('accepts bounded provider/action enums and rejects arbitrary metadata', () => {
    const row = {
      id: '0123456789abcdef',
      kind: 'mcp',
      state: 'running',
      provider: 'calendar',
      operation: 'list',
    };
    expect(
      decodeIvySnapshot({ ...snapshot(), activity: [row] }).activity,
    ).toEqual([row]);
    for (const bad of [
      { ...row, provider: 'secret' },
      { ...row, operation: 'rm -rf' },
      { ...row, operation: null },
      { ...row, args: 'secret' },
    ])
      expect(() =>
        decodeIvySnapshot({ ...snapshot(), activity: [bad] }),
      ).toThrow();
  });
  it('validates question bounds, exact actions and unique prompt IDs', () => {
    const question = {
      id: 'q1',
      text: 'Choose',
      choices: ['Left'],
      multi_select: false,
      shown: false,
      answering: false,
    };
    expect(
      decodeIvySnapshot({ ...snapshot(), questions: [question] }).questions,
    ).toEqual([question]);
    for (const questions of [
      [question, question],
      [{ ...question, choices: Array(5).fill('x') }],
      [{ ...question, shown: 'yes' }],
    ])
      expect(() => decodeIvySnapshot({ ...snapshot(), questions })).toThrow();
    for (const action of [
      { kind: 'shown' },
      { kind: 'answer', answer: 'Left' },
      { kind: 'skip' },
      { kind: 'cancel' },
    ])
      expect(
        decodeIvyQuestionReply({ version: 1, prompt_id: 'q1', action }).action,
      ).toEqual(action);
    for (const action of [
      { kind: 'answer', answer: '' },
      { kind: 'skip', answer: 'x' },
      { kind: 'execute' },
    ])
      expect(() =>
        decodeIvyQuestionReply({ version: 1, prompt_id: 'q1', action }),
      ).toThrow();
  });
  it('preserves full Unicode replies and presentation content beyond former caps', () => {
    const content = '🪐"\\\n'.repeat(100_000);
    const value = {
      ...snapshot(),
      items: [
        { kind: 'text', text: content },
        {
          kind: 'component',
          component: 'assistant_message',
          title: 'é'.repeat(1000),
          body: content,
        },
      ],
    };
    expect(decodeIvySnapshot(value)).toEqual(value);
    expect(
      decodeIvySnapshot({ ...snapshot(), items: [{ kind: 'close_activity' }] })
        .items,
    ).toEqual([{ kind: 'close_activity' }]);
    for (const item of [
      { kind: 'close_activity', extra: true },
      { kind: 'close_all' },
    ])
      expect(() =>
        decodeIvySnapshot({ ...snapshot(), items: [item] }),
      ).toThrow();
  });
  it('accepts settled failure and empty cancellation snapshots without a fake text item', () => {
    expect(
      decodeIvySnapshot({
        ...snapshot(),
        turn: 'failed',
        items: [],
        error: 'turn_failed',
      }),
    ).toMatchObject({ turn: 'failed', error: 'turn_failed', items: [] });
    expect(
      decodeIvySnapshot({ ...snapshot(), turn: 'cancelled', items: [] }),
    ).toMatchObject({ turn: 'cancelled', items: [] });
  });
  it('preserves u64 precision and keeps reply and presentation separate', () => {
    expect(decodeIvySnapshot(snapshot())).toEqual(snapshot());
  });
  it.each(['01', '-1', '18446744073709551616', '1.5'])(
    'rejects revision %s',
    (revision) => {
      expect(() => decodeIvySnapshot({ ...snapshot(), revision })).toThrow();
    },
  );
  it.each([
    { model: 'other' },
    { verified_model: 'sol' },
    { connection: 'other' },
    { turn: 'other' },
    { error: 'private failure' },
    { turn_id: 'invalid' },
    { version: 2 },
    { ticket: 'private' },
  ])('rejects invalid envelopes %j', (patch) => {
    expect(() => decodeIvySnapshot({ ...snapshot(), ...patch })).toThrow();
  });
  it('rejects unknown components and duplicate kinds', () => {
    expect(() =>
      decodeIvySnapshot({
        ...snapshot(),
        items: [
          { kind: 'component', component: 'html', title: 'x', body: 'x' },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeIvySnapshot({
        ...snapshot(),
        items: [
          { kind: 'text', text: 'a' },
          { kind: 'text', text: 'b' },
        ],
      }),
    ).toThrow();
  });
  it('bounds UTF8 submit text and validates canonical turn IDs', () => {
    expect(
      decodeIvySubmitRequest({ version: 1, input_id: id, text: 'hello' }),
    ).toEqual({ version: 1, input_id: id, text: 'hello' });
    for (const text of [' ', 'é'.repeat(4097), '\ud800'])
      expect(() =>
        decodeIvySubmitRequest({ version: 1, input_id: id, text }),
      ).toThrow();
    expect(() =>
      decodeIvySubmitRequest({
        version: 1,
        input_id: 'ABCDEF00-0000-4000-8000-000000000001',
        text: 'hello',
      }),
    ).toThrow();
  });
});

it('bounds and validates activity categories without admitting raw arguments or duplicated rows', () => {
  const row = { id: '0123456789abcdef', kind: 'memory', state: 'running' };
  expect(
    decodeIvySnapshot({ ...snapshot(), activity: [row] }).activity,
  ).toEqual([row]);
  for (const activity of [
    [{ ...row, args: { secret: 'hidden' } }],
    [row, row],
    Array(13).fill(row),
    [{ ...row, state: 'guessed' }],
    [{ ...row, id: 'unbounded private tool identifier' }],
  ]) {
    expect(() => decodeIvySnapshot({ ...snapshot(), activity })).toThrow();
  }
});
