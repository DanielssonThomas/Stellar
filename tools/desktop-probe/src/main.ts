import { nativeAdapter, describeError, decodeError } from './adapter.js';
import { MicrophoneProbe } from './microphone.js';

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing probe element ${id}`);
  return value as T;
};
const output = element<HTMLPreElement>('contract-results');
const button = element<HTMLButtonElement>('roundtrip');
const inputs = element<HTMLSelectElement>('input');
let devices: MediaDeviceInfo[] = [];
const microphone = new MicrophoneProbe((snapshot) => {
  const { status, rms, peak, dbfs } = snapshot;
  element('microphone-status').textContent = `Microphone: ${status}`;
  element<HTMLMeterElement>('level').value = dbfs ?? -100;
  element('activity').textContent =
    `${dbfs === null ? '−∞' : dbfs.toFixed(1)} dBFS · RMS ${rms.toFixed(6)} · peak ${peak.toFixed(6)} · ${rms >= 0.035 ? 'sound active' : 'below activity threshold'}`;
  element('microphone-details').textContent = [
    `Input: ${snapshot.input}`,
    `Track: ${snapshot.track} · muted: ${snapshot.muted ?? '—'}`,
    `Audio context: ${snapshot.context} · clock: ${snapshot.contextTime?.toFixed(2) ?? '—'} s · ${snapshot.sampleRate ?? '—'} Hz`,
    `Analyser polls: ${snapshot.frames} (polling alone does not prove audio processing)`,
  ].join('\n');
  const active = ['requesting', 'running', 'suspended'].includes(status);
  element<HTMLButtonElement>('start').disabled = active;
  inputs.disabled = active;
  element<HTMLButtonElement>('resume').disabled =
    snapshot.context !== 'suspended';
});
element('start').addEventListener(
  'click',
  () => void microphone.start(devices[Number(inputs.value)]?.deviceId),
);
element('stop').addEventListener('click', () => void microphone.stop());
element('resume').addEventListener('click', () => void microphone.resume());
element('list-inputs').addEventListener('click', () => void listInputs());
async function listInputs(): Promise<void> {
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'audioinput',
    );
    inputs.replaceChildren(new Option('System default', '-1'));
    devices.forEach((device, index) =>
      inputs.add(
        new Option(
          device.label || `Input ${index + 1} (label hidden until permitted)`,
          String(index),
        ),
      ),
    );
    element('input-status').textContent =
      `${devices.length} inputs listed. Stop capture before changing input; press Start to use the selection.`;
  } catch {
    element('input-status').textContent =
      'Input list unavailable. Check microphone permission and Windows input settings.';
  }
}
window.addEventListener('pagehide', () => void microphone.stop(), {
  once: true,
});
element('environment').textContent = JSON.stringify(
  {
    origin: location.origin,
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    mediaDevices: Boolean(navigator.mediaDevices),
    audioContext: typeof AudioContext,
  },
  null,
  2,
);

async function checkContracts(): Promise<void> {
  button.disabled = true;
  output.textContent = 'Checking native command and event…';
  const started = performance.now();
  let unlisten: (() => void) | undefined;
  try {
    const native = nativeAdapter();
    const events: string[] = [];
    unlisten = await native.listen((event) =>
      events.push(event.reply.sequence),
    );
    const reply = await native.roundTrip({
      version: 1,
      sequence: '18446744073709551615',
      state: { kind: 'active', rms: 0.04 },
    });
    if (
      reply.sequence !== '18446744073709551615' ||
      'device_label' in reply ||
      !reply.sound_active
    )
      throw new Error('Round-trip mismatch');
    const optional = await native.roundTrip({
      version: 1,
      sequence: '2',
      device_label: 'Probe fixture',
      state: { kind: 'idle' },
    });
    if (optional.device_label !== 'Probe fixture')
      throw new Error('Optional field mismatch');
    let typedError = '';
    try {
      await native.roundTrip({
        version: 2,
        sequence: '0',
        state: { kind: 'idle' },
      });
    } catch (error) {
      typedError = describeError(decodeError(error));
    }
    if (typedError !== 'Unsupported version 2')
      throw new Error('Typed error mismatch');
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!events.includes(reply.sequence) || !events.includes('2'))
      throw new Error('Native event not received');
    const report = {
      passed: true,
      maximumU64: reply.sequence,
      optional: optional.device_label,
      typedError,
      eventCount: events.length,
      elapsedMs: Math.round(performance.now() - started),
    };
    output.textContent = JSON.stringify(report, null, 2);
    element('native-status').textContent =
      'Native IPC, generated contracts and event checks passed.';
    document.documentElement.dataset['contractStatus'] = 'passed';
  } catch (error) {
    output.textContent =
      error instanceof Error ? error.message : JSON.stringify(error);
    element('native-status').textContent = 'Native contract check failed.';
    document.documentElement.dataset['contractStatus'] = 'failed';
  } finally {
    unlisten?.();
    button.disabled = false;
  }
}
button.addEventListener('click', () => void checkContracts());
void checkContracts();
