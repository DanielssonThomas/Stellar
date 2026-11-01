import { describe, expect, it, vi } from 'vitest';
import { listAudioInputs } from './audio-inputs';

const device = (
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = 'audioinput',
) => ({
  deviceId,
  label,
  kind,
  groupId: '',
  toJSON: () => ({}),
});

describe('audio input enumeration', () => {
  it('lists only selectable microphones, preserves IDs and labels, and handles unlabeled devices', async () => {
    const enumerateDevices = vi.fn(async () => [
      device('default', 'System mic'),
      device('usb', ''),
      device('usb', 'Duplicate'),
      device('screen', 'Camera', 'videoinput'),
      device('', ''),
    ]);
    const result = await listAudioInputs({ enumerateDevices });
    expect(result).toEqual([
      { deviceId: 'default', label: 'System mic' },
      { deviceId: 'usb', label: 'Microphone 2 (name unavailable)' },
    ]);
    expect(enumerateDevices).toHaveBeenCalledOnce();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it('distinguishes an empty list from unsupported and rejected enumeration', async () => {
    await expect(
      listAudioInputs({ enumerateDevices: async () => [] }),
    ).resolves.toEqual([]);
    await expect(
      listAudioInputs({} as Pick<MediaDevices, 'enumerateDevices'>),
    ).rejects.toThrow('unavailable');
    await expect(
      listAudioInputs({
        enumerateDevices: async () => {
          throw new Error('Denied');
        },
      }),
    ).rejects.toThrow('Denied');
  });
});
