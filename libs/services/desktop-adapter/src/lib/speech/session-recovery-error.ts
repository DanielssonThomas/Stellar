import { IvyAdapterError } from '../ivy/ivy-adapter';
import { decodeIvyError, type IvyErrorCode } from '@stellar/desktop-contracts';

export type RecoveryStage =
  | 'capture_guard'
  | 'capture_release'
  | 'context_recheck'
  | 'native_load';
export type RecoveryCode =
  | 'context_unavailable'
  | 'assistant_unavailable'
  | 'assistant_busy'
  | 'voice_busy'
  | 'recognition_unavailable'
  | 'speech_busy'
  | 'capture_stop_unconfirmed'
  | 'dispatch_pending'
  | 'dispatch_uncertain'
  | 'route_uncertain'
  | 'cancelled'
  | 'unconfirmed'
  | IvyErrorCode;

/** Fixed local stages and native enum codes only; never forward exception details. */
export class SessionRecoveryError extends Error {
  constructor(
    readonly stage: RecoveryStage,
    readonly code: RecoveryCode,
  ) {
    const next = ['busy', 'assistant_busy', 'approval_required'].includes(code)
      ? 'Finish the active turn or approval in its owning client.'
      : ['voice_busy', 'speech_busy', 'capture_stop_unconfirmed'].includes(code)
        ? 'Finish or stop existing voice work first.'
        : [
              'context_unavailable',
              'assistant_unavailable',
              'unavailable',
            ].includes(code)
          ? 'Reconnect and refresh session details.'
          : 'Inspect pending work before another recovery; do not replay a prompt.';
    super(
      `Recovery stopped (${stage} / ${code}). ${next} Conversation preserved.`,
    );
  }

  static from(stage: RecoveryStage, error: unknown): SessionRecoveryError {
    if (error instanceof SessionRecoveryError) return error;
    if (error instanceof IvyAdapterError) {
      try {
        return new SessionRecoveryError(stage, decodeIvyError(error.code));
      } catch {
        /* Unknown codes stay private. */
      }
    }
    return new SessionRecoveryError(
      stage,
      stage === 'native_load' ? 'uncertain' : 'unavailable',
    );
  }
}
