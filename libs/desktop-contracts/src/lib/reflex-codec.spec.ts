import { describe, expect, it } from 'vitest';
import {
  decodeReflexReply,
  decodeReflexMediaState,
  decodeReflexAvailability,
  decodeReflexRouting,
} from './reflex-codec';

describe('Reflex native contracts', () => {
  it('rejects malformed routing replies rather than granting local authority', () => {
    expect(decodeReflexRouting({ version: 1, local: false }).local).toBe(false);
    for (const bad of [
      null,
      { version: 2, local: true },
      { version: 1, local: 'yes' },
      { version: 1, local: true, extra: true },
    ])
      expect(() => decodeReflexRouting(bad)).toThrow();
  });
  it('requires an exact versioned boolean readiness reply', () => {
    expect(
      decodeReflexAvailability({ version: 1, configured: true }).configured,
    ).toBe(true);
    for (const bad of [
      null,
      { version: 2, configured: true },
      { version: 1, configured: 'yes' },
      { version: 1, configured: true, extra: true },
    ])
      expect(() => decodeReflexAvailability(bad)).toThrow();
  });
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
