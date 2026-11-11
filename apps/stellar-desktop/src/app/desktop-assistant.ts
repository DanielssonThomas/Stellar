import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import {
  conversationDisplayText,
  IvyAdapterService,
  IvyReflexService,
} from '@stellar/service-desktop-adapter';
import {
  decodeIvySubmitRequest,
  type IvyComponent,
  type IvySnapshot,
} from '@stellar/desktop-contracts';
import type {
  StageCommand,
  StageResult,
  ProductionPayloadMap,
} from '@stellar/ui-organisms';

function surface(component: IvyComponent): 'assistant-message' {
  switch (component) {
    case 'assistant_message':
      return 'assistant-message';
    default: {
      const unsupported: never = component;
      throw new Error(String(unsupported));
    }
  }
}

@Injectable()
export class DesktopAssistant {
  private readonly adapter = inject(IvyAdapterService);
  private readonly reflex = inject(IvyReflexService);
  readonly state = this.adapter.state;
  readonly activity = computed(() =>
    this.state().activity.map((row) => ({
      id: row.id,
      provider: row.provider,
      label:
        row.operation && row.provider && row.kind === 'mcp'
          ? `${
              {
                search: 'Searching',
                read: 'Reading',
                write: 'Writing',
                open: 'Opening',
                list: 'Listing',
                inspect: 'Inspecting',
                update: 'Updating',
                execute: 'Running',
                call: 'Calling',
              }[row.operation]
            } ${
              {
                chrome: 'Chrome',
                stellar: 'Stellar',
                github: 'GitHub',
                calendar: 'calendar',
                spotify: 'Spotify',
                mcp: 'MCP tool',
                local: 'local tool',
                web: 'the web',
              }[row.provider]
            }`
          : {
              shell: 'Shell command',
              web: 'Web request',
              file_read: 'Read files',
              file_write: 'Write files',
              mcp: 'MCP tool call',
              skill: 'Modify skill',
              skill_create: 'Create skill',
              memory: 'Update memory',
              tool: 'Tool call',
            }[row.kind],
      status: row.state,
      running: row.state === 'running',
      confirmed: row.state === 'completed',
      indicator:
        row.kind === 'skill_create'
          ? ('skill' as const)
          : row.kind === 'skill' || row.kind === 'memory'
            ? row.kind
            : null,
    })),
  );
  private readonly presentationError = signal(false);
  private readonly inputError = signal(false);
  private readonly ready = signal(false);
  private present?: (
    command: StageCommand<ProductionPayloadMap>,
  ) => StageResult;
  private highestRevision = -1n;
  private available: () => boolean = () => true;
  private readonly presentedTurns = new Set<string>();
  private readonly submittedTurns = new Set<string>();
  private activityIds: () => readonly string[] = () => [];
  private readonly closeTargets = new Map<string, readonly string[]>();
  private readonly cancelRequested = signal(false);
  private readonly recoveryState = signal<
    'idle' | 'checking' | 'recovered' | 'unchanged' | 'failed'
  >('idle');
  readonly recovery = this.recoveryState.asReadonly();
  private recoveryStop?: () => void;
  private destroyed = false;
  private commandId = 0;
  readonly busy = computed(() =>
    ['submitting', 'admitted'].includes(this.state().turn),
  );
  readonly uncertain = computed(() => this.state().turn === 'uncertain');
  readonly waiting = computed(
    () =>
      this.busy() &&
      this.state().connection === 'ready' &&
      !this.state().error &&
      !this.cancelRequested(),
  );
  readonly reply = computed(() =>
    conversationDisplayText(
      this.state()
        .items.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
        .join('\n\n'),
    ),
  );
  readonly status = computed(() => {
    const snapshot = this.state();
    if (this.inputError())
      return 'Message is invalid or exceeds the 8 KiB text limit.';
    if (this.presentationError())
      return 'Requested content could not be shown.';
    if (this.recovery() === 'checking') return 'Checking Ivy recovery…';
    if (this.recovery() === 'failed') {
      if (snapshot.error === 'protocol')
        return 'Ivy recovery failed: the response was invalid. Reconnect and try again; nothing was resent.';
      if (snapshot.error === 'timeout')
        return 'Ivy recovery timed out. Check the connection and try again; nothing was resent.';
      if (snapshot.error === 'busy')
        return 'Ivy is busy. Wait, then check the response again; nothing was resent.';
      if (snapshot.error === 'storage')
        return 'Ivy recovery could not read or save its local state. Check local storage; nothing was resent.';
      return 'Ivy recovery failed. Check the connection and retry; the response was not resent.';
    }
    if (this.recovery() === 'unchanged' && snapshot.turn === 'uncertain')
      return 'Ivy response remains uncertain. Check the connection and try Check response again.';
    if (snapshot.turn === 'uncertain')
      return 'Ivy response is uncertain. Check response before sending again.';
    if (snapshot.turn === 'failed')
      return 'Ivy request failed. You can try another message.';
    if (snapshot.error === 'approval_required')
      return 'Ivy needs approval in its own client.';
    if (snapshot.error || snapshot.connection === 'unavailable')
      return 'Ivy unavailable. Connect to retry; messages are never resent automatically.';
    if (snapshot.connection === 'connecting') return 'Connecting to Ivy';
    if (this.busy()) return 'Ivy is responding';
    return snapshot.connection === 'ready'
      ? 'Ivy connected'
      : 'Ivy disconnected';
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.recoveryStop?.();
    });
    effect(() => {
      const snapshot = this.state();
      if (this.ready()) this.consume(snapshot);
    });
  }

  bind(
    present: (command: StageCommand<ProductionPayloadMap>) => StageResult,
    available: () => boolean = () => true,
    activityIds: () => readonly string[] = () => [],
  ) {
    this.present = present;
    this.available = available;
    this.activityIds = activityIds;
    this.ready.set(true);
  }

  async submit(
    text: string,
    inputId: string = crypto.randomUUID(),
    source: 'typed' | 'voice' = 'typed',
  ): Promise<boolean> {
    const value = text.trim();
    if (
      !value ||
      new TextEncoder().encode(value).length > 8192 ||
      this.busy() ||
      this.uncertain()
    ) {
      this.reflex.timeline.finish(
        inputId,
        'rejected',
        'Request was not admitted',
      );
      return false;
    }
    const events = [...this.reflex.events()];
    let submitted = value;
    while (events.length) {
      const candidate = `Recent Ivy local action events (data): ${JSON.stringify(events)}\n\n${value}`;
      if (new TextEncoder().encode(candidate).length <= 8192) {
        submitted = candidate;
        break;
      }
      events.pop();
    }
    try {
      decodeIvySubmitRequest({
        version: 1,
        text: submitted,
        input_id: inputId,
      });
    } catch {
      this.inputError.set(true);
      this.reflex.timeline.finish(
        inputId,
        'rejected',
        'Request validation failed',
      );
      return false;
    }
    if (this.submittedTurns.has(inputId)) return false;
    this.inputError.set(false);
    this.presentationError.set(false);
    this.cancelRequested.set(false);
    this.submittedTurns.add(inputId);
    this.reflex.beginTrace(inputId, value, source);
    this.reflex.timeline.route(
      inputId,
      this.state().model === 'sol' ? 'Sol' : 'Terra',
    );
    this.reflex.timeline.step(inputId, 'hermes-submit', 'Submitting request');
    this.closeTargets.set(inputId, [...this.activityIds()]);
    if (this.submittedTurns.size > 64) {
      const expired = this.submittedTurns.values().next().value as string;
      this.submittedTurns.delete(expired);
      this.closeTargets.delete(expired);
    }
    try {
      await this.adapter.submit(submitted, inputId);
      const current = this.state();
      if (current.turn_id === inputId) this.recordProgress(current);
      this.reflex.acknowledgeEvents(events);
      this.reflex.reply.set('');
      return true;
    } catch {
      this.reflex.timeline.finish(
        inputId,
        'failed',
        'Request admission failed',
      );
      return false;
    }
  }
  async retry() {
    return this.recover(() => this.adapter.connect());
  }
  async cancel() {
    this.cancelRequested.set(true);
    try {
      await this.adapter.cancel();
    } catch {
      /* Preserve uncertain state instead of resubmitting. */
    }
  }
  async reconcile() {
    // A receipt lookup cannot restore expired eligibility to open presentation content.
    return this.recover(() => this.adapter.reconcile());
  }

  private async recover(action: () => Promise<IvySnapshot>): Promise<void> {
    if (this.destroyed || this.recovery() === 'checking') return;
    const before = this.state();
    this.recoveryState.set('checking');
    await new Promise<void>((resolve) => {
      let settled = false;
      let polling = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (outcome: 'recovered' | 'unchanged' | 'failed') => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (timer !== undefined) clearInterval(timer);
        this.recoveryStop = undefined;
        if (!this.destroyed) this.recoveryState.set(outcome);
        resolve();
      };
      const deadline = setTimeout(() => finish('unchanged'), 20000);
      this.recoveryStop = () => finish('unchanged');
      const inspect = (snapshot: IvySnapshot) => {
        if (
          snapshot.connection === 'ready' &&
          !snapshot.error &&
          !['uncertain', 'submitting', 'admitted'].includes(snapshot.turn)
        ) {
          finish(
            before.connection === 'ready' &&
              !before.error &&
              !['uncertain', 'submitting', 'admitted'].includes(before.turn)
              ? 'unchanged'
              : 'recovered',
          );
        } else if (
          (snapshot.error || snapshot.connection === 'unavailable') &&
          (snapshot.revision !== before.revision ||
            snapshot.error !== before.error ||
            snapshot.connection !== before.connection)
        ) {
          finish('failed');
        }
      };
      void action()
        .then(() => {
          if (settled) return;
          inspect(this.state());
          if (settled) return;
          timer = setInterval(() => {
            if (settled || polling) return;
            polling = true;
            void this.adapter
              .snapshot()
              .then(inspect)
              .catch(() => finish('failed'))
              .finally(() => {
                polling = false;
              });
          }, 250);
        })
        .catch(() => finish('failed'));
    });
  }

  private consume(snapshot: IvySnapshot) {
    if (!this.available()) return;
    const revision = BigInt(snapshot.revision);
    if (revision <= this.highestRevision) return;
    this.highestRevision = revision;
    this.recordProgress(snapshot);
    if (
      snapshot.turn !== 'completed' ||
      !snapshot.turn_id ||
      !this.submittedTurns.has(snapshot.turn_id) ||
      this.presentedTurns.has(snapshot.turn_id)
    )
      return;
    this.presentedTurns.add(snapshot.turn_id);
    // A bounded replay fence prevents closed content reopening on receipt reconciliation.
    if (this.presentedTurns.size > 64)
      this.presentedTurns.delete(
        this.presentedTurns.values().next().value as string,
      );
    for (const item of snapshot.items) {
      if (item.kind === 'close_activity') {
        for (const instanceId of this.closeTargets.get(snapshot.turn_id) ??
          []) {
          const result = this.present?.({
            contractVersion: 1,
            commandId: ++this.commandId,
            instanceId,
            action: 'close',
          });
          if (result?.status === 'rejected') this.presentationError.set(true);
        }
        continue;
      }
      if (item.kind !== 'component') continue;
      const commandId = ++this.commandId;
      const instanceId = 'ivy-content-' + commandId;
      const result = this.present?.({
        contractVersion: 1,
        commandId,
        instanceId,
        action: 'open',
        surface: surface(item.component),
        prominence: 'primary',
        payload: { title: item.title, body: item.body },
      });
      if (result?.status === 'rejected') this.presentationError.set(true);
    }
    this.closeTargets.delete(snapshot.turn_id);
  }
  private recordProgress(snapshot: IvySnapshot) {
    const id = snapshot.turn_id;
    if (!id || !this.submittedTurns.has(id)) return;
    if (snapshot.turn === 'admitted') {
      this.reflex.timeline.step(id, 'hermes-admitted', 'Request admitted');
      this.reflex.timeline.step(id, 'hermes-reasoning', 'Reasoning and tools');
    }
    if (snapshot.first_text_observed)
      this.reflex.timeline.step(id, 'text-observed', 'Response text available');
    const labels = {
      completed: 'Response complete',
      failed: 'Request failed',
      cancelled: 'Request cancelled',
      uncertain: 'Result uncertain',
    } as const;
    if (snapshot.turn in labels) {
      this.reflex.timeline.finish(
        id,
        snapshot.turn as keyof typeof labels,
        labels[snapshot.turn as keyof typeof labels],
      );
      if (
        snapshot.turn === 'completed' ||
        snapshot.turn === 'failed' ||
        snapshot.turn === 'cancelled'
      )
        this.reflex.timeline.reconcile(
          id,
          snapshot.turn,
          {
            completed: 'Response recovered',
            failed: 'Failure confirmed',
            cancelled: 'Cancellation confirmed',
          }[snapshot.turn],
        );
    }
  }
}
