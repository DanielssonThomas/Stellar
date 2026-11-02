import {
  DestroyRef,
  computed,
  effect,
  inject,
  Injectable,
  NgZone,
  signal,
} from '@angular/core';
import { AudioActivityService } from '@stellar/service-audio-activity';
import {
  SpeechAdapterService,
  PromptCleanupService,
  IvyAdapterService,
  VoiceConversation,
  type VoiceComposition,
  type VoiceModel,
  type VoiceView,
} from '@stellar/service-desktop-adapter';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopExperience } from './desktop-experience';

@Injectable()
export class DesktopVoice {
  private readonly audio = inject(AudioActivityService);
  private readonly speech = inject(SpeechAdapterService);
  private readonly cleanup = inject(PromptCleanupService);
  private readonly ivy = inject(IvyAdapterService);
  private readonly assistant = inject(DesktopAssistant);
  private readonly experience = inject(DesktopExperience);
  private readonly zone = inject(NgZone);
  private readonly current = signal<VoiceView>({
    status: 'Local voice idle',
    muted: false,
    error: false,
    busy: false,
  });
  private readonly sessionError = signal(false);
  readonly state = computed(() =>
    this.sessionError()
      ? {
          ...this.current(),
          error: true,
          status:
            'Conversation state unavailable. Refresh before voice resumes.',
        }
      : this.current(),
  );
  private readonly compositionState = signal<VoiceComposition>({
    raw: '',
    lastSubmittedRaw: '',
    model: 'terra',
    status: 'idle',
    error: '',
  });
  readonly composition = this.compositionState.asReadonly();
  private modelChanged = false;
  private modelRevision = 0;
  private sessionRequest = 0;
  private readonly sessionKnown = signal(false);
  private foregroundCleared?: () => void;
  readonly waiting = computed(
    () =>
      !['suspended', 'shutdown'].includes(this.experience.state().phase) &&
      ['transcribing', 'synthesizing'].includes(this.speech.state().state),
  );
  readonly narrating = computed(
    () =>
      !['suspended', 'shutdown'].includes(this.experience.state().phase) &&
      this.speech.state().state === 'speaking',
  );
  private readonly conversation = new VoiceConversation({
    transcribe: (pcm, id) => this.speech.transcribe(pcm, id),
    refinePrompt: async (raw, signal) =>
      (await this.cleanup.refine(raw, signal)).text,
    submit: (text, id) => this.assistant.submit(text, id),
    speak: (text, id) => this.speech.speak(text, id),
    stop: () => this.speech.stop(),
    selectSession: (model) => this.ivy.selectSession(model),
    clearConversation: async () => {
      const cleared = await this.ivy.clearConversation();
      if (cleared) {
        try {
          this.foregroundCleared?.();
        } catch {
          /* The native reset already succeeded. */
        }
      }
      return cleared;
    },
    readSession: () => this.readSession(),
    id: () => crypto.randomUUID(),
    onChange: (view) => this.zone.run(() => this.current.set(view)),
    onCapturePauseChange: (paused) =>
      this.experience.setVoiceCapturePaused(paused),
    waitForCapturePause: () => this.experience.waitForVoiceCaptureRelease(),
    onComposition: (value) =>
      this.zone.run(() => {
        this.compositionState.set(value);
      }),
  });

  constructor() {
    const request = ++this.sessionRequest;
    void this.readSession()
      .then((model) => {
        if (request !== this.sessionRequest) return;
        if (!this.modelChanged) this.conversation.initializeSession(model);
        this.sessionKnown.set(true);
      })
      .catch(() => {
        if (request === this.sessionRequest) this.sessionError.set(true);
      });
    const unsubscribe = this.audio.subscribePcm((event) =>
      this.conversation.accept(event),
    );
    effect(() =>
      this.conversation.update({
        audio: this.audio.state(),
        speech: this.speech.state(),
        assistant: this.assistant.state(),
        available:
          this.sessionKnown() &&
          !this.sessionError() &&
          !['suspended', 'shutdown'].includes(this.experience.state().phase),
      }),
    );
    inject(DestroyRef).onDestroy(() => {
      unsubscribe();
      this.sessionRequest++;
      this.conversation.dispose();
      this.foregroundCleared = undefined;
    });
  }

  setMuted(muted: boolean) {
    this.conversation.setMuted(muted);
  }
  stop() {
    this.conversation.stopVoice();
  }
  retry() {
    this.conversation.retry();
    if (!this.sessionKnown() || this.sessionError()) void this.refreshSession();
  }

  bindForegroundClear(callback: () => void) {
    this.foregroundCleared = callback;
  }

  setModel(model: VoiceModel) {
    this.modelChanged = true;
    this.modelRevision++;
    this.conversation.setModel(model);
  }

  setDraft(raw: string) {
    this.conversation.setDraft(raw);
  }

  resetConversation() {
    this.modelChanged = true;
    this.modelRevision++;
    if (!this.sessionKnown() || this.sessionError())
      return Promise.resolve(false);
    return this.conversation.resetConversation();
  }

  async refreshSession(): Promise<boolean> {
    const revision = this.modelRevision;
    const request = ++this.sessionRequest;
    try {
      const model = await this.readSession();
      if (request !== this.sessionRequest || revision !== this.modelRevision)
        return false;
      if (!this.conversation.reconcileSession(model)) return false;
      this.sessionKnown.set(true);
      this.sessionError.set(false);
      return true;
    } catch {
      if (request === this.sessionRequest) this.sessionError.set(true);
      return false;
    }
  }

  private async readSession(): Promise<VoiceModel> {
    const snapshot = await this.ivy.snapshot();
    if (
      snapshot.error ||
      ['submitting', 'admitted', 'uncertain'].includes(snapshot.turn)
    )
      throw new Error('Conversation state is not settled');
    return snapshot.model;
  }
}
