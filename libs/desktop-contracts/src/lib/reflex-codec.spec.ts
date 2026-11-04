import { describe, expect, it } from 'vitest';
import { decodeReflexReply, decodeReflexMediaState } from './reflex-codec';

describe('Reflex native contracts', () => {
  it('accepts only short, correlated and internally consistent plans', () => {
    const value = {
      version: 1,
      input_id: 'one',
      plan: { route: 'action', action_id: 'media.next', reply: 'Much better.' },
    };
    expect(decodeReflexReply(value, 'one')).toEqual(value);
    for (const bad of [
      { ...value, extra: true },
      { ...value, input_id: 'two' },
      { ...value, plan: { ...value.plan, route: 'shell' } },
      { ...value, plan: { ...value.plan, action_id: null } },
      { ...value, plan: { ...value.plan, reply: '<think>skip</think>' } },
      { ...value, plan: { ...value.plan, reply: 'word '.repeat(12) } },
    ])
      expect(() => decodeReflexReply(bad, 'one')).toThrow();
  });
  it('validates media capabilities, endpoint identity and scalar ranges', () => {
    const value = {
      ticket: '1',
      player: 'mock',
      title: 'Song',
      playing: true,
      volume: 60,
      muted: false,
      endpoint_id: 'device',
      actions: ['next'],
    };
    expect(decodeReflexMediaState(value)).toEqual(value);
    for (const bad of [
      { ...value, volume: 101 },
      { ...value, actions: ['shell'] },
      { ...value, endpoint_id: 10 },
      { ...value, actions: ['next', 'next'] },
    ])
      expect(() => decodeReflexMediaState(bad)).toThrow();
  });
});
