import emblemManifest from '../../public/emblem/manifest.json';
import {
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import {
  initialState,
  type InteractionEvent,
} from '@stellar/desktop-interaction';
import { AudioActivityService } from '@stellar/service-audio-activity';
import { decodeEmblemManifest } from '@stellar/ui-molecules';
import type { StageResult } from '@stellar/ui-organisms';
import { DesktopSession } from './desktop-session';
import { MicrophoneInputs } from './microphone-inputs';

@Injectable()
export class DesktopExperience {
  readonly audio = inject(AudioActivityService);
  readonly inputs = new MicrophoneInputs(this.audio);
  readonly activityStatus = computed(() => {
    const activity = this.audio.state().activity;
    return activity.calibrating
      ? 'Calibrating'
      : activity.active
        ? 'Activity detected'
        : 'Quiet';
  });
  readonly state = signal(initialState);
  readonly manifest = signal(decodeEmblemManifest(emblemManifest));
  readonly loading = signal(false);
  readonly assetError = signal<string | null>(null);
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  );
  private stage: ((command: unknown) => StageResult) | undefined;
  private commandSequence: (() => number | null) | undefined;
  readonly session = new DesktopSession({
    automaticSummary: false,
    voiceDriven: true,
    audio: {
      startMicrophone: () =>
        this.audio.startMicrophone(this.inputs.selectedId() || undefined),
      stop: () => this.audio.stop(),
    },
    now: () => performance.now(),
    clock: {
      schedule: (callback, delayMs) => {
        const id = setTimeout(callback, delayMs);
        return () => clearTimeout(id);
      },
    },
    onState: (state) => this.state.set(state),
    onCommand: (command) => {
      const commandId =
        this.commandSequence?.() ??
        (this.commandSequence ? null : command.commandId);
      if (commandId !== null) this.stage?.({ ...command, commandId });
    },
  });
  readonly statusText = computed(() => {
    const audio = this.audio.state();
    const state = this.state();
    if (this.assetError())
      return 'Artwork unavailable. Activity controls remain available.';
    if (state.microphone.status === 'denied')
      return 'Microphone permission denied. You can still start activity manually.';
    if (['missing', 'disconnected'].includes(state.microphone.status))
      return 'Microphone unavailable. You can still start activity manually.';
    if (audio.status === 'turn-paused')
      return 'Microphone paused during voice turn';
    if (audio.status === 'requesting')
      return 'Waiting for microphone permission';
    if (audio.status === 'capturing' && audio.activity.calibrating)
      return 'Calibrating microphone';
    if (state.phase === 'presenting') return 'Activity ready';
    if (state.phase === 'listening')
      return state.manualActive ? 'Manual activity' : 'Listening';
    if (state.phase === 'hangover') return 'Waiting for quiet';
    if (state.phase === 'suspended') return 'Paused';
    return audio.status === 'capturing' ? 'Microphone on' : 'Ready';
  });

  constructor() {
    this.audio.setContinuousCapture(true);
    effect(() => {
      this.session.updateAudio(this.audio.state());
    });
    const visibility = () => {
      if (!this.document.hidden) this.session.dispatch({ type: 'resume' });
    };
    const pagehide = () => this.session.dispatch({ type: 'shutdown' });
    const focus = () => this.session.dispatch({ type: 'resume' });
    const preference = () =>
      this.session.dispatch({
        type: 'reduced-motion',
        enabled: this.media?.matches ?? false,
      });
    preference();
    this.document.addEventListener('visibilitychange', visibility);
    this.document.defaultView?.addEventListener('pagehide', pagehide);
    this.document.defaultView?.addEventListener('focus', focus);
    this.media?.addEventListener('change', preference);
    inject(DestroyRef).onDestroy(() => {
      this.inputs.dispose();
      this.document.removeEventListener('visibilitychange', visibility);
      this.document.defaultView?.removeEventListener('pagehide', pagehide);
      this.document.defaultView?.removeEventListener('focus', focus);
      this.media?.removeEventListener('change', preference);
      this.session.dispose();
      this.stage = undefined;
      this.commandSequence = undefined;
    });
  }

  connect(
    stage: (command: unknown) => StageResult,
    commandSequence?: () => number | null,
  ) {
    this.stage = stage;
    this.commandSequence = commandSequence;
  }

  present(command: unknown): StageResult {
    if (!this.stage || ['suspended', 'shutdown'].includes(this.state().phase))
      return { status: 'rejected', reason: 'Desktop is not available' };
    return this.stage(command);
  }

  dispatch(event: InteractionEvent) {
    this.session.dispatch(
      event.type === 'reduced-motion'
        ? { ...event, enabled: event.enabled || (this.media?.matches ?? false) }
        : event,
    );
  }

  startListening() {
    this.dispatch({ type: 'capture-request' });
  }

  selectInput(deviceId: string) {
    if (!this.inputs.select(deviceId)) return;
    const enabled = this.state().microphone.requestId !== null;
    this.session.stopMicrophone();
    if (enabled) this.dispatch({ type: 'capture-request' });
  }
}
