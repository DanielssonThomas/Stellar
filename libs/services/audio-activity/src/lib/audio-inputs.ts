export interface AudioInputDevice {
  readonly deviceId: string;
  readonly label: string;
}

export async function listAudioInputs(
  devices: Pick<MediaDevices, 'enumerateDevices'> | undefined = globalThis
    .navigator?.mediaDevices,
): Promise<readonly AudioInputDevice[]> {
  if (!devices?.enumerateDevices)
    throw new Error('Audio input enumeration unavailable');
  const listed = await devices.enumerateDevices();
  const inputs = new Map<string, AudioInputDevice>();
  for (const device of listed) {
    if (
      device.kind !== 'audioinput' ||
      !device.deviceId ||
      inputs.has(device.deviceId)
    )
      continue;
    inputs.set(
      device.deviceId,
      Object.freeze({
        deviceId: device.deviceId,
        label:
          device.label.trim() ||
          `Microphone ${inputs.size + 1} (name unavailable)`,
      }),
    );
  }
  return Object.freeze([...inputs.values()]);
}
