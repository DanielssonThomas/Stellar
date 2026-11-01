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
}

export class VoiceConversation {
  private readonly assembler = createUtteranceAssembler();
  private context?: VoiceContext;
  private generation = 0;
  private phase: 'transcribing' | 'waiting' | 'speaking' | null = null;
  private voiceTurn: string | null = null;
  private playbackAcknowledged = false;
  private playbackRevision = 0n;
  private awaitingQuiet = false;
  private muted = false;
  private blocked = false;
  private failure = '';
  private disposed = false;
  private stopping = false;
  private unconfirmedStop = false;

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
  }

  private canCollect(context: VoiceContext): boolean {
    return (
      context.available &&
      context.audio.status === 'capturing' &&
      !this.phase &&
      !this.stopping &&
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
      const text = transcript.text.trim();
      if (transcript.utterance_id !== id) throw new Error();
      if (!text) {
        this.phase = null;
        this.publish();
        return;
      }
      this.voiceTurn = id;
      this.phase = 'waiting';
      this.publish();
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
      error: !!this.failure,
      busy:
        this.stopping ||
        this.unconfirmedStop ||
        this.phase === 'transcribing' ||
        this.phase === 'speaking',
      status:
        this.failure ||
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
