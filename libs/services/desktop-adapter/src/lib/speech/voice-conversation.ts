import {
  createUtteranceAssembler,
  validPcmChunk,
  type AudioActivityState,
  type PcmEvent,
  type PcmChunk,
} from '@stellar/service-audio-activity';
import type {
  IvySnapshot,
  SpeechSnapshot,
  SpeechTranscript,
  KeywordDetection,
} from '@stellar/desktop-contracts';
import {
  fitsVoicePrompt,
  voiceCommand,
  type VoiceComposition,
  type VoiceModel,
} from './voice-composition';
import {
  awaitPromptPresentation,
  type PromptPresentation,
} from './prompt-presentation';
import { DraftRecognition } from './draft-recognition';
import { FastCommands, type KeywordPort } from './fast-commands';
import {
  VoiceInvocation,
  cancelsPrompt,
  promptInvocation,
} from './voice-invocation';
import { VoiceLatency } from './voice-latency';
import { spokenResponse } from './spoken-response';
import { SpeechActivity } from './speech-activity';
import { SpeechPlaybackQueue } from './speech-playback-queue';
import { responseSpeech } from './response-speech';
import { PassiveRecognition } from './passive-recognition';
import type {
  RecognitionObservation,
  WakeSensitivity,
} from './voice-preferences';
import type { ReflexOutcome } from '../reflex/reflex-controller';

const preparing = (status: VoiceComposition['status']) =>
  ['refining', 'finalizing', 'submitting'].includes(status);

export interface VoiceContext {
  readonly audio: AudioActivityState;
  readonly assistant: IvySnapshot;
  readonly speech: SpeechSnapshot;
  readonly available: boolean;
  readonly localAvailable?: boolean;
}

interface PassiveWakeTicket {
  id: string;
  generation: number;
  epoch: string;
  resetId: string | null;
  workspaceEpoch: string;
  model: VoiceModel;
}

export interface VoiceView {
  readonly ducking?: boolean;
  readonly duckingListening?: boolean;
  readonly inputText?: string;
  readonly foregroundActive?: boolean;
  readonly passive?: boolean;
  readonly notice?: string;
  readonly status: string;
  readonly muted: boolean;
  readonly error: boolean;
  readonly busy: boolean;
}

export interface VoicePorts {
  readonly keywords?: KeywordPort;
  readonly silenceMs?: number;
  readonly onForegroundEnd?: () => void;
  readonly newSession?: () => Promise<boolean>;
  readonly reloadMcp?: () => Promise<boolean>;
  readonly onNewSession?: () => void;
  readonly transcribe: (
    pcm: Int16Array,
    id: string,
  ) => Promise<SpeechTranscript>;
  readonly collect?: (pcm: Int16Array, id: string) => Promise<SpeechTranscript>;
  readonly submit: (text: string, id: string) => Promise<boolean>;
  readonly reflex?: (
    text: string,
    id: string,
    signal: AbortSignal,
    point: (
      stage:
        | 'inference_start'
        | 'inference_complete'
        | 'action_dispatch'
        | 'action_complete',
    ) => void,
  ) => Promise<ReflexOutcome>;
  readonly cancelReflex?: () => void;
  readonly speak: (
    text: string,
    id: string,
    current?: () => boolean,
  ) => Promise<SpeechSnapshot>;
  readonly stop: () => Promise<unknown>;
  readonly id: () => string;
  readonly onChange: (view: VoiceView) => void;
  readonly onCapturePauseChange?: (paused: boolean) => void;
  readonly waitForCapturePause?: () => Promise<void>;
  readonly selectSession?: (model: VoiceModel) => Promise<boolean>;
  readonly clearConversation?: () => Promise<boolean>;
  readonly readSession?: () => Promise<VoiceModel>;
  readonly refinePrompt?: (raw: string, signal: AbortSignal) => Promise<string>;
  readonly presentFinalized?: PromptPresentation;
  readonly onComposition?: (state: VoiceComposition) => void;
  readonly onRecognition?: (observation: RecognitionObservation) => void;
}

