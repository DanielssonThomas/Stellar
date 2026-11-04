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
  IvyReflexService,
  VoiceConversation,
  QuestionVoiceCue,
  type VoiceComposition,
  type PromptPresentation,
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
  private readonly reflex = inject(IvyReflexService);
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
  private playbackGeneration = 0;
  private disposed = false;
  private readonly questionCue = new QuestionVoiceCue({
    enabled: () => !this.current().muted && !this.current().error,
    state: () => this.speech.state(),
    speak: (text, id) => this.speech.speak(text, id),
    stop: () => this.speech.stop(),
  });
  private narration?: { id: string; revision: bigint; epoch: string };
  readonly sessionUnavailable = computed(() => this.sessionError());
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
    refined: null,
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
  private foregroundCleared?: (reason: 'clear' | 'new_session') => void;
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
    keywords: this.speech.keywordsAvailable
      ? (pcm, stream, sequence, threshold, mode) =>
          this.speech.keywords(pcm, stream, sequence, threshold, mode)
      : undefined,
    transcribe: (pcm, id) => this.speech.transcribe(pcm, id),
    collect: (pcm, id) => this.speech.collect(pcm, id),
    refinePrompt: async (raw, signal) =>
      (await this.cleanup.refine(raw, signal)).text,
    submit: (text, id) => this.assistant.submit(text, id, 'voice'),
    reflex: (text, id, signal, point) =>
      this.reflex.run(text, id, signal, point),
    cancelReflex: () => this.reflex.cancel(),
    speak: async (text, id) => {
      const generation = this.playbackGeneration;
      await this.questionCue.wait();
      if (
        generation !== this.playbackGeneration ||
        this.disposed ||
        this.current().muted
      )
        return this.speech.state();
      const before = this.speech.state();
      this.narration = {
        id,
        revision: BigInt(before.revision),
        epoch: before.epoch,
      };
      this.reflex.timeline.speech(id, 'synthesis');
      return this.speech
        .speak(text, id)
        .then((snapshot) => {
          if (this.narration?.id === id) {
            const observed = this.speech.state();
            if (snapshot.state === 'unavailable')
              this.finishNarration('failed');
            else if (
              snapshot.state === 'idle' ||
              (observed.state === 'idle' &&
                BigInt(observed.revision) >= BigInt(snapshot.revision))
            )
              this.finishNarration('completed');
            else if (snapshot.state === 'speaking')
              this.reflex.timeline.speech(id, 'playing');
          }
          return snapshot;
        })
        .catch((error) => {
          if (this.narration?.id === id) this.finishNarration('failed');
          throw error;
        });
    },
    stop: () => {
      this.playbackGeneration++;
      this.questionCue.dispose();
      this.finishNarration('cancelled');
      return this.speech.stop();
    },
    onForegroundEnd: () => this.foregroundCleared?.('clear'),
    selectSession: (model) => this.ivy.selectSession(model),
    clearConversation: async () => {
      const cleared = await this.ivy.clearConversation();
      if (cleared) {
        try {
          this.foregroundCleared?.('clear');
        } catch {
          /* The native reset already succeeded. */
        }
      }
      return cleared;
    },
    newSession: () => this.ivy.newSession(),
    onNewSession: () => this.foregroundCleared?.('new_session'),
    reloadMcp: () => this.ivy.reloadMcp(),
    readSession: () => this.readSession(),
    id: () => crypto.randomUUID(),
    onChange: (view) =>
      this.zone.run(() => {
        this.current.set(view);
        this.experience.setPassiveListening(view.passive ?? false);
      }),
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
      this.conversation.accept(event, this.audio.state()),
    );
    effect(() => this.updateContext());
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.playbackGeneration++;
      unsubscribe();
      this.sessionRequest++;
      this.conversation.dispose();
      this.questionCue.cancel();
      this.foregroundCleared = undefined;
    });
  }

  setMuted(muted: boolean) {
    if (muted) this.playbackGeneration++;
    this.conversation.setMuted(muted);
    if (muted) {
      this.questionCue.cancel();
    }
  }

  notifyQuestion(promptId: string) {
    this.questionCue.notify(promptId);
  }

  async startListening(): Promise<void> {
    try {
      await this.speech.initialize();
      this.experience.startListening();
    } catch {
      // An unavailable local speech boundary cannot admit voice interactions.
    }
  }

  submitText(text: string): Promise<boolean> {
    return this.conversation.withCaptureReleased(async (signal) => {
      const inputId = crypto.randomUUID();
      try {
        if (
          this.composition().status === 'idle' &&
          this.composition().model === 'terra'
        ) {
          const local = await this.reflex.run(text, inputId, signal);
          if (signal.aborted) return false;
          if (local.handled) return local.outcome !== 'cancelled';
        }
        this.reflex.reply.set('');
        return await this.assistant.submit(text, inputId);
      } finally {
        this.updateContext();
      }
    });
  }

  private updateContext() {
    const speech = this.speech.state();
    this.questionCue.observe(speech);
    const narration = this.narration;
    if (narration && BigInt(speech.revision) > narration.revision) {
      if (speech.epoch !== narration.epoch) this.finishNarration('cancelled');
      else if (speech.state === 'idle') this.finishNarration('completed');
      else if (speech.state === 'unavailable') this.finishNarration('failed');
      else if (
        speech.operation_id === narration.id &&
        speech.state === 'speaking'
      )
        this.reflex.timeline.speech(narration.id, 'playing');
    }
    this.conversation.update({
      audio: this.audio.state(),
      speech: this.speech.state(),
      assistant: this.assistant.state(),
      localAvailable: this.reflex.localAvailable(),
      available:
        this.sessionKnown() &&
        !this.sessionError() &&
        !['suspended', 'shutdown'].includes(this.experience.state().phase),
    });
  }
  private finishNarration(stage: 'completed' | 'failed' | 'cancelled') {
    if (!this.narration) return;
    this.reflex.timeline.speech(this.narration.id, stage);
    this.narration = undefined;
  }
  stop() {
    this.playbackGeneration++;
    this.questionCue.cancel();
    this.conversation.stopVoice();
  }
  async retry(): Promise<void> {
    this.conversation.retry();
    if (!this.sessionKnown() || this.sessionError())
      await this.refreshSession();
  }

  bindPromptPresentation(callback: PromptPresentation): () => void {
    return this.conversation.bindPromptPresentation(callback);
  }

  bindForegroundClear(callback: (reason: 'clear' | 'new_session') => void) {
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
      (snapshot.error &&
        !(this.reflex.localAvailable() && snapshot.error === 'unavailable')) ||
      ['submitting', 'admitted', 'uncertain'].includes(snapshot.turn)
    )
      throw new Error('Conversation state is not settled');
    return snapshot.model;
  }
}
