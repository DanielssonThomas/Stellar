import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonAtom } from './button-atom.component';

describe('ButtonAtom', () => {
  let fixture: ComponentFixture<ButtonAtom>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ButtonAtom],
    }).compileComponents();
    fixture = TestBed.createComponent(ButtonAtom);
    fixture.componentRef.setInput('label', 'Save changes');
    await fixture.whenStable();
  });

  it('emits activation when the enabled button is clicked', () => {
    const activated = vi.fn();
    fixture.componentInstance.activated.subscribe(activated);
    fixture.nativeElement.querySelector('button').click();

    expect(activated).toHaveBeenCalledOnce();
  });

  it('shows a shaped skeleton and disables the button while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector('button');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('stellar-skeleton-atom')).not.toBeNull();
  });
});
