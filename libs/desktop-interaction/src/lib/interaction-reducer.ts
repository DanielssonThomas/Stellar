import { initialState, motionDurations } from './interaction-model';
import type {
  EmblemTarget,
  InteractionEffect,
  InteractionEvent,
  InteractionResult,
  InteractionState,
  MicrophoneStatus,
} from './interaction-model';

export { initialState };

const MAX_ID = Number.MAX_SAFE_INTEGER;
const active = (s: InteractionState): boolean =>
  s.manualActive || s.audioActive;

export function reduceInteraction(
  state: InteractionState,
  event: InteractionEvent,
): InteractionResult {
  let s = state;
  const effects: InteractionEffect[] = [];
  const update = (patch: Partial<InteractionState>): void => {
    s = { ...s, ...patch };
  };
  const allocate = (): number | null => {
    if (s.generation >= MAX_ID) return null;
    const id = s.generation + 1;
    update({ generation: id });
    return id;
  };
  const cancelMotion = (): void => {
    if (s.motion === null) return;
    effects.push({ type: 'cancel-animation', generation: s.motion.generation });
    update({ motion: null });
  };
  const cancelHangover = (): void => {
    if (s.hangover === null) return;
    effects.push({ type: 'cancel-hangover', generation: s.hangover });
    update({ hangover: null });
  };
  const closeSurface = (): void => {
    if (s.surface === null) return;
    effects.push({ type: 'close-surface', id: s.surface.id });
    update({ surface: null });
  };
  const stopCapture = (status: MicrophoneStatus = 'stopped'): void => {
    if (s.microphone.requestId !== null) {
      effects.push({ type: 'stop-capture', requestId: s.microphone.requestId });
    }
    update({ microphone: { status, requestId: null }, audioActive: false });
  };
  const present = (): void => {
    if (s.surface === null) {
      const id = allocate();
      if (id !== null) {
        update({ surface: { id } });
        effects.push({ type: 'open-surface', id });
      }
    }
    update({ phase: 'presenting', target: 'docked', motion: null });
  };
  const arrive = (target: EmblemTarget): void => {
    update({ motion: null, target });
    switch (target) {
      case 'center':
        update({ phase: 'idle' });
        return;
      case 'docked':
        present();
        return;
      case 'focused':
        update({ phase: 'listening' });
        if (!active(s)) quiet();
        return;
      default:
        return unreachable(target);
    }
  };
  const move = (target: EmblemTarget): void => {
    cancelMotion();
    cancelHangover();
    update({
      target,
      phase:
        target === 'focused'
          ? 'focusing'
          : target === 'docked'
            ? 'docking'
            : 'returning',
    });
    const id = s.reducedMotion ? null : allocate();
    if (id === null) {
      arrive(target);
      return;
    }
    update({ motion: { generation: id, target } });
    effects.push({
      type: 'animate',
      generation: id,
      target,
      durationMs:
        target === 'focused'
          ? motionDurations.focus
          : target === 'docked'
            ? motionDurations.dock
            : motionDurations.return,
    });
  };
  const quiet = (): void => {
    if (s.phase === 'focusing') return;
    if (
      active(s) ||
      s.phase === 'hangover' ||
      s.phase === 'docking' ||
      s.phase === 'presenting' ||
      s.phase === 'idle' ||
      s.phase === 'returning'
    )
      return;
    cancelMotion();
    const id = allocate();
    if (id === null) {
      move('docked');
      return;
    }
    update({ phase: 'hangover', hangover: id, target: 'focused' });
    const delayMs = Number.isFinite(s.hangoverMs)
      ? Math.max(0, s.hangoverMs)
      : 900;
    effects.push({ type: 'schedule-hangover', generation: id, delayMs });
  };
  const reconcile = (): void => {
    if (!active(s)) {
      quiet();
      return;
    }
    cancelHangover();
    if (s.phase === 'focusing' || s.phase === 'listening') return;
    if (s.target === 'focused' && s.motion === null)
      update({ phase: 'listening' });
    else move('focused');
  };
  const reset = (phase: 'suspended' | 'shutdown'): void => {
    cancelMotion();
    cancelHangover();
    closeSurface();
    stopCapture();
    update({
      phase,
      target: 'center',
      manualActive: false,
      audioActive: false,
    });
  };
  const matchesCapture = (id: number): boolean =>
    s.microphone.requestId !== null && s.microphone.requestId === id;
  const failMicrophone = (id: number, status: MicrophoneStatus): void => {
    if (!matchesCapture(id)) return;
    stopCapture(status);
    if (s.manualActive) {
      reconcile();
      return;
    }
    cancelHangover();
    cancelMotion();
    closeSurface();
    update({ phase: 'idle', target: 'center' });
  };

  if (s.phase === 'shutdown') return { state: s, effects };
  if (s.phase === 'suspended') {
    switch (event.type) {
      case 'resume':
        update({ phase: 'idle' });
        break;
      case 'shutdown':
        reset('shutdown');
        break;
      case 'reduced-motion':
        update({ reducedMotion: event.enabled });
        break;
      default:
        break;
    }
    return { state: s, effects };
  }

  switch (event.type) {
    case 'manual-start':
      if (!s.manualActive) {
        update({ manualActive: true });
        reconcile();
      }
      break;
    case 'manual-end':
      if (s.manualActive) {
        update({ manualActive: false });
        reconcile();
      }
      break;
    case 'audio-activity':
      if (
        matchesCapture(event.requestId) &&
        s.microphone.status === 'capturing' &&
        s.audioActive !== event.active
      ) {
        update({ audioActive: event.active });
        reconcile();
      }
      break;
    case 'capture-request': {
      if (s.microphone.requestId !== null) break;
      const requestId = allocate();
      if (requestId === null) break;
      update({ microphone: { status: 'requesting', requestId } });
      effects.push({ type: 'start-capture', requestId });
      break;
    }
    case 'capture-result':
      if (
        !matchesCapture(event.requestId) ||
        s.microphone.status !== 'requesting'
      )
        break;
      if (event.result === 'started')
        update({
          microphone: { status: 'capturing', requestId: event.requestId },
        });
      else failMicrophone(event.requestId, event.result);
      break;
    case 'microphone-denied':
      failMicrophone(event.requestId, 'denied');
      break;
    case 'microphone-missing':
      failMicrophone(event.requestId, 'missing');
      break;
    case 'microphone-disconnected':
      failMicrophone(event.requestId, 'disconnected');
      break;
    case 'microphone-muted':
      failMicrophone(event.requestId, 'muted');
      break;
    case 'microphone-stopped':
      failMicrophone(event.requestId, 'stopped');
      break;
    case 'motion-complete':
      if (s.motion?.generation === event.generation) arrive(s.motion.target);
      break;
    case 'hangover-timeout':
      if (s.hangover !== null && s.hangover === event.generation) {
        update({ hangover: null });
        if (!active(s)) move('docked');
      }
      break;
    case 'dismiss':
      cancelHangover();
      closeSurface();
      stopCapture();
      update({ manualActive: false, audioActive: false });
      if (s.phase !== 'idle' && s.phase !== 'returning') move('center');
      break;
    case 'hidden':
    case 'minimized':
      reset('suspended');
      break;
    case 'resume':
      break;
    case 'shutdown':
      reset('shutdown');
      break;
    case 'reduced-motion':
      if (s.reducedMotion === event.enabled) break;
      update({ reducedMotion: event.enabled });
      if (event.enabled && s.motion !== null) {
        const target = s.motion.target;
        cancelMotion();
        arrive(target);
      }
      break;
    default:
      unreachable(event);
  }
  return { state: s, effects };
}

function unreachable(value: never): never {
  throw new Error(`Unexpected interaction value: ${String(value)}`);
}
