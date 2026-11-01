import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/app-info.json';
import {
  decodeAppInfoError,
  decodeAppInfoEvent,
  decodeAppInfoReply,
  decodeAppInfoRequest,
  DesktopContractError,
} from './app-info-codec';
import { capabilityLabel } from './capability-label';

describe('cross-language app-info boundary', () => {
  it('decodes the same request, reply, event and tagged errors as Rust', () => {
    expect(decodeAppInfoRequest(fixture.request)).toEqual(fixture.request);
    expect(decodeAppInfoReply(fixture.reply)).toEqual(fixture.reply);
    expect(decodeAppInfoEvent(fixture.event)).toEqual(fixture.event);
    for (const error of fixture.errors)
      expect(decodeAppInfoError(error)).toEqual(error);
    expect(
      decodeAppInfoReply(fixture.reply).capabilities.map(capabilityLabel),
    ).toEqual(['Native window controls', 'Contract notifications']);
  });

  it('preserves u64 precision and separates optional omission from required null', () => {
    expect(() =>
      decodeAppInfoRequest({ ...fixture.request, label: '\ud800' }),
    ).toThrow(DesktopContractError);
    expect(decodeAppInfoRequest({ ...fixture.request, label: null })).toEqual(
      fixture.request,
    );
    expect(
      decodeAppInfoRequest({ ...fixture.request, label: 'é'.repeat(40) }).label,
    ).toHaveLength(40);
    expect(decodeAppInfoReply(fixture.reply).build_revision).toBeNull();
    const { build_revision: omitted, ...missing } = fixture.reply;
    expect(omitted).toBeNull();
    expect(() => decodeAppInfoReply(missing)).toThrow(DesktopContractError);
    expect(() => decodeAppInfoReply({ ...fixture.reply, label: null })).toThrow(
      DesktopContractError,
    );
  });

  it.each([
    '',
    '+1',
    '01',
    '-1',
    '18446744073709551616',
    Number('18446744073709551615'),
    '1'.repeat(1024),
  ])('rejects noncanonical sequence %j', (sequence) => {
    expect(() =>
      decodeAppInfoRequest({ ...fixture.request, sequence }),
    ).toThrow(DesktopContractError);
  });

  it('rejects malformed, excessive and unsupported payloads intentionally', () => {
    const malformed = [
      null,
      [],
      {},
      { ...fixture.reply, version: 2 },
      { ...fixture.reply, extra: true },
      { ...fixture.reply, capabilities: [{ kind: 'future_capability' }] },
      {
        ...fixture.reply,
        capabilities: [{ kind: 'native_window', extra: true }],
      },
      {
        ...fixture.reply,
        capabilities: Array.from({ length: 3 }, () => ({
          kind: 'native_window',
        })),
      },
      {
        ...fixture.reply,
        capabilities: [{ kind: 'native_window' }, { kind: 'native_window' }],
      },
      { ...fixture.reply, label: '🦀'.repeat(21) },
      { ...fixture.reply, build_revision: 42 },
    ];
    for (const value of malformed)
      expect(() => decodeAppInfoReply(value)).toThrow(DesktopContractError);
    expect(() =>
      decodeAppInfoRequest({ ...fixture.request, label: 'é'.repeat(41) }),
    ).toThrow(DesktopContractError);
    expect(() => decodeAppInfoEvent({ ...fixture.event, version: 2 })).toThrow(
      DesktopContractError,
    );
    expect(() =>
      decodeAppInfoError({
        code: 'event_unavailable',
        message: 'internal path',
      }),
    ).toThrow(DesktopContractError);
    expect(() => decodeAppInfoError({ code: 'unknown' })).toThrow(
      DesktopContractError,
    );
  });
});
