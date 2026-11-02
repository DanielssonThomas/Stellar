import {
  createUtteranceAssembler,
  type AudioActivityState,
  type PcmEvent,
} from '@stellar/service-audio-activity';
import type {
  IvySnapshot,
  SpeechSnapshot,
  SpeechTranscript,
} from '@stellar/desktop-contracts';
import {
  fitsVoicePrompt,
  voiceCommand,
  type VoiceComposition,
  type VoiceModel,
} from './voice-composition';

export interface VoiceContext {
  readonly audio: AudioActivityState;
  readonly assistant: IvySnapshot;
  readonly speech: SpeechSnapshot;
  readonly available: boolean;
}

export interface VoiceView {
  readonly status: string;
  readonly muted: boolean;
  readonly error: boolean;
  readonly busy: boolean;
}

export interface VoicePorts {
  readonly transcribe: (
    pcm: Int16Array,
    id: string,
  ) => Promise<SpeechTranscript>;
  readonly submit: (text: string, id: string) => Promise<boolean>;
  readonly speak: (text: string, id: string) => Promise<SpeechSnapshot>;
  readonly stop: () => Promise<unknown>;
  readonly id: () => string;
  readonly onChange: (view: VoiceView) => void;
  readonly selectSession?: (model: VoiceModel) => Promise<boolean>;
  readonly clearConversation?: () => Promise<boolean>;
  readonly readSession?: () => Promise<VoiceModel>;
  readonly refinePrompt?: (raw: string, signal: AbortSignal) => Promise<string>;
  readonly onComposition?: (state: VoiceComposition) => void;
}

export class VoiceConversation {
  private readonly assembler = createUtteranceAssembler();
  private context?: VoiceContext;
  private generation = 0;
  private phase: 'transcribing' | 'waiting' | 'speaking' | null = null;
  private voiceTurn: string | null = null;
  private settledTurn: string | null = null;
  private playbackAcknowledged = false;
  private playbackRevision = 0n;
  private awaitingQuiet = false;
  private muted = false;
  private blocked = false;
  private failure = '';
  private disposed = false;
  private stopping = false;
  private unconfirmedStop = false;
  private composition: VoiceComposition = {
    raw: '',
    lastSubmittedRaw: '',
    model: 'terra',
    status: 'idle',
    error: '',
  };
  private refinement?: AbortController;
  private dispatchUncertain = false;
  private routeUncertain = false;
  private sessionPending = false;

  constructor(private readonly ports: VoicePorts) {}

  update(context: VoiceContext) {
    if (this.disposed) return;
    const hadCapture = this.context?.audio.status === 'capturing';
    this.context = context;
    if (
      !context.available ||
      (hadCapture && context.audio.status !== 'capturing')
    ) {
      this.invalidate();
    } else if (
      this.phase === 'speaking' &&
      this.playbackAcknowledged &&
      context.speech.state === 'idle' &&
      BigInt(context.speech.revision) >= this.playbackRevision
    ) {
      this.phase = null;
      this.awaitingQuiet = true;
      this.assembler.reset();
    } else if (
      this.phase === 'speaking' &&
      context.speech.state === 'unavailable'
    ) {
      this.fail('Local voice unavailable. Retry voice or use the text reply.');
    }
    this.consumeReply();
    this.publish();
  }

  accept(event: PcmEvent) {
    if (this.disposed) return;
    if (event.type === 'reset') {
      this.invalidate();
      this.blocked = false;
      this.failure = '';
      this.publish();
      return;
    }
    if (event.type === 'unavailable') {
      this.invalidate();
      this.fail(
        'Speech capture unavailable. Restart the microphone or use text.',
      );
      return;
    }
    if (event.type === 'chunk') {
      try {
        const context = this.context;
        if (this.awaitingQuiet) {
          this.assembler.reset();
          if (
            !this.stopping &&
            !this.unconfirmedStop &&
            context &&
            context.speech.state === 'idle' &&
            !context.audio.activity.active &&
            !context.audio.activity.calibrating
          )
            this.awaitingQuiet = false;
          return;
        }
        if (!context || !this.canCollect(context)) {
          this.assembler.reset();
          return;
        }
        const pcm = this.assembler.push(event.chunk, context.audio.activity);
        if (pcm) void this.transcribe(pcm);
      } finally {
        event.chunk.samples.fill(0);
      }
    }
  }

  setMuted(muted: boolean) {
    if (this.disposed) return;
    this.muted = muted;
    if (muted && this.phase === 'speaking') this.invalidate();
    this.publish();
  }

  stopVoice() {
    if (this.disposed) return;
    this.invalidate();
    this.publish();
  }

  retry() {
    if (this.disposed) return;
    this.invalidate();
    this.blocked = false;
    this.failure = '';
    this.publish();
  }

