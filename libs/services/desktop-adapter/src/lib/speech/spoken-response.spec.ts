import { describe, expect, it } from 'vitest';
import { spokenResponse } from './spoken-response';

describe('committed speech text', () => {
  it('retains exact final prose and excludes presentation payloads', () => {
    expect(
      spokenResponse([
        { kind: 'text', text: 'Here is the complete response.' },
        {
          kind: 'component',
          component: 'assistant_message',
          title: 'Title',
          body: 'Do not narrate this payload',
        },
      ]),
    ).toBe('Here is the complete response.');
  });
  it.each([
    '{"text":"unfinished',
    '{"stellar_presentation":',
    '```json\n{}',
    '[{"tool_call":',
    '<think>private</think>Visible',
    'Visible <analysis>private</analysis>',
  ])('does not narrate structured or internal text: %s', (text) => {
    expect(spokenResponse([{ kind: 'text', text }])).toBe('');
  });
});
