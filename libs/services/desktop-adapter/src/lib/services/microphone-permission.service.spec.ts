import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import {
  MICROPHONE_PERMISSION_TRANSPORT,
  MicrophonePermissionService,
} from './microphone-permission.service';

function fixture() {
  const review = vi.fn(async () => ({ version: 1, outcome: 'allowed' }));
  TestBed.configureTestingModule({
    providers: [
      { provide: MICROPHONE_PERMISSION_TRANSPORT, useValue: { review } },
    ],
  });
  const service = TestBed.inject(MicrophonePermissionService);
  return { service, review };
}
describe('manual microphone permission review', () => {
  it('never requests permission on construction and sends no renderer decision', async () => {
    const f = fixture();
    expect(f.review).not.toHaveBeenCalled();
    await f.service.review();
    expect(f.review).toHaveBeenCalledExactlyOnceWith({ version: 1 });
    expect(f.service.message()).toContain(
      'Enable the microphone when you are ready',
    );
    expect(f.service.pending()).toBe(false);
  });
  it('serializes manual reviews and reports cancel without claiming access', async () => {
    const f = fixture();
    let finish!: (value: { version: number; outcome: string }) => void;
    f.review.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.service.review();
    await f.service.review();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.service.pending()).toBe(true);
    finish({ version: 1, outcome: 'cancelled' });
    await pending;
    expect(f.service.message()).toContain('not changed');
  });
  it.each(['unsupported', 'unavailable', 'forbidden', 'busy'])(
    'reports %s and permits an explicit retry',
    async (error) => {
      const f = fixture();
      f.review.mockRejectedValueOnce(error);
      await f.service.review();
      expect(f.service.message()).not.toContain('permission saved');
      expect(f.service.pending()).toBe(false);
      await f.service.review();
      expect(f.review).toHaveBeenCalledTimes(2);
    },
  );
  it('does not trust malformed replies or publish a late result after disposal', async () => {
    const f = fixture();
    f.review.mockResolvedValueOnce({ version: 2, outcome: 'allowed' });
    await f.service.review();
    expect(f.service.message()).toContain('not been verified');
    let finish!: (value: { version: number; outcome: string }) => void;
    f.review.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.service.review();
    TestBed.resetTestingModule();
    finish({ version: 1, outcome: 'allowed' });
    await pending;
    expect(f.service.message()).not.toContain('permission saved');
  });
});