  dispose() {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    this.composition = {
      raw: '',
      lastSubmittedRaw: '',
      model: 'terra',
      status: 'idle',
      error: '',
    };
  }

  setModel(model: VoiceModel) {
    if (
      !this.disposed &&
      !this.sessionPending &&
      this.composition.status !== 'finalizing'
    )
      this.setComposition({ ...this.composition, model });
  }

  setDraft(raw: string) {
    if (
      this.disposed ||
      this.sessionPending ||
      this.composition.status === 'finalizing'
    )
      return;
    if (raw !== this.composition.raw) this.dispatchUncertain = false;
    this.setComposition({
      ...this.composition,
      raw,
      status: fitsVoicePrompt(raw) ? 'composing' : 'error',
      error: fitsVoicePrompt(raw)
        ? ''
        : 'Prompt exceeds the 8 KiB limit. Edit it before sending.',
    });
  }

  initializeSession(model: VoiceModel) {
    if (
      !this.disposed &&
      !this.sessionPending &&
      this.composition.status !== 'finalizing'
    )
      this.setComposition({ ...this.composition, model });
  }

  async resetConversation(): Promise<boolean> {
    if (this.disposed || this.sessionPending || this.phase !== null)
      return false;
    return this.clearConversation(this.generation);
  }

  private setComposition(state: VoiceComposition) {
    this.composition = Object.freeze(state);
    this.ports.onComposition?.(this.composition);
  }

  private compositionError(error: string) {
    this.phase = null;
    this.voiceTurn = null;
    this.setComposition({ ...this.composition, status: 'error', error });
    this.publish();
  }

  reconcileSession(model: VoiceModel): boolean {
    if (
      this.disposed ||
      this.sessionPending ||
      this.composition.status === 'finalizing'
    )
      return false;
    this.routeUncertain = false;
    this.setComposition({
      ...this.composition,
      model,
    });
    this.publish();
    return true;
  }

  private async mutateSession(
    operation: () => Promise<boolean>,
    generation: number,
  ): Promise<boolean> {
    this.sessionPending = true;
    let accepted = false;
    try {
      accepted = await operation();
    } catch {
      /* A lost response may follow a mutation. */
    }
    if (!this.current(generation) || !accepted) {
      this.routeUncertain = true;
      let model: VoiceModel | undefined;
      try {
        model = await this.ports.readSession?.();
      } catch {
        /* Require explicit reconciliation. */
      }
      if (!this.disposed) {
        if (model === 'terra' || model === 'sol') this.routeUncertain = false;
        this.setComposition({
          ...this.composition,
          ...(model ? { model } : {}),
          status: 'error',
          error: this.routeUncertain
            ? 'Conversation state is uncertain. Refresh it before sending.'
            : 'Conversation state refreshed after interruption. Your text is retained.',
        });
      }
    }
    this.sessionPending = false;
    if (!this.disposed) this.publish();
    return accepted;
  }

  private async recognize(text: string, id: string, generation: number) {
    const command = voiceCommand(text);
    if (command === 'prompt') {
      this.phase = null;
      this.setComposition({
        ...this.composition,
        model: 'sol',
        status: 'composing',
        error: '',
      });
      this.publish();
      return;
    }
    if (command === 'clear' || command === 'done') {
      await this.clearConversation(generation);
      return;
    }
    if (command === 'end prompt') {
      if (this.composition.status === 'idle' || !this.composition.raw.trim()) {
        this.phase = null;
        this.publish();
        return;
      }
      await this.finalize(id, generation);
      return;
    }
    if (this.composition.status !== 'idle') {
      const raw = this.composition.raw
        ? `${this.composition.raw}\n${text}`
        : text;
      this.phase = null;
      this.setComposition({
        ...this.composition,
        raw,
        status: fitsVoicePrompt(raw) ? 'composing' : 'error',
        error: fitsVoicePrompt(raw)
          ? ''
          : 'Prompt exceeds the 8 KiB limit. Clear it before sending.',
      });
      this.publish();
      return;
    }
    const model = this.composition.model;
    this.setComposition({
      ...this.composition,
      raw: text,
      status: 'finalizing',
      error: '',
    });
    try {
      if (!this.current(generation)) return;
      if (this.routeUncertain) throw new Error();
      const selectSession = this.ports.selectSession;
      if (model === 'sol' && !selectSession) throw new Error();
      if (
        selectSession &&
        !(await this.mutateSession(() => selectSession(model), generation))
      )
        throw new Error();
      if (!this.current(generation)) return;
      await this.dispatchDraft(text, text.trim(), model, id, generation);
    } catch {
      if (this.current(generation))
        this.compositionError(
          'Could not select the conversation. Your text is retained.',
        );
    }
  }

