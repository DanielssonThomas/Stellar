import { describe, expect, it } from 'vitest';
import {
  initialStageLocalActionCueState,
  reduceStageLocalActionCue,
  STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS,
} from './stage-local-action-cue';

const confirmed = (id: string) => ({
  type: 'receipt' as const,
  receipt: { id, status: 'confirmed' as const, action: 'Saved note' },
});
const optIn = (state = initialStageLocalActionCueState) =>
  reduceStageLocalActionCue(state, { type: 'set-opt-in', enabled: true }, 100);

describe('stage local action cue reducer', () => {
  it('shows only opted-in confirmed receipts and bounds cue lifetime by the passed clock', () => {
    const optedIn = optIn();
    const shown = reduceStageLocalActionCue(optedIn, confirmed('r1'), 250);
    expect(shown.cue).toEqual({
      receiptId: 'r1',
      action: 'Saved note',
      expiresAt: 250 + STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS,
    });
    expect(
      reduceStageLocalActionCue(shown, { type: 'briefing', active: false }, 251)
        .cue,
    ).not.toBeNull();
    expect(
      reduceStageLocalActionCue(shown, { type: 'manual-focus' }, 251).cue,
    ).toBeNull();
    expect(
      reduceStageLocalActionCue(
        shown,
        { type: 'set-opt-in', enabled: true },
        251 + STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS,
      ).cue,
    ).toBeNull();
    expect(
      reduceStageLocalActionCue(
        initialStageLocalActionCueState,
        confirmed('r0'),
        1,
      ).cue,
    ).toBeNull();
  });

  it('suppresses failed, absent and provisional receipts and deduplicates confirmed receipts', () => {
    let state = optIn();
    for (const status of ['failed', 'missing', 'provisional'] as const) {
      state = reduceStageLocalActionCue(
        state,
        { type: 'receipt', receipt: { id: status, status, action: 'Ignored' } },
        200,
      );
      expect(state.cue).toBeNull();
    }
    state = reduceStageLocalActionCue(state, confirmed('same'), 300);
    const duplicate = reduceStageLocalActionCue(state, confirmed('same'), 400);
    expect(duplicate).toBe(state);
    expect(duplicate.cue?.expiresAt).toBe(
      300 + STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS,
    );
    expect(duplicate.seenReceiptIds).toEqual(['same']);
  });

  it('clears on opt-out, manual focus, or activation of a briefing', () => {
    const shown = reduceStageLocalActionCue(optIn(), confirmed('r1'), 200);
    expect(
      reduceStageLocalActionCue(
        shown,
        { type: 'set-opt-in', enabled: false },
        201,
      ),
    ).toMatchObject({ optedIn: false, cue: null });
    expect(
      reduceStageLocalActionCue(shown, { type: 'manual-focus' }, 201).cue,
    ).toBeNull();
    expect(
      reduceStageLocalActionCue(shown, { type: 'briefing', active: true }, 201)
        .cue,
    ).toBeNull();
  });

  it('suppresses receipts through overlapping focus and briefing obstructions until both end', () => {
    let state = reduceStageLocalActionCue(
      optIn(),
      { type: 'focus-obstruction', active: true },
      150,
    );
    state = reduceStageLocalActionCue(
      state,
      { type: 'briefing', active: true },
      151,
    );
    state = reduceStageLocalActionCue(state, confirmed('hidden-focus'), 152);
    expect(state.cue).toBeNull();
    state = reduceStageLocalActionCue(
      state,
      { type: 'focus-obstruction', active: false },
      153,
    );
    state = reduceStageLocalActionCue(state, confirmed('hidden-briefing'), 154);
    expect(state.cue).toBeNull();
    state = reduceStageLocalActionCue(
      state,
      { type: 'briefing', active: false },
      155,
    );
    expect(
      reduceStageLocalActionCue(state, confirmed('visible-again'), 156).cue,
    ).not.toBeNull();
    expect(
      reduceStageLocalActionCue(state, confirmed('hidden-focus'), 157).cue,
    ).toBeNull();
  });

  it('preserves active obstruction across opt-out and re-enable and expires a cue at its deadline', () => {
    let state = reduceStageLocalActionCue(
      optIn(),
      { type: 'briefing', active: true },
      150,
    );
    state = reduceStageLocalActionCue(
      state,
      { type: 'set-opt-in', enabled: false },
      151,
    );
    state = reduceStageLocalActionCue(
      state,
      { type: 'set-opt-in', enabled: true },
      152,
    );
    expect(
      reduceStageLocalActionCue(state, confirmed('still-hidden'), 153).cue,
    ).toBeNull();
    state = reduceStageLocalActionCue(
      state,
      { type: 'briefing', active: false },
      154,
    );
    state = reduceStageLocalActionCue(state, confirmed('expires'), 200);
    expect(
      reduceStageLocalActionCue(
        state,
        { type: 'focus-obstruction', active: false },
        200 + STAGE_LOCAL_ACTION_CUE_MAX_LIFETIME_MS,
      ).cue,
    ).toBeNull();
  });
});
