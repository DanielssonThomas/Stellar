import { describe, it, expect } from 'vitest';
import { decodeIvySnapshot, decodeIvySubmitRequest } from './ivy-codec';
const id = '00000000-0000-4000-8000-000000000001';
const snapshot = () => ({
  version: 1,
  revision: '18446744073709551615',
  turn_id: id,
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
