import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToggleSwitchAtom } from './toggle-switch-atom.component';

describe('ToggleSwitchAtom', () => {
  let fixture: ComponentFixture<ToggleSwitchAtom>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToggleSwitchAtom],
    }).compileComponents();
    fixture = TestBed.createComponent(ToggleSwitchAtom);
    await fixture.whenStable();
  });

  it('names and describes the switch and emits the requested preference', async () => {
    fixture.componentRef.setInput('label', 'Spoken replies');
    fixture.componentRef.setInput('description', 'Let Ivy speak aloud.');
    await fixture.whenStable();
    const toggle: HTMLInputElement =
      fixture.nativeElement.querySelector('input');
    const change = vi.fn();
    fixture.componentInstance.checkedChange.subscribe(change);
    expect(toggle.getAttribute('aria-label')).toBe('Spoken replies');
    expect(toggle.getAttribute('aria-description')).toBe(
      'Let Ivy speak aloud.',
    );
    toggle.click();
    expect(change).toHaveBeenCalledWith(true);
    await fixture.whenStable();
    expect(toggle.checked).toBe(false);
    fixture.componentRef.setInput('checked', true);
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(toggle.checked).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(
      fixture.nativeElement.querySelector('.motion-reduced.switch-on'),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('On');
  });

  it('does not request a change while disabled or loading', async () => {
    const change = vi.fn();
    fixture.componentInstance.checkedChange.subscribe(change);
    const toggle: HTMLInputElement =
      fixture.nativeElement.querySelector('input');
    for (const input of ['disabled', 'loading']) {
      fixture.componentRef.setInput(input, true);
      await fixture.whenStable();
      expect(toggle.disabled).toBe(true);
      toggle.click();
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      expect(toggle.checked).toBe(false);
      expect(change).not.toHaveBeenCalled();
      fixture.componentRef.setInput(input, false);
    }
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
