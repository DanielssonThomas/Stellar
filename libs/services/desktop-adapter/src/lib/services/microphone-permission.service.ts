import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import {
  decodeMicrophoneReviewReply,
  microphoneReviewCommand,
  type MicrophoneReviewRequest,
} from '@stellar/desktop-contracts';

export interface MicrophonePermissionTransport {
  review(request: MicrophoneReviewRequest): Promise<unknown>;
}
export const MICROPHONE_PERMISSION_TRANSPORT =
  new InjectionToken<MicrophonePermissionTransport>(
    'MicrophonePermissionTransport',
    {
      providedIn: 'root',
      factory: () => ({
        review: (request) => {
          const api = (
            globalThis as typeof globalThis & {
              __TAURI__?: {
                core: {
                  invoke(
                    command: string,
                    args: { request: MicrophoneReviewRequest },
                  ): Promise<unknown>;
                };
              };
            }
          ).__TAURI__;
          return api
            ? api.core.invoke(microphoneReviewCommand, { request })
            : Promise.reject('unsupported');
        },
      }),
    },
  );

@Injectable({ providedIn: 'root' })
export class MicrophonePermissionService {
  private readonly transport = inject(MICROPHONE_PERMISSION_TRANSPORT);
  private disposed = false;
  readonly pending = signal(false);
  readonly message = signal(
    'Microphone access can be blocked by this app’s permission or Windows privacy settings.',
  );
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
    });
  }
  async review(): Promise<void> {
    if (this.pending() || this.disposed) return;
    this.pending.set(true);
    this.message.set(
      'Choose Allow microphone or Cancel in the Stellar permission window.',
    );
    try {
      const reply = decodeMicrophoneReviewReply(
        await this.transport.review({ version: 1 }),
      );
      if (!this.disposed)
        this.message.set(
          reply.outcome === 'allowed'
            ? 'Microphone permission saved. Enable the microphone when you are ready. Windows privacy settings still apply.'
            : 'Permission review cancelled. Microphone access was not changed.',
        );
    } catch (error: unknown) {
      if (!this.disposed)
        this.message.set(
          error === 'unsupported'
            ? 'Permission review is unavailable in this version of the app. You can still use typed messages.'
            : error === 'busy'
              ? 'A microphone permission window is already open.'
              : 'Could not confirm microphone permission. Access has not been verified; retry the review or use typed messages.',
        );
    } finally {
      if (!this.disposed) this.pending.set(false);
    }
  }
}
