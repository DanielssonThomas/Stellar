import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { DesktopExperienceTemplate } from '@stellar/ui-templates/desktop-experience';
import {
  IvyAdapterService,
  initialIvySnapshot,
  WorkspaceToolsService,
} from '@stellar/service-desktop-adapter';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  it('starts exploded and passive when reconnecting a completed turn and retained Sol preference', async () => {
    const snapshot = {
      ...initialIvySnapshot(),
      connection: 'ready' as const,
      model: 'sol' as const,
      turn: 'completed' as const,
      turn_id: '11111111-2222-4333-8444-555555555555',
      items: [{ kind: 'text' as const, text: 'A previously completed reply' }],
    };
    const ivy = {
      state: signal(snapshot),
      connect: vi.fn(async () => snapshot),
      snapshot: vi.fn(async () => snapshot),
      submit: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: IvyAdapterService, useValue: ivy }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();
    const template: DesktopExperienceTemplate = fixture.debugElement.query(
      By.directive(DesktopExperienceTemplate),
    ).componentInstance;
    expect(fixture.componentInstance.voice.composition().model).toBe('sol');
    expect(fixture.componentInstance.voice.state()).toMatchObject({
      foregroundActive: false,
      passive: true,
    });
    expect(template.conversationActive()).toBe(false);
    expect(template.emblemPhase()).toBe('idle');
    expect(template.emblem()?.classes()).toContain('idle-motion');
    expect(ivy.submit).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('records unexpected interface faults without retaining the raw error and releases the listener', async () => {
    const snapshot = { ...initialIvySnapshot(), connection: 'ready' as const };
    const ivy = {
      state: signal(snapshot),
      connect: vi.fn(async () => snapshot),
      snapshot: vi.fn(async () => snapshot),
    };
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: IvyAdapterService, useValue: ivy }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();
    globalThis.dispatchEvent(
      new ErrorEvent('error', {
        message: 'private-path-and-prompt-must-not-be-retained',
      }),
    );
    const faults = fixture.componentInstance.faults;
    expect(faults.entries().some((entry) => entry.category === 'Desktop')).toBe(
      true,
    );
    expect(JSON.stringify(faults.entries())).not.toContain(
      'private-path-and-prompt',
    );
    const count = faults.entries().length;
    fixture.destroy();
    globalThis.dispatchEvent(
      new ErrorEvent('error', { message: 'another-private-error' }),
    );
    expect(faults.entries()).toHaveLength(count);
  });

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

  it('clears panes after a confirmed reset during suspension even when command IDs are exhausted, and releases the workspace binding', async () => {
    let finish!: (value: boolean) => void;
    const cleared = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const snapshot = { ...initialIvySnapshot(), connection: 'ready' as const };
    const ivy = {
      state: signal(snapshot),
      connect: vi.fn(async () => snapshot),
      snapshot: vi.fn(async () => snapshot),
      clearConversation: vi.fn(() => cleared),
    };
    const unbind = vi.fn();
    const workspace = {
      bind: vi.fn(() => unbind),
      isCurrent: vi.fn(() => true),
    };
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        { provide: IvyAdapterService, useValue: ivy },
        { provide: WorkspaceToolsService, useValue: workspace },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();
    const app = fixture.componentInstance;
    const template = fixture.debugElement.children[0].children.find(
      (child) => child.componentInstance?.stage,
    )?.componentInstance;
    expect(template).toBeDefined();
    const stage = template.stage();
    expect(
      stage.dispatch({
        contractVersion: 1,
        commandId: 1,
        action: 'open',
        instanceId: 'plan',
        surface: 'assistant-message',
        prominence: 'primary',
        payload: { title: 'Plan', body: 'Retained foreground content' },
      }).status,
    ).toBe('applied');
    expect(
      stage.dispatch({
        contractVersion: 1,
        commandId: Number.MAX_SAFE_INTEGER,
        action: 'focus',
        instanceId: 'plan',
      }).status,
    ).toBe('applied');
    const reset = app.voice.resetConversation();
    app.experience.dispatch({ type: 'hidden' });
    expect(app.experience.state().phase).toBe('suspended');
    finish(true);
    expect(await reset).toBe(true);
    expect(stage.presentationIds()).toEqual([]);
    fixture.destroy();
    expect(unbind).toHaveBeenCalledOnce();
  });
});
