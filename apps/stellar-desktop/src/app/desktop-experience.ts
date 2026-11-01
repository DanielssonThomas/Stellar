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
  private readonly capturePaused = signal(false);
  readonly state = signal(initialState);
  readonly manifest = signal(decodeEmblemManifest(emblemManifest));
  readonly loading = signal(false);
  readonly assetError = signal<string | null>(null);
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  );
  private stage: ((command: unknown) => StageResult) | undefined;
  readonly session = new DesktopSession({
    automaticSummary: false,
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
    onCommand: (command) => this.stage?.(command),
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
    if (audio.status === 'requesting')
      return 'Waiting for microphone permission';
    if (this.capturePaused())
      return 'Microphone paused when the window lost focus. Enable microphone to resume.';
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
    effect(() => this.session.updateAudio(this.audio.state()));
    const visibility = () =>
      this.session.dispatch({
        type: this.document.hidden ? 'hidden' : 'resume',
      });
    const pagehide = () => this.session.dispatch({ type: 'hidden' });
    const blur = () => {
      if (this.state().microphone.requestId !== null)
        this.capturePaused.set(true);
      this.session.dispatch({ type: 'minimized' });
    };
    const focus = () => this.session.dispatch({ type: 'resume' });
    const preference = () =>
      this.session.dispatch({
        type: 'reduced-motion',
        enabled: this.media?.matches ?? false,
      });
    preference();
    this.document.addEventListener('visibilitychange', visibility);
    this.document.defaultView?.addEventListener('pagehide', pagehide);
    this.document.defaultView?.addEventListener('blur', blur);
    this.document.defaultView?.addEventListener('focus', focus);
    this.media?.addEventListener('change', preference);
    inject(DestroyRef).onDestroy(() => {
      this.inputs.dispose();
      this.document.removeEventListener('visibilitychange', visibility);
      this.document.defaultView?.removeEventListener('pagehide', pagehide);
      this.document.defaultView?.removeEventListener('blur', blur);
      this.document.defaultView?.removeEventListener('focus', focus);
      this.media?.removeEventListener('change', preference);
      this.session.dispose();
      this.stage = undefined;
    });
  }

  connect(stage: (command: unknown) => StageResult) {
    this.stage = stage;
  }

  present(command: unknown): StageResult {
    if (!this.stage || ['suspended', 'shutdown'].includes(this.state().phase))
      return { status: 'rejected', reason: 'Desktop is not available' };
    return this.stage(command);
  }

  dispatch(event: InteractionEvent) {
    if (
      event.type === 'capture-request' ||
      event.type === 'manual-start' ||
      event.type === 'dismiss'
    )
      this.capturePaused.set(false);
    this.session.dispatch(
      event.type === 'reduced-motion'
        ? { ...event, enabled: event.enabled || (this.media?.matches ?? false) }
        : event,
    );
  }

  selectInput(deviceId: string) {
    if (!this.inputs.select(deviceId)) return;
    const enabled = this.state().microphone.requestId !== null;
    this.session.stopMicrophone();
    if (enabled) this.dispatch({ type: 'capture-request' });
  }
}
