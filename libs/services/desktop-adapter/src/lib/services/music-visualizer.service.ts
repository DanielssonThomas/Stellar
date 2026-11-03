import {
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import {
  decodeMusicSnapshot,
  type MusicLevels,
  type MusicSnapshot,
} from '@stellar/desktop-contracts';
import {
  musicTransport,
  type MusicNativeApi,
  type MusicTransport,
} from '../music/music-transport';

export const MUSIC_TRANSPORT = new InjectionToken<MusicTransport>(
  'MusicTransport',
  {
    providedIn: 'root',
    factory: () =>
      musicTransport(
        (globalThis as typeof globalThis & { __TAURI__?: MusicNativeApi })
          .__TAURI__,
      ),
  },
);
const zero = (): MusicLevels => ({ level: 0, bass: 0, mid: 0, treble: 0 });

@Injectable()
export class MusicVisualizerService {
  private readonly transport = inject(MUSIC_TRANSPORT);
  private readonly document = inject(DOCUMENT);
  readonly enabled = signal(false);
  readonly sensitivity = signal<MusicLevels>({
    level: 1,
    bass: 1,
    mid: 1,
    treble: 1,
  });
  private readonly snapshot = signal<MusicSnapshot>({
    version: 1,
    sequence: '0',
    status: 'idle',
    levels: zero(),
    tone: null,
  });
  readonly status = computed(
    () =>
      ({
        idle: 'Music visualizer off',
        starting: 'Connecting to desktop audio…',
        capturing: 'Listening to desktop audio',
        unavailable: 'Desktop audio unavailable. Try again.',
      })[this.snapshot().status],
  );
  readonly levels = computed(() => {
    const value = this.snapshot().levels;
    const sensitivity = this.sensitivity();
    const gain = (level: number, band = 1) =>
      Math.min(1, level * sensitivity.level * band);
    return this.enabled()
      ? {
          level: gain(value.level),
          bass: gain(value.bass, sensitivity.bass),
          mid: gain(value.mid, sensitivity.mid),
          treble: gain(value.treble, sensitivity.treble),
        }
      : zero();
  });
  readonly tone = computed(() =>
    this.enabled() && this.levels().level > 0 ? this.snapshot().tone : null,
  );
  private disposed = false;
  private generation = 0;
  private highest = -1n;
  private accepting = false;
  private pendingStart: {
    readonly generation: number;
    latest?: MusicSnapshot;
  } | null = null;
  private tail: Promise<void> = Promise.resolve();
  private subscription?: Promise<() => void>;
  private staleTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    const hidden = () => {
      if (this.document.visibilityState === 'hidden') this.setEnabled(false);
    };
    const stop = () => this.setEnabled(false);
    this.document.addEventListener('visibilitychange', hidden);
    this.document.defaultView?.addEventListener('pagehide', stop);
    inject(DestroyRef).onDestroy(() => {
      this.setEnabled(false);
      this.disposed = true;
      this.document.removeEventListener('visibilitychange', hidden);
      this.document.defaultView?.removeEventListener('pagehide', stop);
      clearTimeout(this.staleTimer);
      void this.subscription
        ?.then((unsubscribe) => unsubscribe())
        .catch(() => undefined);
    });
  }

  setSensitivity(band: keyof MusicLevels, value: number) {
    if (!Object.hasOwn(this.sensitivity(), band) || !Number.isFinite(value))
      return;
    this.sensitivity.update((current) => ({
      ...current,
      [band]: Math.max(0, Math.min(3, value)),
    }));
  }

  setEnabled(enabled: boolean) {
    if (
      this.disposed ||
      (enabled && this.document.visibilityState === 'hidden')
    )
      return;
    const generation = ++this.generation;
    this.enabled.set(enabled);
    this.accepting = false;
    this.pendingStart = null;
    clearTimeout(this.staleTimer);
    this.snapshot.update((current) => ({
      ...current,
      status: enabled ? 'starting' : 'idle',
      levels: zero(),
      tone: null,
    }));
    this.tail = this.tail.then(async () => {
      try {
        if (enabled) {
          this.subscription ??= this.transport
            .listen((payload) => {
              if (!this.enabled() || this.disposed) return;
              const pending = this.pendingStart;
              if (!this.accepting && pending?.generation !== this.generation)
                return;
              try {
                const snapshot = decodeMusicSnapshot(payload);
                if (this.accepting) this.accept(snapshot);
                else if (
                  pending &&
                  (!pending.latest ||
                    BigInt(snapshot.sequence) > BigInt(pending.latest.sequence))
                )
                  pending.latest = snapshot;
              } catch {
                this.setEnabled(false);
              }
            })
            .catch((error) => {
              this.subscription = undefined;
              throw error;
            });
          await this.subscription;
          if (generation !== this.generation || this.disposed) return;
        }
        if (enabled) this.pendingStart = { generation };
        const snapshot = decodeMusicSnapshot(
          await this.transport.setEnabled({ version: 1, enabled }),
        );
        if (generation !== this.generation || this.disposed) return;
        const early = this.pendingStart?.latest;
        this.pendingStart = null;
        this.accept(snapshot);
        if (early) this.accept(early);
        this.accepting = enabled && this.enabled();
      } catch {
        if (generation !== this.generation || this.disposed) return;
        this.pendingStart = null;
        this.enabled.set(false);
        this.snapshot.update((current) => ({
          ...current,
          status: 'unavailable',
          levels: zero(),
          tone: null,
        }));
      }
    });
  }

  private accept(snapshot: MusicSnapshot) {
    const revision = BigInt(snapshot.sequence);
    if (revision <= this.highest) return;
    this.highest = revision;
    this.snapshot.set(snapshot);
    clearTimeout(this.staleTimer);
    if (snapshot.status === 'capturing')
      this.staleTimer = setTimeout(() => {
        this.snapshot.update((current) => ({
          ...current,
          levels: zero(),
          tone: null,
        }));
      }, 350);
    if (snapshot.status === 'unavailable' || snapshot.status === 'idle')
      this.enabled.set(false);
  }
}
