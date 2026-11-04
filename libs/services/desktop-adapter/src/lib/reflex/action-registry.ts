import type {
  ReflexChoice,
  ReflexMediaResult,
} from '@stellar/desktop-contracts';

export interface LocalAction {
  readonly id: string;
  readonly description: string;
  readonly valid: () => boolean;
  readonly execute: (
    inputId: string,
  ) => Promise<ReflexMediaResult> | ReflexMediaResult;
}

/** Request-scoped capabilities: parameters are application-owned closures, never model output. */
export class LocalActionRegistry {
  private readonly entries = new Map<string, LocalAction>();
  private dispatched = false;

  constructor(actions: readonly LocalAction[]) {
    if (actions.length > 96) throw new Error('Too many local actions');
    for (const action of actions) {
      if (
        !/^[\w.:-]{1,96}$/.test(action.id) ||
        this.entries.has(action.id) ||
        new TextEncoder().encode(action.description).length > 240
      )
        throw new Error('Invalid local action');
      this.entries.set(action.id, action);
    }
  }

  choices(): ReflexChoice[] {
    return [...this.entries.values()]
      .filter((a) => a.valid())
      .map(({ id, description }) => ({ id, description }));
  }
  describe(id: string): string {
    return this.entries.get(id)?.description ?? id;
  }

  async dispatch(
    id: string,
    inputId: string,
    signal: AbortSignal,
  ): Promise<ReflexMediaResult> {
    const entry = this.entries.get(id);
    if (this.dispatched || signal.aborted || !entry?.valid()) return 'rejected';
    this.dispatched = true;
    // No asynchronous work separates the final validation from calling the executor.
    try {
      return await entry.execute(inputId);
    } catch {
      return 'uncertain';
    }
  }
}