  private async clearConversation(generation: number): Promise<boolean> {
    if (!this.ports.clearConversation) {
      this.compositionError('Conversation could not be cleared.');
      return false;
    }
    const cleared = await this.mutateSession(
      this.ports.clearConversation,
      generation,
    );
    if (!this.current(generation)) return false;
    if (!cleared) {
      this.compositionError('Conversation could not be cleared.');
      return false;
    }
    this.dispatchUncertain = false;
    this.routeUncertain = false;
    this.phase = null;
    this.setComposition({
      raw: '',
      lastSubmittedRaw: '',
      model: 'terra',
      status: 'idle',
      error: '',
    });
    this.publish();
    return true;
  }

  private async finalize(id: string, generation: number) {
    const { raw, model } = this.composition;
    if (this.routeUncertain) {
      this.compositionError(
        'Conversation state is uncertain. Refresh it before sending.',
      );
      return;
    }
    if (this.dispatchUncertain) {
      this.compositionError(
        'The previous send may have completed. Check Ivy before editing or clearing this prompt.',
      );
      return;
    }
    if (!fitsVoicePrompt(raw)) {
      this.compositionError(
        'Prompt exceeds the 8 KiB limit. Clear it before sending.',
      );
      return;
    }
    this.setComposition({
      ...this.composition,
      status: 'finalizing',
      error: '',
    });
    try {
      if (!this.current(generation)) return;
      const selectSession = this.ports.selectSession;
      if (model === 'sol' && !selectSession) throw new Error();
      if (
        selectSession &&
        !(await this.mutateSession(() => selectSession(model), generation))
      )
        throw new Error();
      if (!this.current(generation)) return;
      const controller = new AbortController();
      this.refinement = controller;
      const text = this.ports.refinePrompt
        ? await this.ports.refinePrompt(raw, controller.signal)
        : raw;
      if (!this.current(generation)) return;
      this.refinement = undefined;
      if (!text.trim() || !fitsVoicePrompt(text)) throw new Error();
      await this.dispatchDraft(raw, text, model, id, generation);
    } catch {
      if (this.current(generation))
        this.compositionError(
          this.dispatchUncertain
            ? 'The previous send may have completed. Check Ivy before editing or clearing this prompt.'
            : 'Prompt could not be prepared. Your text is retained.',
        );
    }
  }

  private async dispatchDraft(
    raw: string,
    text: string,
    model: VoiceModel,
    id: string,
    generation: number,
  ) {
    this.dispatchUncertain = true;
    let accepted = false;
    try {
      accepted = await this.submit(text, id, generation);
    } catch {
      // A failed transport may still have delivered the turn.
    }
    if (!this.current(generation)) return;
    if (!accepted && this.settledTurn !== id) {
      this.compositionError(
        'The previous send may have completed. Check Ivy before editing or clearing this prompt.',
      );
      return;
    }
    this.dispatchUncertain = false;
    this.setComposition({
      raw: '',
      lastSubmittedRaw: raw,
      model,
      status: 'idle',
      error: '',
    });
  }

  private async submit(
    text: string,
    id: string,
    generation: number,
  ): Promise<boolean> {
    this.settledTurn = null;
    this.voiceTurn = id;
    this.phase = 'waiting';
    this.publish();
    if (!this.current(generation)) return false;
    const accepted = await this.ports.submit(text, id);
    if (
      this.current(generation) &&
      !accepted &&
      this.phase === 'waiting' &&
      this.voiceTurn === id
    ) {
      this.voiceTurn = null;
      this.phase = null;
      this.failure =
        'Message was not sent. Check Ivy in the menu; it will not be resent.';
      this.publish();
    }
    return accepted;
  }

  private canCollect(context: VoiceContext): boolean {
    return (
      context.available &&
      context.audio.status === 'capturing' &&
      !this.phase &&
      !this.stopping &&
      !this.sessionPending &&
      !this.routeUncertain &&
      !this.unconfirmedStop &&
      !this.blocked &&
      context.assistant.connection === 'ready' &&
      !['submitting', 'admitted', 'uncertain'].includes(
        context.assistant.turn,
      ) &&
      !['transcribing', 'synthesizing', 'speaking'].includes(
        context.speech.state,
      )
    );
  }

  private async transcribe(pcm: Int16Array) {
    const generation = ++this.generation;
    const id = this.ports.id();
    this.phase = 'transcribing';
    this.failure = '';
    this.assembler.reset();
    this.publish();
    try {
      const transcript = await this.ports.transcribe(pcm, id);
      if (!this.current(generation)) return;
      const text = transcript.text;
      if (transcript.utterance_id !== id) throw new Error();
      if (!text.trim()) {
        this.phase = null;
        this.publish();
        return;
      }
      await this.recognize(text, id, generation);
    } catch {
      if (this.current(generation))
        this.fail('Local recognition unavailable. Retry voice or use text.');
    } finally {
      pcm.fill(0);
    }
  }

