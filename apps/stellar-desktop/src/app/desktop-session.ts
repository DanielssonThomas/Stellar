import {
  createInteractionController,
  initialState,
  type InteractionClock,
  type InteractionEffect,
  type InteractionEvent,
  type InteractionState,
} from '@stellar/desktop-interaction';
import type { AudioActivityState } from '@stellar/service-audio-activity';
import type { StageCommand, ProductionPayloadMap } from '@stellar/ui-organisms';
type WithoutSequence<T> = T extends unknown
  ? Omit<T, 'contractVersion' | 'commandId'>
  : never;
type PendingCommand = WithoutSequence<StageCommand<ProductionPayloadMap>>;

export interface DesktopSessionOptions {
  readonly automaticSummary?: boolean;
  readonly clock: InteractionClock;
  readonly now: () => number;
  readonly audio: { startMicrophone(): Promise<void>; stop(): Promise<void> };
  readonly onState: (state: InteractionState) => void;
  readonly onCommand: (command: StageCommand<ProductionPayloadMap>) => void;
}

export class DesktopSession {
  private commandId = 0;
  private captureId: number | null = null;
  private manualStart: number | null = null;
  private manualDuration = 0;
  private audioState: AudioActivityState | null = null;
  private readonly controller;

  constructor(private readonly options: DesktopSessionOptions) {
    this.controller = createInteractionController({
      state: { ...initialState, automaticSummary: options.automaticSummary },
      clock: options.clock,
      onChange: (state) => {
        if (state.phase === 'presenting' && state.surface)
          this.summary('update', state.surface.id);
        options.onState(state);
      },
      onEffect: (effect) => this.apply(effect),
    });
  }

  get state() {
    return this.controller.getState();
  }

  dispatch(event: InteractionEvent) {
    if (event.type === 'manual-start' && !this.state.manualActive) {
      if (['idle', 'presenting', 'returning'].includes(this.state.phase))
        this.manualDuration = 0;
      this.manualStart = this.options.now();
    }
    if (event.type === 'manual-end' && this.manualStart !== null) {
      this.manualDuration += Math.max(0, this.options.now() - this.manualStart);
      this.manualStart = null;
    }
    if (['dismiss', 'hidden', 'minimized', 'shutdown'].includes(event.type)) {
      this.manualStart = null;
      this.manualDuration = 0;
    }
    this.controller.dispatch(event);
  }

  updateAudio(audio: AudioActivityState) {
    this.audioState = audio;
    const requestId = this.captureId;
    if (requestId === null) return;
    if (audio.status === 'requesting') return;
    if (audio.status === 'capturing') {
      this.dispatch({ type: 'capture-result', requestId, result: 'started' });
      this.dispatch({
        type: 'audio-activity',
        requestId,
        active: audio.activity.active,
      });
      return;
    }
    const type =
      audio.status === 'denied'
        ? 'microphone-denied'
        : audio.status === 'missing' || audio.status === 'unavailable'
          ? 'microphone-missing'
          : audio.status === 'disconnected'
            ? 'microphone-disconnected'
            : audio.status === 'muted'
              ? 'microphone-muted'
              : 'microphone-stopped';
    this.dispatch({ type, requestId });
  }

  stopMicrophone() {
    const requestId = this.captureId;
    if (requestId !== null)
      this.dispatch({ type: 'microphone-muted', requestId });
  }

  showSummary() {
    const surface = this.state.surface;
    if (surface)
      this.command({ action: 'focus', instanceId: `activity-${surface.id}` });
  }

  dispose() {
    this.controller.dispose();
  }

  private apply(effect: InteractionEffect) {
    switch (effect.type) {
      case 'start-capture':
        this.captureId = effect.requestId;
        void this.options.audio.startMicrophone().catch(() => {
          this.dispatch({
            type: 'microphone-missing',
            requestId: effect.requestId,
          });
        });
        break;
      case 'stop-capture':
        if (this.captureId === effect.requestId) this.captureId = null;
        void this.options.audio.stop();
        break;
      case 'open-surface': {
        this.summary('open', effect.id);
        break;
      }
      case 'close-surface':
        this.command({ action: 'close', instanceId: `activity-${effect.id}` });
        break;
    }
  }

  private summary(action: 'open' | 'update', id: number) {
    const audio = this.audioState?.activity;
    const microphone = this.captureId !== null;
    const data = {
      instanceId: `activity-${id}`,
      surface: 'activity-summary' as const,
      payload: {
        durationMs: Math.min(
          86400000,
          Math.round(
            microphone ? (audio?.durationMs ?? 0) : this.manualDuration,
          ),
        ),
        peakLevel: microphone ? (audio?.peakLevel ?? 0) : 0,
        inputLabel: microphone ? 'Microphone activity' : 'Manual activity',
      },
    };
    this.command(
      action === 'open'
        ? { ...data, action, prominence: 'primary' }
        : { ...data, action },
    );
  }

  private command(command: PendingCommand) {
    this.options.onCommand({
      ...command,
      contractVersion: 1,
      commandId: ++this.commandId,
    });
  }
}
