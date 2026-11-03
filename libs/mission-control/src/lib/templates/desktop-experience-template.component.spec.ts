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
    for (const dialog of Array.from(
      fixture.nativeElement.querySelectorAll(
        'dialog',
      ) as NodeListOf<HTMLDialogElement>,
    )) {
      dialog.showModal = () => {
        dialog.open = true;
      };
      dialog.close = () => {
        dialog.open = false;
        dialog.dispatchEvent(new Event('close'));
      };
    }
  });

  it('opens controls with M, preserves typing and switches dialogs without stacking', async () => {
    const view = fixture.componentInstance;
    const key = (options: KeyboardEventInit = {}) =>
      new KeyboardEvent('keydown', {
        key: 'm',
        bubbles: true,
        cancelable: true,
        ...options,
      });
    expect(
      fixture.nativeElement.querySelector('[data-menu-trigger]'),
    ).toBeNull();
    for (const options of [
      { repeat: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
    ])
      fixture.nativeElement.dispatchEvent(key(options));
    const prevented = key();
    prevented.preventDefault();
    fixture.nativeElement.dispatchEvent(prevented);
    expect(view.menu.open()).toBe(false);
    fixture.nativeElement.dispatchEvent(key({ key: 'M', shiftKey: true }));
    expect(view.menu.open()).toBe(true);
    fixture.nativeElement.querySelector('textarea').dispatchEvent(key());
    expect(view.menu.open()).toBe(true);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    fixture.nativeElement.append(editable);
    editable.dispatchEvent(key());
    expect(view.menu.open()).toBe(true);
    fixture.nativeElement.dispatchEvent(key({ key: 'p' }));
    expect(view.menu.open()).toBe(false);
    expect(fixture.nativeElement.querySelector('.visualizer-dialog').open).toBe(
      true,
    );
    fixture.nativeElement.dispatchEvent(key());
    expect(view.menu.open()).toBe(true);
    expect(fixture.nativeElement.querySelector('.visualizer-dialog').open).toBe(
      false,
    );
    for (const phase of ['suspended', 'shutdown']) {
      view.menu.close();
      fixture.componentRef.setInput('state', { ...initialState, phase });
      await fixture.whenStable();
      fixture.nativeElement.dispatchEvent(key());
      expect(view.menu.open()).toBe(false);
    }
  });

  it('closes controls on Connect Ivy so its result cannot be covered by the menu', async () => {
    const menu = fixture.componentInstance.menu;
    const retry = vi.spyOn(fixture.componentInstance.retryIvy, 'emit');
    menu.toggle();
    await fixture.whenStable();
    const connect = Array.from(
      fixture.nativeElement.querySelectorAll(
        'button',
      ) as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.trim() === 'Connect Ivy');
    expect(connect).toBeDefined();
    connect?.click();
    expect(retry).toHaveBeenCalledOnce();
    expect(menu.open()).toBe(false);
  });

  it('opens music controls with P but leaves typing, shortcuts and repeats alone', async () => {
    const open = vi
      .spyOn(fixture.componentInstance.musicControls(), 'open')
      .mockImplementation(() => undefined);
    const key = (options: KeyboardEventInit = {}) =>
      new KeyboardEvent('keydown', {
        key: 'p',
        bubbles: true,
        cancelable: true,
        ...options,
      });
    fixture.nativeElement.dispatchEvent(key());
    expect(open).toHaveBeenCalledOnce();
    fixture.nativeElement.dispatchEvent(key({ repeat: true }));
    fixture.nativeElement.dispatchEvent(key({ ctrlKey: true }));
    fixture.componentInstance.menu.toggle();
    await fixture.whenStable();
    fixture.nativeElement.querySelector('textarea').dispatchEvent(key());
    expect(open).toHaveBeenCalledOnce();
    fixture.nativeElement.dispatchEvent(key({ key: 'P', shiftKey: true }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('shows only available Whisper input and hides it throughout prompt mode and suspension', async () => {
    const panel = () =>
      fixture.nativeElement.querySelector('stellar-voice-transcript-molecule');
    expect(panel()).toBeNull();
    fixture.componentRef.setInput('voiceInputText', 'Ivy, misheard request');
    await fixture.whenStable();
    expect(panel()?.textContent).toContain('Ivy, misheard request');
    fixture.componentRef.setInput('promptStatus', 'error');
    await fixture.whenStable();
    expect(panel()?.textContent).toContain('Ivy, misheard request');
    fixture.componentRef.setInput('solActive', true);
    for (const status of [
      'composing',
      'refining',
      'finalizing',
      'submitting',
      'error',
    ]) {
      fixture.componentRef.setInput('promptStatus', status);
      await fixture.whenStable();
      expect(panel()).toBeNull();
    }
    fixture.componentRef.setInput('promptStatus', 'idle');
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'suspended',
    });
    await fixture.whenStable();
    expect(panel()).toBeNull();
  });

  it('retains assembled presence between foreground turns until clear, while suspension still wins', async () => {
    expect(fixture.componentInstance.emblemPhase()).toBe('idle');
    fixture.componentRef.setInput('conversationActive', true);
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('listening');
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'suspended',
    });
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('suspended');
    fixture.componentRef.setInput('state', initialState);
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('listening');
    fixture.componentRef.setInput('conversationActive', false);
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('idle');
    fixture.componentRef.setInput('conversationActive', true);
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'shutdown',
    });
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('shutdown');
  });

  it('allows explicit manual activity to assemble while voice remains passive', async () => {
    fixture.componentRef.setInput('passiveListening', true);
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'listening',
      manualActive: true,
    });
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('listening');
    fixture.componentRef.setInput('state', initialState);
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('idle');
  });

  it('assembles while waiting, restores presence for narration and removes waiting on suspension', async () => {
    fixture.componentRef.setInput('assistantWaiting', true);
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('listening');
    fixture.componentRef.setInput('assistantNarrating', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.waiting-ring')).toBeNull();
    expect(fixture.componentInstance.emblemPhase()).toBe('listening');
    fixture.componentRef.setInput('state', {
      ...initialState,
      phase: 'suspended',
    });
    await fixture.whenStable();
    expect(fixture.componentInstance.emblemPhase()).toBe('suspended');
    expect(fixture.componentInstance.assistantActive()).toBe(false);
  });

  it('keeps the launch empty and delegates manual activity without requesting a microphone', async () => {
    const action = vi.fn();
    fixture.componentInstance.action.subscribe(action);
    expect(
      fixture.nativeElement.querySelector('[data-desktop-menu][open]'),
    ).toBeNull();
    fixture.componentInstance.menu.toggle();
    await fixture.whenStable();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-desktop-menu] .actions button',
    );
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
    expect(
      fixture.nativeElement.querySelector(
        '[data-desktop-menu] .actions button',
      ),
    ).toBe(button);
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
    fixture.componentInstance.menu.toggle();
    await fixture.whenStable();
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '.motion-toggle input',
    );
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

  it('allows reconnecting an uncertain Ivy turn while keeping submission blocked', async () => {
    const retry = vi.fn();
    fixture.componentInstance.retryIvy.subscribe(retry);
    fixture.componentInstance.menu.toggle();
    fixture.componentInstance.draft.set('Explicit next message');
    fixture.componentRef.setInput('assistantBusy', true);
    fixture.componentRef.setInput('assistantUncertain', true);
    await fixture.whenStable();
    const buttons = [
      ...fixture.nativeElement.querySelectorAll('button'),
    ] as HTMLButtonElement[];
    const connect = buttons.find(
      (button) => button.textContent?.trim() === 'Connect Ivy',
    );
    const submit = buttons.find(
      (button) => button.textContent?.trim() === 'Send',
    );
    expect(connect?.disabled).toBe(false);
    expect(submit?.disabled).toBe(true);
    connect?.click();
    expect(retry).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.menu.open()).toBe(false);
    fixture.componentRef.setInput('assistantUncertain', false);
    fixture.componentInstance.menu.toggle();
    await fixture.whenStable();
    const updatedConnect = Array.from(
      fixture.nativeElement.querySelectorAll(
        'button',
      ) as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.trim() === 'Connect Ivy');
    expect(updatedConnect?.disabled).toBe(true);
  });

  it('renders explicit input choices and the already normalized real level independently of detection', async () => {
    fixture.componentInstance.menu.toggle();
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
    expect(
      fixture.nativeElement.querySelector('[data-desktop-menu] meter').value,
    ).toBeGreaterThan(0);
    expect(fixture.nativeElement.textContent).toContain('Quiet');
    const select: HTMLSelectElement =
      fixture.nativeElement.querySelector('select');
    expect(select.value).toBe('usb');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(selected).toHaveBeenCalledExactlyOnceWith('');
  });
});

it('keeps passive reset exploded during recognition and still respects suspension', async () => {
  const f = TestBed.createComponent(DesktopExperienceTemplate);
  f.componentRef.setInput('passiveListening', true);
  f.componentRef.setInput('assistantWaiting', true);
  f.componentRef.setInput('conversationActive', true);
  await f.whenStable();
  expect(f.componentInstance.emblemPhase()).toBe('idle');
  expect(f.componentInstance.assistantActive()).toBe(false);
  f.componentRef.setInput('state', { ...initialState, phase: 'suspended' });
  await f.whenStable();
  expect(f.componentInstance.emblemPhase()).toBe('suspended');
  f.destroy();
});