  private consumeReply() {
    const context = this.context;
    if (!context || this.phase !== 'waiting' || !this.voiceTurn) return;
    const snapshot = context.assistant;
    if (snapshot.turn_id !== this.voiceTurn) return;
    if (
      ['uncertain', 'failed', 'cancelled', 'completed'].includes(snapshot.turn)
    )
      this.settledTurn = snapshot.turn === 'uncertain' ? null : this.voiceTurn;
    if (['uncertain', 'failed', 'cancelled'].includes(snapshot.turn)) {
      this.voiceTurn = null;
      this.phase = null;
      this.failure =
        snapshot.turn === 'uncertain'
          ? 'Ivy response is uncertain. Check response; voice will not resend.'
          : 'Ivy did not complete the voice request. See the menu.';
      return;
    }
    if (snapshot.turn !== 'completed') return;
    const id = this.voiceTurn;
    this.voiceTurn = null;
    this.phase = null;
    const text = snapshot.items
      .flatMap((item) => (item.kind === 'text' ? [item.text] : []))
      .join('\n\n')
      .trim();
    if (
      !text ||
      this.muted ||
      !context.available ||
      context.audio.status !== 'capturing'
    )
      return;
    if (new TextEncoder().encode(text).length > 4000) {
      this.failure =
        'Reply is available as text; it exceeds the local voice limit.';
      return;
    }
    const generation = this.generation;
    this.phase = 'speaking';
    this.playbackAcknowledged = false;
    this.assembler.reset();
    void this.ports
      .speak(text, id)
      .then((snapshot) => {
        if (!this.current(generation)) return;
        if (snapshot.state === 'unavailable') {
          this.fail(
            'Local voice unavailable. Retry voice or use the text reply.',
          );
          return;
        }
        this.playbackAcknowledged = true;
        this.playbackRevision = BigInt(snapshot.revision);
        const observed = this.context?.speech;
        if (
          snapshot.state === 'idle' ||
          (observed?.state === 'idle' &&
            BigInt(observed.revision) >= this.playbackRevision)
        ) {
          this.phase = null;
          this.awaitingQuiet = true;
          this.assembler.reset();
          this.publish();
        }
      })
      .catch(() => {
        if (this.current(generation))
          this.fail(
            'Local voice unavailable. Retry voice or use the text reply.',
          );
      });
  }

  private invalidate() {
    if (this.phase === 'speaking') this.awaitingQuiet = true;
    const active =
      this.unconfirmedStop ||
      this.phase !== null ||
      (this.context &&
        ['transcribing', 'synthesizing', 'speaking'].includes(
          this.context.speech.state,
        ));
    ++this.generation;
    this.refinement?.abort();
    this.refinement = undefined;
    if (this.composition.status === 'finalizing')
      this.setComposition({
        ...this.composition,
        status: 'error',
        error: this.dispatchUncertain
          ? 'The previous send may have completed. Check Ivy before editing or clearing this prompt.'
          : 'Prompt preparation interrupted. Your text is retained.',
      });
    this.phase = null;
    this.voiceTurn = null;
    this.playbackAcknowledged = false;
    this.assembler.reset();
    if (active && !this.stopping) {
      this.unconfirmedStop = true;
      this.stopping = true;
      void this.ports
        .stop()
        .then(() => {
          this.unconfirmedStop = false;
          this.awaitingQuiet = true;
        })
        .catch(() => {
          this.blocked = true;
          this.failure =
            'Local speech could not stop. Retry voice before resuming.';
        })
        .finally(() => {
          this.stopping = false;
          if (!this.disposed) this.publish();
        });
    }
  }

  private fail(message: string) {
    this.invalidate();
    this.blocked = true;
    this.failure = message;
    this.publish();
  }

  private current(generation: number) {
    return !this.disposed && generation === this.generation;
  }

  private publish() {
    const context = this.context;
    this.ports.onChange({
      muted: this.muted,
      error: !!this.failure || this.routeUncertain,
      busy:
        this.stopping ||
        this.unconfirmedStop ||
        this.phase === 'transcribing' ||
        this.phase === 'speaking',
      status:
        this.failure ||
        (this.routeUncertain
          ? 'Conversation state is uncertain. Refresh it in the menu before voice resumes.'
          : '') ||
        (this.phase === 'transcribing'
          ? 'Recognizing locally'
          : this.phase === 'waiting'
            ? 'Waiting for Ivy'
            : this.phase === 'speaking'
              ? 'Speaking locally'
              : context?.audio.status === 'capturing'
                ? 'Local voice listening'
                : 'Local voice idle'),
    });
  }
}
