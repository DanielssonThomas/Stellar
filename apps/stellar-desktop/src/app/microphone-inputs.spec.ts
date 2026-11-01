import { describe, expect, it, vi } from 'vitest';
import { MicrophoneInputs } from './microphone-inputs';

describe('microphone choices', () => {
  it('enumerates only on request and rejects unknown choices', async () => {
    const listInputs = vi.fn(async () => [
      { deviceId: 'usb', label: 'USB microphone' },
    ]);
    const inputs = new MicrophoneInputs({ listInputs });
    expect(listInputs).not.toHaveBeenCalled();
    expect(inputs.selectedLabel()).toBe('System default microphone');
    await inputs.list();
    expect(inputs.select('missing')).toBe(false);
    expect(inputs.select('usb')).toBe(true);
    expect(inputs.selectedLabel()).toBe('USB microphone');
  });

  it('ignores obsolete enumeration after reselection or disposal', async () => {
    let finish: (
      value: readonly { deviceId: string; label: string }[],
    ) => void = () => undefined;
    const inputs = new MicrophoneInputs({
      listInputs: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const first = inputs.list();
    finish([{ deviceId: 'usb', label: 'USB' }]);
    await first;
    const second = inputs.list();
    inputs.select('usb');
    finish([]);
    await second;
    expect(inputs.items()).toHaveLength(1);
    expect(inputs.loading()).toBe(false);
    const third = inputs.list();
    inputs.dispose();
    finish([]);
    await third;
    expect(inputs.items()).toHaveLength(1);
    expect(inputs.select('')).toBe(false);
  });

  it('keeps an unavailable selected device explicit when a refresh removes it', async () => {
    const listInputs = vi
      .fn()
      .mockResolvedValueOnce([{ deviceId: 'usb', label: 'USB' }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Unavailable'));
    const inputs = new MicrophoneInputs({ listInputs });
    await inputs.list();
    inputs.select('usb');
    await inputs.list();
    expect(inputs.selectedId()).toBe('usb');
    expect(inputs.selectedLabel()).toBe('Selected microphone unavailable');
    expect(inputs.error()).toContain('No named inputs');
    await inputs.list();
    expect(inputs.error()).toContain('could not be listed');
    expect(inputs.loading()).toBe(false);
  });
});
