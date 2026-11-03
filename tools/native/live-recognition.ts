import { AudioActivityController } from '../../libs/services/audio-activity/src/lib/audio-activity-controller';
import { WebAudioSource } from '../../libs/services/audio-activity/src/lib/web-audio-source';
import { listAudioInputs } from '../../libs/services/audio-activity/src/lib/audio-inputs';

interface Trial {
  id: string;
  text: string;
  instruction: string;
}
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = element('status'),
  feedback = element('feedback'),
  prompt = element('prompt'),
  instruction = element('instruction');
const input = element<HTMLSelectElement>('input');
const enable = element<HTMLButtonElement>('enable'),
  record = element<HTMLButtonElement>('record');
const finish = element<HTMLButtonElement>('finish'),
  next = element<HTMLButtonElement>('next');
const progress = element('progress');
const session = (await fetch('/session').then((response) =>
  response.json(),
)) as { token: string; trials: Trial[]; completed: number[] };
let index = session.trials.findIndex(
  (_, at) => !session.completed.includes(at),
);
let phase: 'ready' | 'recording' | 'saving' | 'saved' | 'complete' =
  index < 0 ? 'complete' : 'ready';
let chunks: Int16Array[] = [],
  count = 0,
  interrupted = false,
  pcmAvailable = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence: number | undefined;
const controller = new AudioActivityController(() => render());
controller.bindLifecycle(document, window);
function render() {
  const state = controller.snapshot();
  status.textContent = state.activity.calibrating
    ? 'Calibrating — remain quiet for a moment.'
    : `${state.status}${phase === 'recording' ? ` · recording ${(count / 16000).toFixed(1)} seconds` : ''}`;
  record.disabled =
    phase !== 'ready' ||
    !pcmAvailable ||
    state.status !== 'capturing' ||
    state.activity.calibrating;
  finish.disabled = phase !== 'recording';
  next.disabled = phase !== 'saved';
  input.disabled =
    state.status === 'capturing' || state.status === 'requesting';
  enable.disabled = phase === 'complete' || phase === 'saving';
}
controller.subscribePcm((event) => {
  if (event.type !== 'chunk') {
    pcmAvailable = false;
    if (phase === 'recording') interrupted = true;
    if (event.type === 'unavailable') {
      feedback.textContent =
        'PCM capture unavailable. Stop the microphone and report this error.';
      void controller.stop('unavailable');
    }
    render();
    return;
  }
  pcmAvailable = true;
  try {
    if (phase !== 'recording') return;
    if (sequence !== undefined && event.chunk.sequence !== sequence + 1)
      interrupted = true;
    sequence = event.chunk.sequence;
    if (count + event.chunk.samples.length > 720000) {
      void complete();
      return;
    }
    chunks.push(event.chunk.samples.slice());
    count += event.chunk.samples.length;
  } finally {
    event.chunk.samples.fill(0);
    render();
  }
});
function display() {
  if (phase === 'complete') {
    void controller.stop();
    prompt.textContent = 'Calibration set saved. Return to Codex.';
    instruction.textContent =
      'The microphone is stopped. A fresh holdout set will be used after changes are frozen.';
  } else {
    const trial = session.trials[index];
    progress.textContent = `Calibration recording ${index + 1} of ${session.trials.length}`;
    prompt.textContent = trial.text;
    instruction.textContent = trial.instruction;
  }
  render();
}
function erase() {
  chunks.forEach((chunk) => chunk.fill(0));
  chunks = [];
  count = 0;
  sequence = undefined;
}
function wav() {
  const bytes = new ArrayBuffer(44 + count * 2),
    view = new DataView(bytes);
  const text = (at: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, count * 2, true);
  let at = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      view.setInt16(at, sample, true);
      at += 2;
    }
  return bytes;
}
async function complete() {
  if (phase !== 'recording') return;
  phase = 'saving';
  clearTimeout(timer);
  feedback.textContent = 'Saving…';
  render();
  try {
    if (interrupted || count < 3200)
      throw new Error(
        'Capture was interrupted or too short. Enable if needed, then record this item again.',
      );
    const response = await fetch(`/trial/${index}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Qualification-Token': session.token,
      },
      body: wav(),
    });
    if (!response.ok)
      throw new Error(
        `Save failed (${response.status}). Refresh to resume from the first unsaved item.`,
      );
    phase = index === session.trials.length - 1 ? 'complete' : 'saved';
    feedback.textContent =
      phase === 'complete'
        ? 'All recordings saved privately on this computer.'
        : 'Saved privately on this computer. Press Next item.';
    if (phase === 'complete') display();
  } catch (error) {
    phase = 'ready';
    feedback.textContent =
      error instanceof Error ? error.message : 'Recording failed.';
  } finally {
    erase();
    render();
  }
}
async function list() {
  const selected = input.value,
    devices = await listAudioInputs();
  input.replaceChildren(new Option('System default microphone', ''));
  for (const device of devices)
    input.add(new Option(device.label, device.deviceId));
  input.value = selected;
}
enable.onclick = () => {
  void controller.start(new WebAudioSource(), input.value || undefined);
};
element('stop').onclick = () => {
  if (phase === 'recording') {
    phase = 'ready';
    feedback.textContent = 'Recording discarded. Saved items are retained.';
  }
  clearTimeout(timer);
  erase();
  void controller.stop();
};
element('refresh').onclick = () => {
  void list().catch(() => {
    feedback.textContent = 'Input names unavailable.';
  });
};
record.onclick = () => {
  if (phase !== 'ready') return;
  erase();
  interrupted = false;
  phase = 'recording';
  feedback.textContent =
    'Speak naturally, leave one second of quiet, then Save.';
  render();
  timer = setTimeout(() => {
    void complete();
  }, 45000);
};
finish.onclick = () => {
  void complete();
};
next.onclick = () => {
  if (phase !== 'saved') return;
  phase = ++index >= session.trials.length ? 'complete' : 'ready';
  feedback.textContent = '';
  display();
};
window.addEventListener('pagehide', () => {
  erase();
  void controller.dispose();
});
if (session.completed.length)
  feedback.textContent = `Resumed after ${session.completed.length} saved recordings.`;
display();
void list();
