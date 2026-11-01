export type Phase =
  | 'idle'
  | 'focusing'
  | 'listening'
  | 'hangover'
  | 'docking'
  | 'presenting'
  | 'returning'
  | 'suspended'
  | 'shutdown';
export type EmblemTarget = 'center' | 'focused' | 'docked';
export type MicrophoneStatus =
  | 'stopped'
  | 'requesting'
  | 'capturing'
  | 'denied'
  | 'missing'
  | 'disconnected'
  | 'muted';
export type Motion = Readonly<{ generation: number; target: EmblemTarget }>;
export type Microphone = Readonly<{
  status: MicrophoneStatus;
  requestId: number | null;
}>;
export type InteractionState = Readonly<{
  phase: Phase;
  target: EmblemTarget;
  microphone: Microphone;
  manualActive: boolean;
  audioActive: boolean;
  surface: Readonly<{ id: number }> | null;
  motion: Motion | null;
  hangover: number | null;
  generation: number;
  reducedMotion: boolean;
  hangoverMs: number;
}>;
export type InteractionEvent =
  | Readonly<{
      type:
        | 'manual-start'
        | 'manual-end'
        | 'dismiss'
        | 'hidden'
        | 'minimized'
        | 'resume'
        | 'shutdown'
        | 'capture-request';
    }>
  | Readonly<{ type: 'audio-activity'; requestId: number; active: boolean }>
  | Readonly<{
      type: 'capture-result';
      requestId: number;
      result: 'started' | 'denied' | 'missing';
    }>
  | Readonly<{
      type:
        | 'microphone-denied'
        | 'microphone-missing'
        | 'microphone-disconnected'
        | 'microphone-muted'
        | 'microphone-stopped';
      requestId: number;
    }>
  | Readonly<{
      type: 'motion-complete' | 'hangover-timeout';
      generation: number;
    }>
  | Readonly<{ type: 'reduced-motion'; enabled: boolean }>;
export type InteractionEffect =
  | Readonly<{
      type: 'animate';
      generation: number;
      target: EmblemTarget;
      durationMs: number;
    }>
  | Readonly<{ type: 'cancel-animation'; generation: number }>
  | Readonly<{ type: 'schedule-hangover'; generation: number; delayMs: number }>
  | Readonly<{ type: 'cancel-hangover'; generation: number }>
  | Readonly<{ type: 'open-surface' | 'close-surface'; id: number }>
  | Readonly<{ type: 'start-capture' | 'stop-capture'; requestId: number }>;
export type InteractionResult = Readonly<{
  state: InteractionState;
  effects: readonly InteractionEffect[];
}>;
export const motionDurations = Object.freeze({
  focus: 220,
  dock: 320,
  return: 260,
});
export const initialState: InteractionState = Object.freeze({
  phase: 'idle',
  target: 'center',
  microphone: Object.freeze({ status: 'stopped', requestId: null }),
  manualActive: false,
  audioActive: false,
  surface: null,
  motion: null,
  hangover: null,
  generation: 0,
  reducedMotion: false,
  hangoverMs: 900,
});
