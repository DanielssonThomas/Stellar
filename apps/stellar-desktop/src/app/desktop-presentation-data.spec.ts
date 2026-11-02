import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DesktopTelemetryService,
  IvyAdapterService,
  initialIvySnapshot,
} from '@stellar/service-desktop-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPresentationData } from './desktop-presentation-data';

describe('desktop presentation source composition', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('uses native state for model identity and owns subscriptions only while panes are present', async () => {
    const state = signal({
      ...initialIvySnapshot(),
      connection: 'ready' as const,
      model: 'sol' as const,
    });
    const snapshot = vi.fn(async () => state());
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    TestBed.configureTestingModule({
      providers: [
        { provide: IvyAdapterService, useValue: { state, snapshot } },
        {
          provide: DesktopTelemetryService,
          useValue: {
            acquire,
            state: signal({
              status: 'unavailable',
              fresh: false,
              snapshot: null,
            }),
          },
        },
      ],
    });
    const data = TestBed.runInInjectionContext(desktopPresentationData);
    expect(snapshot).not.toHaveBeenCalled();
    const stop = data.acquire();
    await vi.waitFor(() => expect(data.session().state).toBe('available'));
    expect(
      data.session().rows.find((row) => row.id === 'selected-model')?.value,
    ).toBe('Sol');
    expect(
      data.session().rows.find((row) => row.id === 'verified-model')?.value,
    ).toBe('Unavailable');
    expect(data.workflow().state).toBe('unavailable');
    expect(data.session().rows.find((row) => row.id === 'context')?.value).toBe(
      'Unavailable',
    );
    stop();
    stop();
    expect(release).toHaveBeenCalledOnce();
    expect(data.session().state).toBe('unavailable');
  });

  it('marks a ready connection unavailable when its snapshot reports an error', async () => {
    const state = signal({
      ...initialIvySnapshot(),
      connection: 'ready' as const,
    });
    const snapshot = vi.fn(async () => state());
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IvyAdapterService,
          useValue: { state, snapshot },
        },
        {
          provide: DesktopTelemetryService,
          useValue: {
            acquire: () => () => undefined,
            state: signal({
              status: 'unavailable',
              fresh: false,
              snapshot: null,
            }),
          },
        },
      ],
    });
    const data = TestBed.runInInjectionContext(desktopPresentationData);
    const stop = data.acquire();
    await vi.waitFor(() => expect(data.session().state).toBe('available'));
    state.update((value) => ({ ...value, error: 'protocol' }));
    expect(data.session().state).toBe('unavailable');
    stop();
    const stopAgain = data.acquire();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    state.update((value) => ({ ...value, error: null }));
    expect(data.session().state).toBe('unavailable');
    stopAgain();
  });

  it('refreshes immediately when an obsolete pending read settles after reacquisition', async () => {
    const state = signal({
      ...initialIvySnapshot(),
      connection: 'ready' as const,
    });
    let finish!: (value: ReturnType<typeof state>) => void;
    const first = new Promise<ReturnType<typeof state>>((resolve) => {
      finish = resolve;
    });
    const snapshot = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(state());
    TestBed.configureTestingModule({
      providers: [
        { provide: IvyAdapterService, useValue: { state, snapshot } },
        {
          provide: DesktopTelemetryService,
          useValue: {
            acquire: () => () => undefined,
            state: signal({
              status: 'unavailable',
              fresh: false,
              snapshot: null,
            }),
          },
        },
      ],
    });
    const data = TestBed.runInInjectionContext(desktopPresentationData);
    const firstRelease = data.acquire();
    firstRelease();
    const secondRelease = data.acquire();
    expect(snapshot).toHaveBeenCalledTimes(1);
    finish(state());
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(data.session().state).toBe('available'));
    secondRelease();
  });
});
