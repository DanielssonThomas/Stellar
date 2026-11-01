import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { IvyAdapterService } from '@stellar/service-desktop-adapter';
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
  readonly state = this.adapter.state;
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
  private commandId = 0;
  readonly busy = computed(() =>
    ['submitting', 'admitted'].includes(this.state().turn),
  );
  readonly uncertain = computed(() => this.state().turn === 'uncertain');
  readonly reply = computed(() =>
    this.state()
      .items.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
      .join('\n\n'),
  );
  readonly status = computed(() => {
    const snapshot = this.state();
    if (this.inputError())
      return 'Message is invalid or exceeds the 8 KiB text limit.';
    if (this.presentationError())
      return 'Requested content could not be shown.';
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
    effect(() => {
      const snapshot = this.state();
      if (this.ready()) this.consume(snapshot);
    });
  }

  bind(
    present: (command: StageCommand<ProductionPayloadMap>) => StageResult,
    available: () => boolean = () => true,
  ) {
    this.present = present;
    this.available = available;
    this.ready.set(true);
  }

  async submit(
    text: string,
    inputId: string = crypto.randomUUID(),
  ): Promise<boolean> {
    const value = text.trim();
    if (
      !value ||
      new TextEncoder().encode(value).length > 8192 ||
      this.busy() ||
      this.uncertain()
    )
      return false;
    try {
      decodeIvySubmitRequest({ version: 1, text: value, input_id: inputId });
    } catch {
      this.inputError.set(true);
      return false;
    }
    if (this.submittedTurns.has(inputId)) return false;
    this.inputError.set(false);
    this.presentationError.set(false);
    this.submittedTurns.add(inputId);
    if (this.submittedTurns.size > 64)
      this.submittedTurns.delete(
        this.submittedTurns.values().next().value as string,
      );
    try {
      await this.adapter.submit(value, inputId);
      return true;
    } catch {
      return false;
    }
  }
  async retry() {
    try {
      await this.adapter.connect();
    } catch {
      return;
    }
  }
  async cancel() {
    try {
      await this.adapter.cancel();
    } catch {
      /* Preserve uncertain state instead of resubmitting. */
    }
  }
  async reconcile() {
    // A receipt lookup cannot restore expired eligibility to open presentation content.
    try {
      await this.adapter.reconcile();
    } catch {
      return;
    }
  }

  private consume(snapshot: IvySnapshot) {
    if (!this.available()) return;
    const revision = BigInt(snapshot.revision);
    if (revision <= this.highestRevision) return;
    this.highestRevision = revision;
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
      if (item.kind !== 'component') continue;
      const commandId = ++this.commandId;
      const result = this.present?.({
        contractVersion: 1,
        commandId,
        instanceId: 'ivy-content-' + commandId,
        action: 'open',
        surface: surface(item.component),
        prominence: 'primary',
        payload: { title: item.title, body: item.body },
      });
      if (result?.status === 'rejected') this.presentationError.set(true);
    }
  }
}
