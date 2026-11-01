import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '@stellar/desktop-interaction';
import { DesktopExperienceTemplate } from '../../../desktop-experience/src/lib/templates/desktop-experience-template.component';

describe('DesktopExperienceTemplate', () => {
  let fixture: ComponentFixture<DesktopExperienceTemplate>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DesktopExperienceTemplate],
    }).compileComponents();
    fixture = TestBed.createComponent(DesktopExperienceTemplate);
    await fixture.whenStable();
  });

  it('keeps the launch empty and delegates manual activity without requesting a microphone', async () => {
    const action = vi.fn();
    fixture.componentInstance.action.subscribe(action);
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector('button');
    expect(button.textContent).toContain('Start activity');
    expect(
      fixture.nativeElement.querySelector('[data-instance-id]'),
    ).toBeNull();
    button.click();
    expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'manual-start' });
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'listening',
      manualActive: true,
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('button')).toBe(button);
    expect(button.textContent).toContain('End activity');
  });

  it('delegates keyboard dismissal and reduced-motion changes', async () => {
    const action = vi.fn();
    fixture.componentInstance.action.subscribe(action);
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'focusing',
    });
    await fixture.whenStable();
    fixture.nativeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(action).toHaveBeenCalledWith({ type: 'dismiss' });
    const input: HTMLInputElement =
      fixture.nativeElement.querySelector('input');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(action).toHaveBeenCalledWith({
      type: 'reduced-motion',
      enabled: true,
    });
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });
});
