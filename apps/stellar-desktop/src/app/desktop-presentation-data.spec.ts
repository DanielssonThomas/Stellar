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
});
