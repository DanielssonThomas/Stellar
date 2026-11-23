export const STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS = 8_000;

export type StageLocalActionCueReceipt = {
  id: string;
  status: 'confirmed' | 'failed' | 'missing' | 'provisional';
  action: string;
};

export type StageLocalActionCueState = {
  optedIn: boolean;
  focusObstructed: boolean;
  briefingActive: boolean;
  cue: { receiptId: string; action: string; expiresAt: number } | null;
  seenReceiptIds: readonly string[];
};

export type StageLocalActionCueEvent =
  | { type: 'set-opt-in'; enabled: boolean }
  | { type: 'manual-focus' }
  | { type: 'focus-obstruction'; active: boolean }
  | { type: 'briefing'; active: boolean }
  | { type: 'receipt'; receipt: StageLocalActionCueReceipt };

export const initialStageLocalActionCueState: StageLocalActionCueState = {
  optedIn: false,
  focusObstructed: false,
  briefingActive: false,
  cue: null,
  seenReceiptIds: [],
};

/** Reduce confirmed local-action receipts into a transient, opt-in visual cue. */
export function reduceStageLocalActionCue(
  state: StageLocalActionCueState,
  event: StageLocalActionCueEvent,
  now: number,
): StageLocalActionCueState {
  const current = state.cue && now < state.cue.expiresAt ? state.cue : null;
  const normalized = current === state.cue ? state : { ...state, cue: current };

  if (event.type === 'set-opt-in')
    return event.enabled
      ? { ...normalized, optedIn: true }
      : { ...normalized, optedIn: false, cue: null };
  if (event.type === 'manual-focus' || event.type === 'focus-obstruction') {
    const active = event.type === 'manual-focus' || event.active;
    return {
      ...normalized,
      focusObstructed: active,
      cue: active ? null : normalized.cue,
    };
  }
  if (event.type === 'briefing')
    return {
      ...normalized,
      briefingActive: event.active,
      cue: event.active ? null : normalized.cue,
    };

  const { receipt } = event;
  if (
    receipt.status !== 'confirmed' ||
    !receipt.id ||
    !receipt.action ||
    normalized.seenReceiptIds.includes(receipt.id)
  )
    return normalized;

  const seenState = {
    ...normalized,
    seenReceiptIds: [...normalized.seenReceiptIds, receipt.id],
  };
  if (
    !normalized.optedIn ||
    normalized.focusObstructed ||
    normalized.briefingActive
  )
    return seenState;

  return {
    ...seenState,
    cue: {
      receiptId: receipt.id,
      action: receipt.action,
      expiresAt: now + STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS,
    },
  };
}
