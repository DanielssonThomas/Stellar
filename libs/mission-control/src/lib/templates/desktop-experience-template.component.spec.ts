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

  it('renders explicit input choices and the already normalized real level independently of detection', async () => {
    const selected = vi.fn();
    fixture.componentInstance.selectInput.subscribe(selected);
    fixture.componentRef.setInput('inputsVisible', true);
    fixture.componentRef.setInput('inputs', [
      { deviceId: 'usb', label: 'USB microphone' },
    ]);
    fixture.componentRef.setInput('selectedInputId', 'usb');
    fixture.componentRef.setInput('selectedInputLabel', 'USB microphone');
    fixture.componentRef.setInput('state', {
      ...initialState,
      microphone: { status: 'capturing', requestId: 1 },
    });
    fixture.componentRef.setInput('level', 0.33);
    fixture.componentRef.setInput('activityStatus', 'Quiet');
    await fixture.whenStable();
    expect(fixture.componentInstance.inputMeter()).toBe(33);
    expect(fixture.nativeElement.querySelector('meter').value).toBeGreaterThan(
      0,
    );
    expect(fixture.nativeElement.textContent).toContain('Quiet');
    const select: HTMLSelectElement =
      fixture.nativeElement.querySelector('select');
    expect(select.value).toBe('usb');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(selected).toHaveBeenCalledExactlyOnceWith('');
  });
});
