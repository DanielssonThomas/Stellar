import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import {
  IvyAdapterService,
  initialIvySnapshot,
} from '@stellar/service-desktop-adapter';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  it('renders the application name', async () => {
    const ivy = {
      state: signal(initialIvySnapshot()),
      connect: vi.fn(async () => initialIvySnapshot()),
      submit: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: IvyAdapterService, useValue: ivy }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('h1').textContent).toContain(
      'Stellar Desktop',
    );
    expect(ivy.connect).toHaveBeenCalledOnce();
    expect(ivy.submit).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('[data-instance-id]'),
    ).toBeNull();
  });
});
