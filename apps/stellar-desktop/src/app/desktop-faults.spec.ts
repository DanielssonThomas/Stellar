import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopFaults } from './desktop-faults';

describe('desktop fault history', () => {
  afterEach(() => vi.useRealTimers());

  it('retains separate bounded update attempts and stage-only diagnostics beside generic voice faults', () => {
    const faults = new DesktopFaults();
    const failure = {
      admissionId: 'admission',
      claimId: 'claim-1',
      operationId: null,
      stage: 'claim' as const,
      code: 'timeout' as const,
      time: '2026-11-14T16:00:00Z',
    };
    faults.observeUpdate(failure);
    faults.observeUpdate(failure);
    faults.observe('voice', 'failure');
    faults.observe('voice', null);
    expect(
      faults.entries().filter((e) => e.category === 'Voice update'),
    ).toHaveLength(1);
    expect(
      faults.entries().find((e) => e.category === 'Voice update'),
    ).toMatchObject({
      status: 'active',
      time: '2026-11-14T16:00:00.000Z',
      count: 1,
    });
    faults.observeUpdate({
      ...failure,
      claimId: 'claim-2',
      time: '2026-11-14T16:01:00Z',
    });
    expect(
      faults.entries().filter((e) => e.category === 'Voice update'),
    ).toHaveLength(2);
    expect(faults.entries()[0].diagnostic).toContain('claim-2');
    expect(faults.entries().some((e) => e.category === 'Ivy')).toBe(false);
    faults.observeUpdate(null);
    expect(faults.entries()[0].status).toBe('resolved');
  });

  it('omits private/error-like identifiers and never copies raw messages into update diagnostics', () => {
    const faults = new DesktopFaults();
    faults.observeUpdate({
      admissionId: 'private answer with spaces',
      claimId: 'C:/private/token',
      operationId: 'x'.repeat(300),
      stage: 'speech_dispatch',
      code: 'failed',
      time: '2026-11-14T16:00:00Z',
    });
    const output = JSON.stringify(faults.entries());
    expect(output).toContain('Stage: speech_dispatch');
    expect(output).not.toContain('private');
    expect(output).not.toContain('x'.repeat(300));
  });
  it('deduplicates continuous observations and counts a later recurrence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T08:00:00Z'));
    const faults = new DesktopFaults();
    faults.observe('assistant', 'uncertain');
    faults.observe('assistant', 'uncertain');
    expect(faults.entries()).toEqual([
      {
        id: 1,
        time: '2026-11-03T08:00:00.000Z',
        category: 'Ivy',
        message:
          'The Ivy response is uncertain. Check the response before sending again.',
        status: 'active',
        count: 1,
      },
    ]);
    faults.observe('assistant', null);
    vi.setSystemTime(new Date('2026-11-03T08:01:00Z'));
    faults.observe('assistant', 'uncertain');
    expect(faults.entries()[0]).toMatchObject({
      id: 1,
      time: '2026-11-03T08:01:00.000Z',
      status: 'active',
      count: 2,
    });
  });

  it('keeps unresolved faults visible through dismissal and shows resolved history until dismissed', () => {
    const faults = new DesktopFaults();
    faults.observe('microphone', 'denied');
    expect(faults.active()).toBe(true);
    faults.dismiss();
    expect(faults.visible()).toBe(true);
    faults.beginRecovery('microphone');
    expect(faults.entries()[0].status).toBe('recovering');
    faults.endRecovery('microphone', false);
    expect(faults.entries()[0].status).toBe('active');
    faults.beginRecovery('microphone');
    faults.endRecovery('microphone', true);
    expect(faults.active()).toBe(false);
    expect(faults.visible()).toBe(true);
    faults.dismiss();
    expect(faults.visible()).toBe(false);
    faults.show();
    expect(faults.visible()).toBe(true);
    expect(faults.entries()[0].status).toBe('resolved');
  });

  it('resolves only the affected source and retains unrelated active faults', () => {
    const faults = new DesktopFaults();
    faults.observe('assistant', 'timeout');
    faults.observe('voice', 'model_missing');
    faults.observe('assistant', 'protocol');
    expect(
      faults
        .entries()
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.category),
    ).toEqual(['Ivy', 'Voice']);
    expect(
      faults
        .entries()
        .find((entry) => entry.message.includes('did not respond'))?.status,
    ).toBe('resolved');
    faults.observe('assistant', null);
    expect(faults.active()).toBe(true);
    expect(
      faults.entries().find((entry) => entry.category === 'Voice')?.status,
    ).toBe('active');
  });

  it('bounds history while retaining every unresolved category', () => {
    const faults = new DesktopFaults();
    for (const code of [
      'malformed_request',
      'unavailable',
      'timeout',
      'busy',
      'protocol',
      'uncertain',
      'storage',
      'approval_required',
      'turn_failed',
    ])
      faults.observe('assistant', code);
    faults.observe('voice', 'unavailable');
    faults.observe('artwork', 'unavailable');
    faults.observe('microphone', 'denied');
    faults.observe('desktop', 'unavailable');
    expect(faults.entries()).toHaveLength(8);
    expect(
      faults
        .entries()
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.category),
    ).toEqual(['Desktop', 'Microphone', 'Artwork', 'Voice', 'Ivy']);
  });

  it('never exposes unknown raw input, private keys, or inherited object properties', () => {
    const faults = new DesktopFaults();
    faults.observe('assistant', 'C:\\private\\secret-token and transcript');
    faults.observe('voice', '__proto__');
    const output = JSON.stringify(faults.entries());
    expect(output).not.toContain('secret');
    expect(output).not.toContain('transcript');
    expect(output).not.toContain('__proto__');
    expect(output).not.toContain('source');
    expect(output).not.toContain('code');
    expect(faults.entries().map((entry) => entry.message)).toEqual([
      'Voice reported an unexpected fault.',
      'Ivy reported an unexpected fault.',
    ]);
  });
});