export class VoiceConversation {
  private readonly assembler;
  private readonly fastCommands?: FastCommands;
  private readonly speechActivity?: SpeechActivity;
  private pendingControl?: KeywordDetection;
  private suppressControls = false;
  private lastVoicedSequence: number | null = null;
  private pcmSequence: number | null = null;
  private speechResourcesUsed = false;
  private get awaitingWake() {
    return !this.promptOpen && !this.invocation.active();
  }
  private set awaitingWake(value: boolean) {
    if (value) this.invocation.reset();
    else this.invocation.activate();
  }
  private inputText = '';
  private readonly invocation = new VoiceInvocation();
  private promptOpen = false;
  private solSessionStarted = false;
  private readonly latency = new VoiceLatency();
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
    refined: null,
    lastSubmittedRaw: '',
    model: 'terra',
    status: 'idle',
    error: '',
  };
  private refinement?: AbortController;
  private presentation?: { handler: PromptPresentation };
  private activePresentation?: { binding: { handler: PromptPresentation } };
  private capturePaused = false;
  private dispatchUncertain = false;
  private dispatchPending = false;
  private routeUncertain = false;
  private sessionPending = false;
  private controlNotice = '';
  private newSessionRequested = false;
  private lastResetId: string | null = null;
  private readonly draftRecognition?: DraftRecognition;
  private previewSamples = 0;
  private draftSequence: number | null = null;
  private draftCapped = false;
  private readonly draftCleanups = new Set<AbortController>();
  private draftCleanupPromise?: Promise<void>;
  private draftRevision = 0;
  private typedLease?: AbortController;
  private readonly playback: SpeechPlaybackQueue;
  private responseSequence = -1n;
  private responseFinalSeen = false;
  private responseTexts: string[] = [];
  private responsePending = 0;
  private responseTerminal = false;
  private responseHadSpeech = false;
  private responseSuppressed = false;
  private responseSource: 'voice' | 'typed' = 'voice';
  private responseContext?: { model: VoiceModel; workspace: string };
  private wakeSensitivity: WakeSensitivity = 'standard';
  private showRecognition = false;
  private readonly passiveRecognition?: PassiveRecognition;
  private passiveTicket?: PassiveWakeTicket;
  private pendingFallback?: PassiveWakeTicket;

  constructor(private readonly ports: VoicePorts) {
    const collect = ports.collect;
    if (collect)
      this.passiveRecognition = new PassiveRecognition({
        collect: (pcm, id) => {
          const context = this.context;
          if (!context) return Promise.reject(new Error('No capture context'));
          this.passiveTicket = {
            id,
            generation: this.generation,
            epoch: context.speech.epoch,
            resetId: context.assistant.reset_id,
            workspaceEpoch: context.assistant.workspace_epoch,
            model: context.assistant.model,
          };
          this.speechResourcesUsed = true;
          return collect(pcm, id);
        },
        id: ports.id,
        completed: (text, id) => {
          void this.acceptPassiveTranscript(text, id);
        },
      });
    this.playback = new SpeechPlaybackQueue({
      state: () =>
        this.context?.speech ?? {
          version: 1,
          revision: '0',
          epoch: '0',
          operation_id: null,
          state: 'idle',
          error: null,
        },
      speak: ports.speak,
      stop: ports.stop,
      acknowledged: (snapshot) => {
        if (
          this.phase === 'speaking' &&
          snapshot.operation_id === this.settledTurn
        ) {
          this.playbackAcknowledged = true;
          this.playbackRevision = BigInt(snapshot.revision);
        }
      },
    });
    this.assembler = createUtteranceAssembler({
      silenceMs: ports.silenceMs ?? (ports.keywords ? 800 : 1400),
    });
    if (ports.keywords) {
      this.speechActivity = new SpeechActivity();
      this.awaitingWake = true;
      this.fastCommands = new FastCommands(
        ports.keywords,
        ports.id,
        (detection, tail, sequence) => {
          if (detection.command === 'ivy')
            void this.acceptFastCommand(detection, tail);
          else if (
            !this.suppressControls &&
            !this.pendingControl &&
            (this.lastVoicedSequence === null ||
              this.lastVoicedSequence <= sequence)
          ) {
            if ((this.speechActivity?.quietMs() ?? 0) >= 1000)
              void this.acceptFastCommand(detection, []);
            else this.pendingControl = detection;
          }
        },
        () =>
          this.fail(
            'Local command recognition unavailable. Retry voice or use text.',
          ),
      );
    }
    if (ports.collect) {
      this.draftRecognition = new DraftRecognition(
        ports.collect,
        ports.stop,
        (text, id, final, commandAllowed, wakeAllowed) =>
          this.acceptCollectedTranscript(
            text,
            id,
            final,
            commandAllowed,
            wakeAllowed,
          ),
        () =>
          this.fail('Local draft recognition stopped. Your text is retained.'),
        !ports.keywords,
        (stage) => {
          if (stage === 'queued') {
            this.latency.finish('interrupted');
            this.latency.begin();
          } else
            this.latency.point(
              stage === 'started' ? 'stt_request' : 'stt_completed',
            );
        },
        () => this.passiveRecognition?.wait(),
      );
    }
    if (ports.presentFinalized)
      this.presentation = { handler: ports.presentFinalized };
  }

  setRecognitionOptions(sensitivity: WakeSensitivity, visible: boolean) {
    if (this.wakeSensitivity !== sensitivity) {
      if (this.pendingFallback) {
        this.retireFallback();
        this.publish();
      }
      this.wakeSensitivity = sensitivity;
      this.invocation.setSensitivity(sensitivity);
      this.fastCommands?.reset();
      this.passiveRecognition?.reset();
      this.passiveTicket = undefined;
    }
    this.showRecognition = visible;
  }

  bindPromptPresentation(handler: PromptPresentation): () => void {
    if (this.disposed) return () => undefined;
    if (this.activePresentation) {
      this.invalidate();
      this.publish();
    }
    const binding = { handler };
    this.presentation = binding;
    return () => {
      if (this.presentation !== binding) return;
      this.presentation = undefined;
      if (this.activePresentation?.binding === binding) {
        this.invalidate();
        this.publish();
      }
    };
  }

  update(context: VoiceContext) {
    if (this.disposed) return;
    if (
      this.phase === 'speaking' &&
      context.speech.operation_id === this.settledTurn
    )
      this.latency.speech(context.speech);
    const hadCapture = this.context?.audio.status === 'capturing';
    const assistantWasBusy = ['submitting', 'admitted'].includes(
      this.context?.assistant.turn ?? '',
    );
    const assistantIsBusy = ['submitting', 'admitted'].includes(
      context.assistant.turn,
    );
    this.context = context;
    if (
      this.voiceTurn &&
      this.responseContext &&
      (context.assistant.model !== this.responseContext.model ||
        context.assistant.workspace_epoch !== this.responseContext.workspace ||
        context.assistant.connection !== 'ready')
    ) {
      this.invalidate();
    }
    if (
      this.playback.owner()?.id === context.speech.operation_id &&
      this.voiceTurn
    )
      this.latency.speech(context.speech);
    const retiredFallback =
      !!this.pendingFallback &&
      !this.fallbackContextMatches(this.pendingFallback, context);
    if (retiredFallback) this.retireFallback();
    this.playback.observe(context.speech);
    if (context.assistant.model === 'sol' && context.assistant.turn_id)
      this.solSessionStarted = true;
    if (
      context.assistant.reset_id &&
      context.assistant.reset_id !== this.lastResetId
    ) {
      this.lastResetId = context.assistant.reset_id;
      if (this.fastCommands) this.invalidate();
      this.finishNewSession();
    }
    if (
      !context.available ||
      (hadCapture &&
        !['capturing', 'turn-paused'].includes(context.audio.status))
    ) {
      this.invocation.reset();
      this.invalidate();
    } else if (
      !retiredFallback &&
      !assistantWasBusy &&
      assistantIsBusy &&
      this.phase === null &&
      !this.typedLease
    ) {
      this.invalidate();
    } else if (
      this.phase === 'speaking' &&
      this.playbackAcknowledged &&
      context.speech.state === 'idle' &&
      BigInt(context.speech.revision) >= this.playbackRevision
    ) {
      this.phase = null;
      this.invocation.activate();
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

  accept(event: PcmEvent, audio?: AudioActivityState) {
    if (this.disposed) return;
    if (event.type === 'turn-pause') {
      this.pcmSequence = null;
      this.lastVoicedSequence = null;
      this.pendingControl = undefined;
      this.suppressControls = false;
      this.assembler.reset();
      this.resetSpeechActivity();
      this.fastCommands?.reset();
      return;
    }
    if (event.type === 'reset') {
      this.invocation.reset();
      this.invalidate(false);
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
        if (
          !validPcmChunk(event.chunk) ||
          (this.pcmSequence !== null &&
            event.chunk.sequence !== this.pcmSequence + 1)
        ) {
          this.fail('Audio was interrupted. Retry voice before continuing.');
          return;
        }
        this.pcmSequence = event.chunk.sequence;
        const context =
          this.context && audio ? { ...this.context, audio } : this.context;
        if (this.composition.status === 'composing' && this.draftRecognition) {
          if (
            this.draftSequence !== null &&
            event.chunk.sequence !== this.draftSequence + 1
          ) {
            this.fail(
              'Audio was interrupted. Your draft is retained; restart the microphone.',
            );
            return;
          }
          this.draftSequence = event.chunk.sequence;
        } else this.draftSequence = null;
        if (this.awaitingQuiet) {
          this.pendingControl = undefined;
          this.assembler.reset();
          this.resetSpeechActivity();
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
          this.pendingControl = undefined;
          this.assembler.reset();
          this.resetSpeechActivity();
          this.fastCommands?.reset();
          this.passiveRecognition?.reset();
          this.passiveTicket = undefined;
          return;
        }
        const activity =
          this.speechActivity?.push(
            event.chunk.samples,
            context.audio.activity,
          ) ?? context.audio.activity;
        if (this.speechActivity?.voiced())
          this.lastVoicedSequence = event.chunk.sequence;
        if (this.pendingControl && this.speechActivity?.voiced()) {
          this.pendingControl = undefined;
          this.suppressControls = true;
        }
        // A spoken prefix followed by a thinking pause is still dictation.
        // The acoustic event is provisional until this separate action boundary.
        if ((this.speechActivity?.quietMs() ?? 0) >= 1000) {
          // Retire all hypotheses from the continued phrase before rearming.
          if (this.suppressControls) this.fastCommands?.reset();
          this.suppressControls = false;
          if (this.pendingControl) {
            const command = this.pendingControl;
            this.pendingControl = undefined;
            this.fastCommands?.reset();
            void this.acceptFastCommand(command, []);
            return;
          }
        }
        this.latency.activity(activity.active);
        if (this.awaitingWake && this.fastCommands) {
          this.passiveRecognition?.push(event.chunk, activity);
        }
        if (this.fastCommands && !context.audio.activity.calibrating) {
          this.speechResourcesUsed = true;
          this.fastCommands.push(
            event.chunk,
            Math.min(
              0.2,
              Math.max(0.008, context.audio.activity.noiseFloor * 3),
            ),
            this.awaitingWake
              ? this.wakeSensitivity === 'high'
                ? 'passive_sensitive'
                : 'passive'
              : this.composition.status === 'composing'
                ? 'composing'
                : 'listening',
          );
        }
        if (this.fastCommands && this.awaitingWake) return;
        const pcm = this.assembler.push(event.chunk, {
          ...activity,
          draft:
            this.composition.status === 'composing' &&
            Boolean(this.draftRecognition),
        });
        if (this.draftRecognition) {
          this.previewSamples =
            this.composition.status === 'composing' ||
            (!this.invocation.active() && context.audio.activity.active)
              ? this.previewSamples + event.chunk.samples.length
              : 0;
          if (pcm) {
            this.previewSamples = 0;
            const capped = this.assembler.lastResultCapped();
            const wakeAllowed = !this.draftCapped;
            const commandAllowed = !capped && !this.draftCapped;
            this.draftCapped = capped;
            this.draftRecognition.offer(
              pcm,
              this.ports.id(),
              true,
              commandAllowed,
              'draft',
              wakeAllowed,
            );
          } else if (
            (this.composition.status === 'composing' ||
              (!this.fastCommands &&
                !this.invocation.active() &&
                context.audio.activity.active)) &&
            this.previewSamples >=
              (this.fastCommands
                ? 32000
                : this.composition.status === 'composing'
                  ? 16000
                  : 8000) &&
            this.draftRecognition.canPreview()
          ) {
            this.previewSamples = 0;
            const preview = this.assembler.snapshot();
            if (preview)
              this.draftRecognition.offer(
                preview,
                this.ports.id(),
                false,
                !this.draftCapped,
                this.composition.status === 'composing' ? 'draft' : 'wake',
              );
          }
          if (
            !pcm &&
            this.draftCapped &&
            !this.assembler.hasCappedContinuation()
          )
            this.draftCapped = false;
        } else if (pcm) void this.transcribe(pcm);
      } finally {
        event.chunk.samples.fill(0);
      }
    }
  }

  private async acceptFastCommand(
    detection: KeywordDetection,
    tail: PcmChunk[],
  ) {
    const context = this.context;
    try {
      if (!context || !this.canCollect(context) || this.awaitingQuiet) return;
      if (detection.command === 'ivy') {
        this.passiveRecognition?.reset();
        this.passiveTicket = undefined;
        if (this.showRecognition)
          this.ports.onRecognition?.({ text: 'Ivy', status: 'Wake detected' });
        if (!this.awaitingWake) return;
        this.invocation.activateAcoustically();
        this.setComposition({ ...this.composition, model: 'terra' });
        this.resetSpeechActivity();
        this.controlNotice = '';
        this.assembler.reset();
        let completed: Int16Array | null = null;
        for (const chunk of tail) {
          const activity =
            this.speechActivity?.push(chunk.samples, context.audio.activity) ??
            context.audio.activity;
          const pcm = this.assembler.push(chunk, activity);
          if (pcm) {
            if (!completed) completed = pcm;
            else pcm.fill(0);
          }
        }
        this.publish();
        if (completed) void this.transcribe(completed);
        return;
      }
      if (this.awaitingWake) return;
      const generation = ++this.generation;
      this.assembler.reset();
      this.resetSpeechActivity();
      this.previewSamples = 0;
      const stopped = this.draftRecognition?.reset();
      this.phase = 'transcribing';
      this.publish();
      if (stopped) await stopped;
      if (!this.current(generation)) return;
      if (detection.command === 'prompt cancel') {
        if (this.composition.status !== 'composing') {
          this.phase = null;
          this.publish();
          return;
        }
        this.cancelPrompt();
        return;
      }
      await this.recognize(detection.command, this.ports.id(), generation);
    } catch {
      if (!this.disposed)
        this.fail('Local command could not complete. Retry voice or use text.');
    } finally {
      for (const chunk of tail) chunk.samples.fill(0);
    }
  }

  private async acceptPassiveTranscript(text: string, id: string) {
    const ticket = this.passiveTicket;
    const context = this.context;
    this.passiveTicket = undefined;
    if (
      !ticket ||
      ticket.id !== id ||
      !this.current(ticket.generation) ||
      !context ||
      context.speech.epoch !== ticket.epoch ||
      context.assistant.reset_id !== ticket.resetId ||
      context.assistant.workspace_epoch !== ticket.workspaceEpoch ||
      context.assistant.model !== ticket.model
    )
      return;
    const recognizedWake = this.invocation.matches(text);
    const ownedSpeech =
      context.speech.state === 'idle' ||
      (context.speech.state === 'collecting' &&
        context.speech.operation_id === id);
    const eligible =
      this.awaitingWake &&
      !this.awaitingQuiet &&
      this.canCollect(context) &&
      ownedSpeech &&
      !this.promptOpen &&
      this.composition.status === 'idle' &&
      !this.draftRecognition?.isBusy();
    if (!eligible || !recognizedWake) {
      if (this.showRecognition && text.trim())
        this.ports.onRecognition?.({
          text: text.trim().slice(0, 320),
          status: recognizedWake ? 'Wake suppressed' : 'No wake detected',
        });
      return;
    }
    const generation = ++this.generation;
    this.fastCommands?.reset();
    this.passiveRecognition?.reset();
    this.assembler.reset();
    this.resetSpeechActivity();
    this.controlNotice = '';
    this.pendingFallback = { ...ticket, generation };
    try {
      await this.acceptCollectedTranscript(text, id, true, true, true);
    } catch {
      if (this.current(generation))
        this.fail('Local recognition unavailable. Retry voice or use text.');
    } finally {
      if (this.pendingFallback?.generation === generation)
        this.pendingFallback = undefined;
    }
  }

  private retireFallback() {
    ++this.generation;
    this.pendingFallback = undefined;
    this.passiveTicket = undefined;
    this.passiveRecognition?.reset();
    this.fastCommands?.reset();
    this.assembler.reset();
    this.resetSpeechActivity();
    this.invocation.reset();
    this.phase = null;
    this.inputText = '';
    this.refinement?.abort();
    this.refinement = undefined;
    this.ports.cancelReflex?.();
    this.latency.finish('interrupted');
  }

  private fallbackContextMatches(
    ticket: PassiveWakeTicket,
    context: VoiceContext,
  ) {
    return (
      context.available &&
      ['capturing', 'turn-paused'].includes(context.audio.status) &&
      (context.assistant.connection === 'ready' || !!context.localAvailable) &&
      context.speech.epoch === ticket.epoch &&
      context.assistant.reset_id === ticket.resetId &&
      context.assistant.workspace_epoch === ticket.workspaceEpoch &&
      context.assistant.model === ticket.model &&
      !['submitting', 'admitted', 'uncertain'].includes(
        context.assistant.turn,
      ) &&
      (context.speech.state === 'idle' ||
        (context.speech.state === 'collecting' &&
          context.speech.operation_id === ticket.id))
    );
  }

  setMuted(muted: boolean) {
    if (this.disposed) return;
    this.muted = muted;
    if (muted) {
      this.responseSuppressed = true;
      const active = this.playback.busy();
      this.playback.clear();
      if (active && this.phase !== 'speaking')
        void this.ports
          .stop()
          .catch(() =>
            this.fail(
              'Local speech could not stop. Retry voice before resuming.',
            ),
          );
    }
    if (
      muted &&
      (this.phase === 'speaking' ||
        this.composition.status === 'refining' ||
        this.composition.status === 'finalizing')
    )
      this.invalidate();
    this.publish();
  }

  stopVoice() {
    if (this.disposed) return;
    this.awaitingQuiet = true;
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
      refined: null,
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
      !preparing(this.composition.status)
    )
      this.setComposition({ ...this.composition, model });
  }

  setDraft(raw: string) {
    if (
      this.disposed ||
      this.sessionPending ||
      preparing(this.composition.status)
    )
      return;
    if (this.pendingFallback) this.retireFallback();
    this.invocation.activate();
    this.promptOpen = true;
    if (raw !== this.composition.raw) {
      this.dispatchUncertain = false;
      this.cancelDraftCleanup();
    }
    this.setComposition({
      ...this.composition,
      raw,
      draft: raw === this.composition.raw ? this.composition.draft : raw,
      preview: '',
      refined: raw === this.composition.raw ? this.composition.refined : null,
      status: fitsVoicePrompt(raw) ? 'composing' : 'error',
      error: fitsVoicePrompt(raw)
        ? ''
        : 'Prompt exceeds the 8 KiB limit. Edit it before sending.',
    });
    this.publish();
  }

  initializeSession(model: VoiceModel) {
    if (
      !this.disposed &&
      !this.sessionPending &&
      !preparing(this.composition.status)
    ) {
      if (model === 'sol') this.solSessionStarted = true;
      this.setComposition({ ...this.composition, model });
    }
  }

  async resetConversation(): Promise<boolean> {
    this.fastCommands?.reset();
    this.resetSpeechActivity();
    if (this.disposed || this.sessionPending || this.phase !== null)
      return false;
    if (this.typedLease) {
      this.typedLease.abort();
      ++this.generation;
    }
    const draftStop = this.draftRecognition?.reset();
    this.cancelDraftCleanup();
    this.assembler.reset();
    this.previewSamples = 0;
    this.draftSequence = null;
    this.draftCapped = false;
    if (this.composition.preview)
      this.setComposition({ ...this.composition, preview: '' });
    const generation = this.generation;
    if (draftStop) {
      this.phase = 'transcribing';
      this.publish();
      try {
        await draftStop;
        await this.ports.waitForCapturePause?.();
        if (!this.current(generation)) return false;
      } catch {
        if (this.current(generation))
          this.fail(
            'Local draft recognition could not stop. Your text is retained.',
          );
        return false;
      }
    }
    return this.clearConversation(generation);
  }

  async withCaptureReleased(
    action: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> {
    const context = this.context;
    const passive = this.passiveRecognition?.pending();
    const speechOccupied = (speech: SpeechSnapshot) =>
      (speech.state === 'collecting' &&
        (!passive ||
          speech.operation_id !== passive.id ||
          speech.epoch !== context?.speech.epoch)) ||
      ['transcribing', 'synthesizing', 'speaking'].includes(speech.state);
    if (
      this.disposed ||
      !context?.available ||
      (context.assistant.connection !== 'ready' && !context.localAvailable) ||
      ['submitting', 'admitted', 'uncertain'].includes(
        context.assistant.turn,
      ) ||
      this.typedLease ||
      this.phase ||
      this.stopping ||
      this.unconfirmedStop ||
      this.sessionPending ||
      this.dispatchPending ||
      this.dispatchUncertain ||
      this.blocked ||
      this.routeUncertain ||
      preparing(this.composition.status) ||
      this.draftRecognition?.isBusy() ||
      this.draftCleanups.size ||
      speechOccupied(context.speech)
    )
      return false;
    this.fastCommands?.reset();
    this.resetSpeechActivity();
    const controller = new AbortController();
    this.typedLease = controller;
    this.passiveRecognition?.reset();
    const generation = this.generation;
    this.publish();
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.all([this.ports.waitForCapturePause?.(), passive?.promise]),
        new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(new DOMException('Capture lease cancelled', 'AbortError'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        }),
      ]);
      if (
        controller.signal.aborted ||
        !this.current(generation) ||
        !this.context?.available ||
        this.typedLease !== controller ||
        ['submitting', 'admitted', 'uncertain'].includes(
          this.context.assistant.turn,
        ) ||
        speechOccupied(this.context.speech)
      )
        return false;
      const accepted = await action(controller.signal);
      if (accepted && this.current(generation)) {
        this.invocation.activate();
        this.controlNotice = '';
      }
      return accepted;
    } catch {
      return false;
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (this.typedLease === controller) this.typedLease = undefined;
      if (!this.disposed) this.publish();
    }
  }

  private setComposition(state: VoiceComposition) {
    if (state.status === 'composing') this.inputText = '';
    this.composition = Object.freeze(state);
    this.ports.onComposition?.(this.composition);
  }

  private isPromptCancellation(text: string, commandAllowed: boolean) {
    return this.fastCommands
      ? commandAllowed && voiceCommand(text) === 'prompt cancel'
      : cancelsPrompt(text);
  }

  private async acceptCollectedTranscript(
    text: string,
    id: string,
    final: boolean,
    commandAllowed: boolean,
    wakeAllowed: boolean,
  ) {
    if (this.disposed) return;
    if (this.fastCommands && final && commandAllowed) {
      this.fastCommands.reset();
      this.resetSpeechActivity();
    }
    this.observeInput(text);
    if (!final && !this.promptOpen && !this.invocation.active()) {
      if (wakeAllowed && this.invocation.accept(text, false)) {
        this.publish();
      }
      return;
    }
    if (
      final &&
      this.promptOpen &&
      this.isPromptCancellation(text, commandAllowed)
    ) {
      this.cancelPrompt();
      return;
    }
    if (this.composition.status === 'composing') {
      await this.acceptDraftTranscript(text, id, final, commandAllowed);
      return;
    }
    if (!final || !text.trim()) return;
    const generation = this.generation;
    const control = commandAllowed ? voiceCommand(text) : null;
    if (control === 'new session' || control === 'reload mcp') {
      await this.recognize(text, id, generation, commandAllowed);
      return;
    }
    // A capped continuation cannot introduce a new utterance-prefix wake word.
    if (
      !wakeAllowed &&
      !this.invocation.active() &&
      this.composition.status === 'idle'
    )
      return;
    const invocation = this.invocation.accept(text, this.promptOpen);
    if (!invocation) {
      this.publish();
      return;
    }
    const opensPrompt =
      (invocation.invoked &&
        !(
          this.fastCommands && voiceCommand(invocation.text) === 'prompt cancel'
        ) &&
        promptInvocation(invocation.text) !== null) ||
      voiceCommand(invocation.text) === 'prompt';
    if (invocation.text.trim() && !opensPrompt) {
      this.draftRecognition?.clearPending();
      this.assembler.reset();
      this.phase = 'transcribing';
      this.publish();
      await this.ports.waitForCapturePause?.();
      if (!this.current(generation)) return;
    }
    await this.recognize(text, id, generation, commandAllowed, invocation);
    if (this.current(generation) && this.phase === null)
      this.latency.finish(this.failure ? 'interrupted' : 'completed');
  }

  private async acceptDraftTranscript(
    text: string,
    id: string,
    final: boolean,
    commandAllowed: boolean,
  ) {
    if (this.disposed || this.composition.status !== 'composing') return;
    if (final && this.isPromptCancellation(text, commandAllowed)) {
      this.cancelPrompt();
      return;
    }
    if (!final) {
      this.setComposition({ ...this.composition, preview: text });
      return;
    }
    this.setComposition({ ...this.composition, preview: '' });
    if (!text.trim()) return;
    const command = commandAllowed ? voiceCommand(text) : null;
    if (
      command === 'end prompt' ||
      command === 'send prompt' ||
      command === 'send' ||
      command === 'clear' ||
      command === 'done' ||
      command === 'prompt cancel' ||
      command === 'new session' ||
      command === 'reload mcp'
    ) {
      this.draftRecognition?.clearPending();
      this.assembler.reset();
      this.phase = 'transcribing';
      this.publish();
      const generation = this.generation;
      try {
        await this.ports.waitForCapturePause?.();
        if (!this.current(generation)) return;
        await this.draftCleanupPromise;
        if (!this.current(generation)) return;
        await this.recognize(text, id, generation);
      } catch {
        if (this.current(generation))
          this.compositionError(
            'Prompt preparation interrupted. Your text is retained.',
          );
      }
      return;
    }
    await this.recognize(text, id, this.generation, commandAllowed);
    if (command !== 'prompt' && this.composition.status === 'composing')
      this.refineDraft();
  }

  private refineDraft() {
    const raw = this.composition.raw;
    const refine = this.ports.refinePrompt;
    if (!raw.trim() || !fitsVoicePrompt(raw) || !refine) return;
    const controller = new AbortController();
    this.draftCleanups.add(controller);
    const revision = ++this.draftRevision;
    const previous = this.draftCleanupPromise ?? Promise.resolve();
    const pending = previous
      .then(() => {
        if (controller.signal.aborted || revision !== this.draftRevision)
          return '';
        return refine(raw, controller.signal);
      })
      .then((text) => {
        if (
          !controller.signal.aborted &&
          !this.disposed &&
          revision === this.draftRevision &&
          this.composition.status === 'composing' &&
          this.composition.raw === raw &&
          text.trim() &&
          fitsVoicePrompt(text)
        )
          this.setComposition({
            ...this.composition,
            refined: text,
            draft: text,
            refinementRevision: (this.composition.refinementRevision ?? 0) + 1,
          });
      })
      .catch(() => undefined)
      .finally(() => {
        this.draftCleanups.delete(controller);
        if (this.draftCleanupPromise === pending)
          this.draftCleanupPromise = undefined;
      });
    this.draftCleanupPromise = pending;
  }

  private cancelDraftCleanup() {
    ++this.draftRevision;
    for (const controller of this.draftCleanups) controller.abort();
    this.draftCleanups.clear();
    this.draftCleanupPromise = undefined;
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
      preparing(this.composition.status)
    )
      return false;
    this.routeUncertain = false;
    if (model === 'sol') this.solSessionStarted = true;
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
    this.pendingFallback = undefined;
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

  private async recognize(
    text: string,
    id: string,
    generation: number,
    commandAllowed = true,
    acceptedInvocation?: NonNullable<ReturnType<VoiceInvocation['accept']>>,
  ) {
    if (!this.current(generation)) return;
    if (this.sessionPending) return;
    const composing = this.promptOpen;
    if (composing && this.isPromptCancellation(text, commandAllowed)) {
      this.cancelPrompt();
      return;
    }
    const control = commandAllowed ? voiceCommand(text) : null;
    if (control === 'new session' || control === 'reload mcp') {
      await this.lifecycleCommand(control, generation);
      return;
    }
    const invocation =
      acceptedInvocation ?? this.invocation.accept(text, composing);
    if (!invocation) {
      this.phase = null;
      this.publish();
      return;
    }
    text = invocation.text;
    const prompt =
      invocation.invoked &&
      !(this.fastCommands && voiceCommand(text) === 'prompt cancel')
        ? promptInvocation(text)
        : null;
    if (invocation.invoked && !composing)
      this.setComposition({
        ...this.composition,
        model: prompt === null ? 'terra' : 'sol',
      });
    if (!text.trim()) {
      this.phase = null;
      this.publish();
      return;
    }
    if (prompt !== null) {
      this.promptOpen = true;
      this.phase = null;
      this.setComposition({
        ...this.composition,
        model: 'sol',
        status: 'composing',
        error: '',
      });
      if (this.isPromptCancellation(prompt, commandAllowed)) {
        this.cancelPrompt();
        return;
      }
      if (prompt.trim()) await this.recognize(prompt, id, generation, false);
      this.publish();
      return;
    }
    const command = commandAllowed ? voiceCommand(text) : null;
    if (command === 'new session' || command === 'reload mcp') {
      await this.lifecycleCommand(command, generation);
      return;
    }
    this.controlNotice = '';
    if (command === 'prompt') {
      this.promptOpen = true;
      this.latency.finish('interrupted');
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
      const cleared = await this.clearConversation(generation);
      if (cleared && this.fastCommands && this.current(generation)) {
        this.awaitingWake = true;
        this.publish();
      }
      return;
    }
    if (
      command === 'end prompt' ||
      command === 'send prompt' ||
      command === 'send'
    ) {
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
        draft: this.composition.draft
          ? `${this.composition.draft}\n${text}`
          : raw,
        preview: '',
        refined: null,
        status: fitsVoicePrompt(raw) ? 'composing' : 'error',
        error: fitsVoicePrompt(raw)
          ? ''
          : 'Prompt exceeds the 8 KiB limit. Clear it before sending.',
      });
      this.publish();
      return;
    }
    const model = this.composition.model;
    if (model === 'terra' && this.ports.reflex) {
      const controller = new AbortController();
      this.refinement = controller;
      const local = await this.ports.reflex(
        text,
        id,
        controller.signal,
        (stage) => this.latency.point(stage),
      );
      if (this.refinement === controller) this.refinement = undefined;
      if (!this.current(generation)) return;
      if (local.handled) {
        this.pendingFallback = undefined;
        this.phase = null;
        this.controlNotice = local.reply;
        this.invocation.activate();
        if (local.reply && !this.muted)
          await this.speakLocal(local.reply, id, generation);
        this.publish();
        return;
      }
    }
    this.setComposition({
      ...this.composition,
      raw: text,
      refined: null,
      status: 'submitting',
      error: '',
    });
    try {
      if (!this.current(generation)) return;
      if (this.routeUncertain) throw new Error();
      // Native routing now owns admission; its intentional model/workspace rotation is permitted.
      this.pendingFallback = undefined;
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

  async newSession(): Promise<boolean> {
    return this.withCaptureReleased(() =>
      this.lifecycleCommand('new session', this.generation),
    );
  }

  private async lifecycleCommand(
    command: 'new session' | 'reload mcp',
    generation: number,
  ): Promise<boolean> {
    const context = this.context;
    if (
      !context ||
      ['submitting', 'admitted', 'uncertain'].includes(
        context.assistant.turn,
      ) ||
      this.dispatchPending ||
      this.dispatchUncertain
    ) {
      this.phase = null;
      this.controlNotice =
        'Ivy is busy. Try the command after this turn finishes.';
      this.publish();
      return false;
    }
    this.pendingFallback = undefined;
    this.sessionPending = true;
    this.controlNotice =
      command === 'new session'
        ? 'Starting a fresh session'
        : 'Reloading MCP integrations';
    if (command === 'new session') this.newSessionRequested = true;
    this.publish();
    try {
      const operation =
        command === 'new session'
          ? this.ports.newSession
          : this.ports.reloadMcp;
      const accepted = operation ? await operation() : false;
      if (command === 'new session' && !this.newSessionRequested)
        return accepted;
      if (
        this.disposed ||
        (!this.current(generation) && !(accepted && command === 'new session'))
      )
        return false;
      this.phase = null;
      if (!accepted) {
        this.controlNotice =
          command === 'new session'
            ? 'New session was not confirmed. Check Ivy before continuing.'
            : 'MCP reload unavailable or busy. Conversation preserved.';
      } else if (command === 'new session') {
        if (this.newSessionRequested) this.finishNewSession();
      } else this.controlNotice = 'MCP integrations reloaded.';
      return accepted;
    } catch {
      if (
        this.current(generation) &&
        (command !== 'new session' || this.newSessionRequested)
      ) {
        this.phase = null;
        this.controlNotice =
          command === 'new session'
            ? 'New session was not confirmed. Check Ivy before continuing.'
            : 'MCP reload failed or is unsupported. Conversation preserved.';
      }
      return false;
    } finally {
      this.sessionPending = false;
      if (!this.disposed) this.publish();
    }
  }

  private finishNewSession() {
    this.solSessionStarted = false;
    this.fastCommands?.reset();
    this.assembler.reset();
    this.resetSpeechActivity();
    this.newSessionRequested = false;
    this.invocation.reset();
    this.promptOpen = false;
    this.invalidate();
    this.dispatchUncertain = false;
    this.routeUncertain = false;
    this.voiceTurn = null;
    this.settledTurn = null;
    this.phase = null;
    this.setComposition({
      raw: '',
      refined: null,
      lastSubmittedRaw: '',
      model: this.composition.model,
      status: 'idle',
      error: '',
    });
    this.controlNotice = 'New session. Say Ivy.';
    this.publish();
    this.ports.onNewSession?.();
  }

  private async clearConversation(generation: number): Promise<boolean> {
    this.invocation.reset();
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
    this.invocation.reset();
    this.solSessionStarted = false;
    this.promptOpen = false;
    this.phase = null;
    this.setComposition({
      raw: '',
      refined: null,
      lastSubmittedRaw: '',
      model: 'terra',
      status: 'idle',
      error: '',
    });
    this.publish();
    return true;
  }

  private cancelPrompt() {
    const resumeTerra = !this.solSessionStarted;
    this.promptOpen = false;
    if (resumeTerra) this.invocation.activate();
    else this.invocation.reset();
    this.invalidate();
    this.dispatchUncertain = false;
    this.failure = '';
    this.setComposition({
      raw: '',
      refined: null,
      lastSubmittedRaw: '',
      model: 'terra',
      status: 'idle',
      error: '',
    });
    if (!resumeTerra) this.ports.onForegroundEnd?.();
    this.publish();
  }

  private async finalize(id: string, generation: number) {
    const { raw, model } = this.composition;
    const prepared = this.composition.refined;
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
    const binding = this.presentation;
    const activePresentation = binding ? { binding } : undefined;
    this.activePresentation = activePresentation;
    this.setComposition({
      ...this.composition,
      refined: null,
      status: 'refining',
      error: '',
    });
    let controller: AbortController | undefined;
    let presenting = false;
    try {
      if (!this.current(generation)) return;
      // Native routing now owns admission; its intentional model/workspace rotation is permitted.
      this.pendingFallback = undefined;
      const selectSession = this.ports.selectSession;
      if (model === 'sol' && !selectSession) throw new Error();
      if (
        selectSession &&
        !(await this.mutateSession(() => selectSession(model), generation))
      )
        throw new Error();
      if (!this.current(generation)) return;
      controller = new AbortController();
      this.refinement = controller;
      const text =
        prepared ??
        (this.ports.refinePrompt
          ? await this.ports.refinePrompt(raw, controller.signal)
          : raw);
      if (!this.current(generation)) return;
      if (!text.trim() || !fitsVoicePrompt(text)) throw new Error();
      if (binding) {
        this.setComposition({
          ...this.composition,
          refined: text,
          status: 'finalizing',
        });
        if (
          !this.current(generation) ||
          controller.signal.aborted ||
          this.presentation !== binding
        )
          return;
        presenting = true;
        await awaitPromptPresentation(
          binding.handler,
          Object.freeze({ raw, refined: text, model }),
          controller,
        );
        presenting = false;
        if (!this.current(generation) || controller.signal.aborted) return;
        if (this.activePresentation === activePresentation)
          this.activePresentation = undefined;
      }
      this.setComposition({
        ...this.composition,
        refined: text,
        status: 'submitting',
      });
      if (!this.current(generation) || controller.signal.aborted) return;
      await this.dispatchDraft(raw, text, model, id, generation);
    } catch {
      if (this.current(generation))
        this.compositionError(
          this.dispatchUncertain
            ? 'The previous send may have completed. Check Ivy before editing or clearing this prompt.'
            : presenting
              ? 'Prompt presentation did not complete or timed out. Your text is retained.'
              : 'Prompt could not be prepared. Your text is retained.',
        );
    } finally {
      if (this.refinement === controller) this.refinement = undefined;
      if (this.activePresentation === activePresentation)
        this.activePresentation = undefined;
    }
  }

  private async dispatchDraft(
    raw: string,
    text: string,
    model: VoiceModel,
    id: string,
    generation: number,
  ) {
    if (model === 'sol') this.solSessionStarted = true;
    this.dispatchUncertain = true;
    this.dispatchPending = true;
    let accepted = false;
    try {
      accepted = await this.submit(text, id, generation);
    } catch {
      // A failed transport may still have delivered the turn.
    } finally {
      this.dispatchPending = false;
      this.publish();
    }
    if (!this.current(generation)) return;
    if (!accepted && this.settledTurn !== id) {
      this.compositionError(
        'The previous send may have completed. Check Ivy before editing or clearing this prompt.',
      );
      return;
    }
    this.dispatchUncertain = false;
    this.promptOpen = false;
    this.setComposition({
      raw: '',
      refined: null,
      lastSubmittedRaw: raw,
      model,
      status: 'idle',
      error: '',
    });
    this.publish();
  }

  private async submit(
    text: string,
    id: string,
    generation: number,
  ): Promise<boolean> {
    this.beginResponse(id, 'voice');
    if (!this.current(generation)) return false;
    this.latency.point('hermes_submit');
    const accepted = await this.ports.submit(text, id);
    const confirmed = this.responseConfirmed(id);
    if (
      this.current(generation) &&
      !accepted &&
      !confirmed &&
      !this.responseTerminal &&
      this.phase === 'waiting' &&
      this.voiceTurn === id
    ) {
      this.voiceTurn = null;
      this.phase = null;
      this.failure =
        'Message was not sent. Check Ivy in the menu; it will not be resent.';
      this.latency.finish('interrupted');
      this.publish();
    }
    return accepted || confirmed;
  }

  private canCollect(context: VoiceContext): boolean {
    return (
      context.available &&
      context.audio.status === 'capturing' &&
      !this.phase &&
      !this.typedLease &&
      !this.stopping &&
      !this.sessionPending &&
      !this.dispatchPending &&
      !this.routeUncertain &&
      !this.unconfirmedStop &&
      !this.blocked &&
      (context.assistant.connection === 'ready' || !!context.localAvailable) &&
      !['submitting', 'admitted', 'uncertain'].includes(
        context.assistant.turn,
      ) &&
      !['transcribing', 'synthesizing', 'speaking'].includes(
        context.speech.state,
      )
    );
  }

  private async transcribe(pcm: Int16Array) {
    this.speechResourcesUsed = true;
    this.resetSpeechActivity();
    this.fastCommands?.reset();
    this.latency.finish('interrupted');
    this.latency.begin();
    const generation = ++this.generation;
    const id = this.ports.id();
    this.phase = 'transcribing';
    this.failure = '';
    this.assembler.reset();
    this.publish();
    try {
      if (this.ports.waitForCapturePause) {
        await this.ports.waitForCapturePause();
        if (!this.current(generation)) return;
      }
      this.latency.point('stt_request');
      const pendingPassive = this.passiveRecognition?.wait();
      if (pendingPassive) {
        await pendingPassive;
        if (!this.current(generation)) return;
      }
      const transcript = await this.ports.transcribe(pcm, id);
      if (!this.current(generation)) return;
      this.latency.point('stt_completed');
      const text = transcript.text;
      if (transcript.utterance_id !== id) throw new Error();
      this.observeInput(text);
      if (!text.trim()) {
        this.phase = null;
        this.latency.finish('completed');
        this.publish();
        return;
      }
      await this.recognize(text, id, generation);
      if (this.current(generation) && this.phase === null)
        this.latency.finish(
          this.failure || this.composition.error ? 'interrupted' : 'completed',
        );
    } catch {
      if (this.current(generation))
        this.fail('Local recognition unavailable. Retry voice or use text.');
    } finally {
      pcm.fill(0);
    }
  }

  /** Only an explicit local submit can create a narration lease; history never calls this. */
  async withResponseOwnership(
    id: string,
    action: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.disposed || this.voiceTurn) return false;
    const generation = this.generation;
    this.beginResponse(id, 'typed');
    try {
      const accepted = (await action()) || this.responseConfirmed(id);
      if (!accepted && this.current(generation) && this.voiceTurn === id) {
        this.responseSuppressed = true;
        this.playback.clear();
        this.voiceTurn = null;
        this.phase = null;
      }
      return accepted;
    } catch {
      if (this.current(generation) && this.voiceTurn === id) {
        this.responseSuppressed = true;
        this.playback.clear();
        this.voiceTurn = null;
        this.phase = null;
      }
      return false;
    } finally {
      if (!this.disposed) this.publish();
    }
  }

  private beginResponse(id: string, source: 'voice' | 'typed') {
    this.settledTurn = null;
    this.voiceTurn = id;
    this.responseSource = source;
    this.responseContext = undefined;
    this.responseSequence = -1n;
    this.responseFinalSeen = false;
    this.responseTexts = [];
    this.responsePending = 0;
    this.responseTerminal = false;
    this.responseHadSpeech = false;
    this.responseSuppressed = this.muted;
    this.phase = 'waiting';
    this.publish();
  }

  private responseConfirmed(id: string) {
    return (
      this.context?.assistant.turn_id === id &&
      ['admitted', 'completed'].includes(this.context.assistant.turn)
    );
  }

  say(text: string, id: string, current = () => true): Promise<SpeechSnapshot> {
    this.speechResourcesUsed = true;
    return this.playback.play(
      text,
      id,
      () => !this.disposed && !this.muted && current(),
    );
  }

  narrationOwner() {
    return this.playback.owner();
  }

  /** Playback cancellation is distinct from cancelling the admitted research task. */
  async stopNarration(): Promise<void> {
    this.responseSuppressed = true;
    const active = this.playback.busy();
    this.playback.clear();
    if (active) await this.ports.stop();
    this.finishResponse();
  }

  private consumeReply() {
    const context = this.context;
    if (!context || this.phase !== 'waiting' || !this.voiceTurn) return;
    const snapshot = context.assistant;
    if (snapshot.turn_id !== this.voiceTurn) return;
    if (snapshot.turn === 'admitted' || snapshot.turn === 'completed')
      this.responseContext ??= {
        model: snapshot.model,
        workspace: snapshot.workspace_epoch,
      };
    if (snapshot.first_text_observed) this.latency.point('first_model_delta');
    if (snapshot.turn === 'admitted') this.latency.point('hermes_admitted');
    if (['uncertain', 'failed', 'cancelled'].includes(snapshot.turn)) {
      this.responseSuppressed = true;
      const active = this.playback.busy();
      this.playback.clear();
      if (active) void this.ports.stop().catch(() => undefined);
      this.latency.finish('interrupted');
      this.voiceTurn = null;
      this.phase = null;
      this.failure =
        snapshot.turn === 'uncertain'
          ? 'Ivy response is uncertain. Check response; voice will not resend.'
          : 'Ivy did not complete the voice request. See the menu.';
      return;
    }
    const terminal = snapshot.turn === 'completed';
    const segments = snapshot.response_segments ?? [];
    for (const segment of segments) {
      if (segment.kind === 'final') {
        if (!terminal || this.responseFinalSeen) continue;
        this.responseFinalSeen = true;
      } else {
        // Native replay fencing guarantees monotonic sequences within this lease.
        const sequence = BigInt(segment.sequence!);
        if (sequence <= this.responseSequence) continue;
        this.responseSequence = sequence;
      }
      const text = spokenResponse([{ kind: 'text', text: segment.text }]);
      const reused =
        segment.kind === 'final' &&
        segment.reused &&
        (this.responseTexts.includes(text) ||
          this.responseTexts.join('\n\n') === text);
      if (reused) continue;
      const offered = this.offerResponse(
        text,
        segment.kind === 'final' ? this.voiceTurn : this.ports.id(),
      );
      if (offered && segment.kind === 'commentary') {
        this.responseTexts.push(text);
        if (this.responseTexts.length > 16) this.responseTexts.shift();
      }
    }
    // Legacy/final-only peers remain usable; never manufacture an interim boundary.
    if (
      terminal &&
      !segments.some((segment) => segment.kind === 'final') &&
      !this.responseFinalSeen
    ) {
      this.responseFinalSeen = true;
      this.offerResponse(spokenResponse(snapshot.items), this.voiceTurn);
    }
    if (terminal) {
      this.settledTurn = this.voiceTurn;
      this.responseTerminal = true;
      this.latency.point('model_completed');
      this.finishResponse();
    }
  }

  private offerResponse(text: string, id: string): boolean {
    const context = this.context;
    if (
      !text ||
      this.responseSuppressed ||
      this.muted ||
      !context?.available ||
      (this.responseSource === 'voice' &&
        !['capturing', 'turn-paused'].includes(context.audio.status))
    )
      return false;
    const chunks = responseSpeech(text);
    if (!chunks.length) {
      this.controlNotice =
        'Long reply is available as text; this segment exceeds the local voice limit.';
      return false;
    }
    if (!this.playback.canAccept(chunks)) {
      this.controlNotice =
        'Speech queue is full. This update remains available as text.';
      return false;
    }
    for (const [index, chunk] of chunks.entries())
      this.queueResponse(chunk, index === 0 ? id : this.ports.id());
    return true;
  }

  private queueResponse(text: string, id: string) {
    const generation = this.generation;
    const turn = this.voiceTurn;
    this.latency.point('first_validated_text');
    ++this.responsePending;
    this.responseHadSpeech = true;
    void this.say(
      text,
      id,
      () =>
        this.current(generation) &&
        this.voiceTurn === turn &&
        !this.responseSuppressed,
    )
      .catch(() => {
        if (
          this.current(generation) &&
          this.voiceTurn === turn &&
          !this.responseSuppressed
        ) {
          this.responseSuppressed = true;
          this.controlNotice =
            'Local speech unavailable. The reply remains available as text.';
        }
      })
      .finally(() => {
        if (!this.current(generation) || this.voiceTurn !== turn) return;
        --this.responsePending;
        this.finishResponse();
        this.publish();
      });
  }

  private finishResponse() {
    if (
      !this.responseTerminal ||
      (this.responsePending && this.playback.busy())
    )
      return;
    this.voiceTurn = null;
    this.phase = null;
    this.invocation.activate();
    this.awaitingQuiet ||= this.responseHadSpeech;
    this.assembler.reset();
    this.latency.finish('completed');
    this.publish();
  }

  private async speakLocal(text: string, id: string, generation: number) {
    this.phase = 'speaking';
    this.settledTurn = id;
    this.playbackAcknowledged = false;
    this.latency.point('tts_request');
    this.publish();
    try {
      const snapshot = await this.say(text, id);
      if (!this.current(generation)) return;
      this.latency.speech(snapshot);
      this.playbackAcknowledged = true;
      this.playbackRevision = BigInt(snapshot.revision);
      const observed = this.context?.speech;
      if (
        snapshot.state === 'idle' ||
        (observed?.state === 'idle' &&
          BigInt(observed.revision) >= this.playbackRevision)
      ) {
        this.phase = null;
        this.invocation.activate();
        this.awaitingQuiet = true;
        this.assembler.reset();
      } else if (snapshot.state === 'unavailable')
        this.fail('Local voice unavailable. Reply is available as text.');
    } catch {
      if (this.current(generation))
        this.fail('Local voice unavailable. Reply is available as text.');
    }
  }

  private resetSpeechActivity() {
    this.pendingControl = undefined;
    this.suppressControls = false;
    this.lastVoicedSequence = null;
    this.speechActivity?.reset();
  }

  private invalidate(stopWarmWorkers = true) {
    this.passiveRecognition?.reset();
    this.passiveTicket = undefined;
    this.pendingFallback = undefined;
    this.playback.clear();
    this.ports.cancelReflex?.();
    this.pcmSequence = null;
    this.lastVoicedSequence = null;
    this.pendingControl = undefined;
    this.suppressControls = false;
    this.fastCommands?.reset();
    this.resetSpeechActivity();
    this.inputText = '';
    this.latency.finish('interrupted');
    this.typedLease?.abort();
    if (this.phase === 'speaking') this.awaitingQuiet = true;
    const draftStop = this.draftRecognition?.reset();
    const active =
      (stopWarmWorkers && this.speechResourcesUsed) ||
      Boolean(draftStop) ||
      this.unconfirmedStop ||
      this.phase !== null ||
      (this.context &&
        ['collecting', 'transcribing', 'synthesizing', 'speaking'].includes(
          this.context.speech.state,
        ));
    if (stopWarmWorkers || active) this.speechResourcesUsed = false;
    ++this.generation;
    this.cancelDraftCleanup();
    this.previewSamples = 0;
    this.draftSequence = null;
    this.draftCapped = false;
    if (this.composition.preview)
      this.setComposition({ ...this.composition, preview: '' });
    this.refinement?.abort();
    this.refinement = undefined;
    if (preparing(this.composition.status))
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
      void (draftStop ?? this.ports.stop())
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

  private observeInput(text: string) {
    this.observeRecognition(text);
    if (this.promptOpen || !text.trim()) return;
    this.inputText = text;
    this.publish();
  }

  private observeRecognition(text: string) {
    if (!this.showRecognition || !text.trim()) return;
    this.ports.onRecognition?.({
      text: text.trim().slice(0, 320),
      status: this.invocation.active()
        ? 'Active conversation'
        : this.invocation.matches(text)
          ? 'Wake detected'
          : 'No wake detected',
    });
  }

  private publish() {
    const paused =
      Boolean(this.typedLease) ||
      this.phase !== null ||
      this.stopping ||
      this.unconfirmedStop ||
      this.dispatchPending ||
      this.sessionPending ||
      this.dispatchUncertain ||
      this.blocked ||
      this.routeUncertain ||
      ['submitting', 'admitted', 'uncertain'].includes(
        this.context?.assistant.turn ?? '',
      );
    if (paused !== this.capturePaused) {
      this.capturePaused = paused;
      this.ports.onCapturePauseChange?.(paused);
    }
    const context = this.context;
    const voiceEligible = Boolean(
      context?.available &&
        context.audio.status === 'capturing' &&
        !this.stopping &&
        !this.blocked &&
        !this.failure &&
        !this.awaitingQuiet &&
        !this.typedLease &&
        (this.promptOpen || this.invocation.active()),
    );
    this.ports.onChange({
      ducking:
        voiceEligible &&
        (this.phase !== null ||
          preparing(this.composition.status) ||
          context?.audio.activity.active === true),
      duckingListening: voiceEligible && this.phase === null,
      inputText: this.inputText,
      foregroundActive: this.promptOpen || this.invocation.active(),
      passive: !this.promptOpen && !this.invocation.active(),
      notice: this.controlNotice,
      muted: this.muted,
      error: !!this.failure || this.routeUncertain,
      busy:
        this.stopping ||
        this.unconfirmedStop ||
        this.phase === 'transcribing' ||
        this.phase === 'speaking' ||
        this.playback.busy(),
      status:
        this.failure ||
        this.controlNotice ||
        (this.routeUncertain
          ? 'Conversation state is uncertain. Refresh it in the menu before voice resumes.'
          : '') ||
        (this.phase === 'transcribing'
          ? 'Recognizing locally'
          : this.playback.busy()
            ? 'Speaking locally'
            : this.phase === 'waiting'
              ? 'Waiting for Ivy'
              : this.phase === 'speaking'
                ? 'Speaking locally'
                : context?.audio.status === 'capturing'
                  ? this.invocation.active() ||
                    this.composition.status !== 'idle'
                    ? 'Local voice listening'
                    : 'Listening for Ivy'
                  : 'Local voice idle'),
    });
  }
}
