import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopFaults } from './desktop-faults';

describe('desktop fault history', () => {
  afterEach(() => vi.useRealTimers());

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
