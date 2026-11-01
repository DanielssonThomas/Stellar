import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DesktopAdapterService } from './desktop-adapter.service';

describe('DesktopAdapterService', () => {
  it('is injectable as a shared singleton', () => {
    TestBed.configureTestingModule({ providers: [DesktopAdapterService] });

    const first = TestBed.inject(DesktopAdapterService);
    const second = TestBed.inject(DesktopAdapterService);

    expect(first).toBeInstanceOf(DesktopAdapterService);
    expect(second).toBe(first);
  });
});
