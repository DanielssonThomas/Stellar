import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import type {
  SpeechSnapshot,
  WorkspaceToolRequest,
} from '@stellar/desktop-contracts';
import {
  directSpatialAction,
  initialSpatialState,
  type SpatialAction,
  type SpatialScene,
} from '@stellar/desktop-interaction';
import {
  IvyAdapterService,
  SpeechAdapterService,
  SpatialNarration,
  type SpatialNarrationMode,
} from '@stellar/service-desktop-adapter';
import { decodeSpatialScore, STAGE_CATALOGUE } from '@stellar/ui-organisms';
import { morningAiBriefing } from './morning-ai-briefing';

@Injectable()
export class DesktopSpatial {
  private readonly speech = inject(SpeechAdapterService);
  private readonly ivy = inject(IvyAdapterService);
  private readonly catalogue = inject(STAGE_CATALOGUE);
  private readonly currentScene = signal<SpatialScene | null>(null);
  private readonly currentState = signal(initialSpatialState);
  private readonly playback = signal<{
    mode: SpatialNarrationMode;
    caption: string;
  }>({ mode: 'idle', caption: '' });
  private readonly spoken = signal<readonly string[]>([]);
  readonly transcript = this.spoken.asReadonly();
  private owner?: { epoch: string; turn: string };
  private stoppedTurn?: string;
  private muted = false;
  readonly scene = this.currentScene.asReadonly();
  readonly state = this.currentState.asReadonly();
  readonly narration = this.playback.asReadonly();
  private readonly timeline = new SpatialNarration<SpatialAction>({
    initialize: () =>
      this.muted ? Promise.reject() : this.speech.initialize(),
    read: () => this.speech.state(),
    speak: (text, id) => this.speech.speak(text, id),
    stop: () => this.speech.stop(),
    id: () => crypto.randomUUID(),
    apply: (actions) => this.apply(actions, 'ivy'),
    record: (text) =>
      this.spoken.update((segments) => [...segments.slice(-47), text]),
    view: (mode, caption) =>
      this.playback.update((current) =>
        current.mode === mode && current.caption === caption
          ? current
          : { mode, caption },
      ),
  });

  constructor() {
    effect(() => {
      const assistant = this.ivy.state();
      const snapshot = this.speech.state();
      untracked(() => {
        const owner = this.owner;
        if (
          owner &&
          (assistant.connection !== 'ready' ||
            assistant.workspace_epoch !== owner.epoch ||
            assistant.turn_id !== owner.turn ||
            !['submitting', 'admitted', 'completed'].includes(assistant.turn))
        ) {
          this.owner = undefined;
          this.timeline.cancel();
        }
        this.timeline.observe(snapshot);
      });
    });
    inject(DestroyRef).onDestroy(() => this.timeline.cancel());
  }

  startSample() {
    this.submit(morningAiBriefing);
  }

  accept(request: WorkspaceToolRequest): boolean {
    if (request.operation.kind !== 'present') return false;
    try {
      const { epoch, turn_id } = request;
      return this.submit(JSON.parse(request.operation.score_json), {
        epoch,
        turn: turn_id,
      });
    } catch {
      return false;
    }
  }

  manual(action: SpatialAction) {
    this.apply([action], 'user');
  }

  follow() {
    this.currentState.update((state) => ({ ...state, manual: false }));
  }

  next() {
    this.timeline.next();
  }

  toggleReadAlong() {
    this.timeline.toggleReadAlong();
  }

  interrupt() {
    if (this.owner) this.stoppedTurn = this.owner.turn;
    this.timeline.cancel();
  }

  close() {
    this.interrupt();
    this.currentState.set(initialSpatialState);
    this.currentScene.set(null);
    this.spoken.set([]);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted && ['preparing', 'speaking'].includes(this.playback().mode))
      this.interrupt();
  }

  ownsSpeech(snapshot: SpeechSnapshot) {
    return this.timeline.ownsSpeech(snapshot);
  }

  whenQuiet() {
    return this.timeline.whenQuiet();
  }

  private submit(
    value: unknown,
    owner?: { epoch: string; turn: string },
  ): boolean {
    const score = decodeSpatialScore(value, this.catalogue);
    if (!score || (!score.begin && !this.scene())) return false;
    if (score.begin && owner && owner.turn === this.stoppedTurn) return false;
    const segments =
      owner?.turn === this.stoppedTurn && this.stoppedTurn !== undefined
        ? []
        : (score.segments ?? []);
    if (!score.begin && !this.timeline.canAppend(segments.length)) return false;
    if (score.begin || (owner && owner.turn !== this.owner?.turn))
      this.timeline.cancel();
    if (score.begin) {
      this.currentState.set(initialSpatialState);
      this.spoken.set([]);
      this.currentScene.set(score.begin);
    }
    this.owner = owner;
    this.apply(score.prepare ?? [], 'ivy');
    if (this.scene()) this.timeline.append(segments);
    return true;
  }

  private apply(actions: readonly SpatialAction[], origin: 'user' | 'ivy') {
    for (const action of actions) {
      if (action.kind === 'clear') {
        this.close();
        return;
      }
      this.currentState.update((state) =>
        directSpatialAction(state, action, origin),
      );
    }
  }
}
