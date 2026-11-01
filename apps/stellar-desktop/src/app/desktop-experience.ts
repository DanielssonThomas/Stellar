import { HttpClient } from '@angular/common/http';
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
import type { EmblemManifest } from '@stellar/ui-molecules';
import type { StageResult } from '@stellar/ui-organisms';
import { DesktopSession } from './desktop-session';

@Injectable()
export class DesktopExperience {
  readonly audio = inject(AudioActivityService);
  readonly state = signal(initialState);
  readonly manifest = signal<EmblemManifest | null>(null);
  readonly loading = signal(true);
  readonly assetError = signal<string | null>(null);
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  );
  private stage: ((command: unknown) => StageResult) | undefined;
  readonly session = new DesktopSession({
    audio: this.audio,
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
    if (audio.status === 'denied')
      return 'Microphone permission denied. You can still start activity manually.';
    if (['missing', 'unavailable', 'disconnected'].includes(audio.status))
      return 'Microphone unavailable. You can still start activity manually.';
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
    const subscription = inject(HttpClient)
      .get<EmblemManifest>('emblem/manifest.json')
      .subscribe({
        next: (manifest) => {
          this.manifest.set(manifest);
          this.loading.set(false);
        },
        error: () => {
          this.assetError.set('Artwork could not be loaded.');
          this.loading.set(false);
        },
      });
    effect(() => this.session.updateAudio(this.audio.state()));
    const visibility = () =>
      this.session.dispatch({
        type: this.document.hidden ? 'hidden' : 'resume',
      });
    const pagehide = () => this.session.dispatch({ type: 'hidden' });
    const preference = () =>
      this.session.dispatch({
        type: 'reduced-motion',
        enabled: this.media?.matches ?? false,
      });
    preference();
    this.document.addEventListener('visibilitychange', visibility);
    this.document.defaultView?.addEventListener('pagehide', pagehide);
    this.media?.addEventListener('change', preference);
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.document.removeEventListener('visibilitychange', visibility);
      this.document.defaultView?.removeEventListener('pagehide', pagehide);
      this.media?.removeEventListener('change', preference);
      this.session.dispose();
      this.stage = undefined;
    });
  }

  connect(stage: (command: unknown) => StageResult) {
    this.stage = stage;
  }

  dispatch(event: InteractionEvent) {
    this.session.dispatch(
      event.type === 'reduced-motion'
        ? { ...event, enabled: event.enabled || (this.media?.matches ?? false) }
        : event,
    );
  }
}
