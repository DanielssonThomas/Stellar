import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ActivitySummaryMolecule,
  PRESENTATION_EDIT,
} from '@stellar/ui-molecules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageOrganism } from './stage-organism.component';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { decodeActivitySummary } from './stage-contract';
import {
  TestFixtureOrganism,
  fixtureLifecycle,
} from '../../testing/test-fixture-organism.component';

describe('StageOrganism', () => {
  let fixture: ComponentFixture<StageOrganism>;
  let opener: HTMLButtonElement;
  let disconnect: ReturnType<typeof vi.fn>;
  let bounds: { width: number; height: number };
  it('fences callbacks from a closed pane when its identifier is reused during retirement', async () => {
    fixture.componentInstance.dispatch(open());
    await fixture.whenStable();
    const oldEdit = fixture.componentInstance
      .surfaces()[0]
      .injector.get(PRESENTATION_EDIT);
    fixture.componentInstance.control('close', 'summary');
    fixture.componentInstance.dispatch({
      ...open(2),
      payload: { durationMs: 10, peakLevel: 0.2 },
    });
    await fixture.whenStable();
    oldEdit({ durationMs: 9000, peakLevel: 0.9 });
    await fixture.whenStable();
    expect(fixture.componentInstance.surfaces()[0].inputs.payload).toEqual({
      durationMs: 10,
      peakLevel: 0.2,
    });
  });
  const open = (
    commandId = 1,
    instanceId = 'summary',
    surface = 'activity-summary',
  ) => ({
    contractVersion: 1,
    commandId,
    instanceId,
    action: 'open',
    surface,
    prominence: 'primary',
    payload: {
      durationMs: 62000,
      peakLevel: 0.72,
      inputLabel: '<b>Literal label</b>',
    },
  });
  const control = (
    commandId: number,
    action: string,
    instanceId = 'summary',
  ) => ({ contractVersion: 1, commandId, instanceId, action });

  beforeEach(async () => {
    bounds = { width: 1000, height: 700 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({
        ...bounds,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: bounds.width,
        bottom: bounds.height,
        toJSON() {
          return {};
        },
      }),
    );
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          return;
        }
        disconnect = disconnect;
      },
    );
    fixtureLifecycle.destroyed = 0;
    await TestBed.configureTestingModule({
      imports: [StageOrganism],
      providers: [
        {
          provide: STAGE_CATALOGUE,
          useValue: {
            'activity-summary': {
              title: 'Activity summary',
              component: ActivitySummaryMolecule,
              decode: decodeActivitySummary,
            },
            fixture: {
              title: 'Test fixture',
              component: TestFixtureOrganism,
              decode: () => ({ label: 'Second trusted fixture' }),
            },
          },
        },
      ],
    }).compileComponents();
    opener = document.createElement('button');
    opener.textContent = 'Open summary';
    document.body.append(opener);
    fixture = TestBed.createComponent(StageOrganism);
    await fixture.whenStable();
    opener.focus();
  });

  afterEach(() => {
    fixture.destroy();
    opener.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores a persistent fallback when opening content detached its disclosure origin', async () => {
    const transient = document.createElement('button');
    document.body.append(transient);
    transient.focus();
    fixture.componentRef.setInput('focusFallback', opener);
    fixture.componentInstance.dispatch(open());
    await fixture.whenStable();
    transient.remove();
    fixture.componentInstance.control('close', 'summary');
    await fixture.whenStable();
    expect(document.activeElement).toBe(opener);
  });

  it('renders only registered components, updates typed inputs and focuses the panel', async () => {
    expect(fixture.componentInstance.dispatch(open()).status).toBe('applied');
    await fixture.whenStable();
    const panel: HTMLElement = fixture.nativeElement.querySelector(
      '[data-instance-id="summary"]',
    );
    expect(panel.textContent).toContain('1m 02s');
    expect(panel.textContent).toContain('<b>Literal label</b>');
    expect(panel.querySelector('b')).toBeNull();
    expect(document.activeElement).toBe(panel);
    expect(
      fixture.componentInstance.dispatch({
        ...open(2),
        action: 'update',
        prominence: undefined,
      }).status,
    ).toBe('rejected');
    fixture.componentInstance.dispatch({
      contractVersion: 1,
      commandId: 2,
      instanceId: 'summary',
      action: 'update',
      surface: 'activity-summary',
      payload: { durationMs: 3000, peakLevel: 0.2 },
    });
    await fixture.whenStable();
    expect(panel.textContent).toContain('0m 03s');
    expect(
      fixture.componentInstance.dispatch(open(3, 'unknown', 'remote')).status,
    ).toBe('rejected');
    expect(fixture.nativeElement.querySelectorAll('section')).toHaveLength(1);
  });

  it('emits one semantic dismissal for keyboard close and restores original focus', async () => {
    const dismiss = vi.fn();
    fixture.componentInstance.interaction.subscribe(dismiss);
    fixture.componentInstance.dispatch(open());
    await fixture.whenStable();
    const panel: HTMLElement = fixture.nativeElement.querySelector('section');
    panel.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ type: 'dismiss' });
    fixture.componentInstance.dispatch(control(2, 'close'));
    fixture.componentInstance.dispatch(control(2, 'close'));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('synchronizes arrange and clear, restores nested focus and emits visibility once', async () => {
    const retained = vi.fn();
    const visible = vi.fn();
    const dismiss = vi.fn();
    fixture.componentInstance.retainedPresentations.subscribe(retained);
    fixture.componentInstance.presentationChange.subscribe(visible);
    fixture.componentInstance.interaction.subscribe(dismiss);
    fixture.componentInstance.dispatch(open(1, 'first'));
    await fixture.whenStable();
    fixture.componentInstance.dispatch(open(2, 'second'));
    await fixture.whenStable();
    const focusedControl = document.createElement('button');
    focusedControl.textContent = 'Pane control';
    fixture.nativeElement
      .querySelector('[data-instance-id="second"] .surface-content')
      .append(focusedControl);
    focusedControl.focus();
    expect(
      fixture.componentInstance.dispatch({
        contractVersion: 1,
        commandId: 3,
        action: 'arrange',
        instanceIds: ['second', 'first'],
      }).status,
    ).toBe('applied');
    await fixture.whenStable();
    expect(
      fixture.componentInstance.surfaces().map((surface) => surface.instanceId),
    ).toEqual(['second', 'first']);
    expect(document.activeElement).toBe(focusedControl);
    retained.mockClear();
    visible.mockClear();
    expect(
      fixture.componentInstance.dispatch({
        contractVersion: 1,
        commandId: 4,
        action: 'clear',
      }).status,
    ).toBe('applied');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('section')).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(retained).toHaveBeenCalledExactlyOnceWith(false);
    expect(visible).toHaveBeenCalledExactlyOnceWith(false);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith({ type: 'dismiss' });
    fixture.componentInstance.dispatch({
      contractVersion: 1,
      commandId: 4,
      action: 'clear',
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('supports a second test-only trusted kind and retains it on minimize and disposes it on close', async () => {
    fixture.componentInstance.dispatch(open());
    fixture.componentInstance.dispatch(open(2, 'fixture', 'fixture'));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('section')).toHaveLength(2);
    expect(fixture.nativeElement.textContent).toContain(
      'Second trusted fixture',
    );
    fixture.componentInstance.dispatch(control(3, 'minimize', 'fixture'));
    await fixture.whenStable();
    expect(fixtureLifecycle.destroyed).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('section')).toHaveLength(2);
    expect(
      fixture.nativeElement.querySelector('[data-instance-id=fixture]').style
        .display,
    ).toBe('none');
    fixture.componentInstance.dispatch(control(4, 'focus', 'fixture'));
    await fixture.whenStable();
    expect(document.activeElement?.getAttribute('data-instance-id')).toBe(
      'fixture',
    );
    fixture.componentInstance.dispatch(control(5, 'close', 'fixture'));
    await fixture.whenStable();
    expect(fixtureLifecycle.destroyed).toBe(1);
  });

  it('responds to resize and disposes observer/components on destruction', async () => {
    fixture.componentInstance.dispatch(open(1, 'fixture', 'fixture'));
    await fixture.whenStable();
    const before = fixture.componentInstance.layout();
    bounds = { width: 320, height: 500 };
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    const after = fixture.componentInstance.layout();
    expect(after.surfaces[0].width).toBeLessThan(before.surfaces[0].width);
    expect(after.emblem.x + after.emblem.width).toBeLessThanOrEqual(320);
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(fixtureLifecycle.destroyed).toBe(1);
    expect(fixture.componentInstance.dispatch(open(2)).reason).toBe('disposed');
  });

  it('restores every minimized instance even when a visible instance is first', async () => {
    fixture.componentInstance.dispatch(open(1, 'first'));
    fixture.componentInstance.dispatch(open(2, 'second', 'fixture'));
    await fixture.whenStable();
    fixture.componentInstance.control('minimize', 'first');
    await fixture.whenStable();
    fixture.componentInstance.restorePresentation();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('section')).toHaveLength(2);
    expect(document.activeElement?.getAttribute('data-instance-id')).toBe(
      'first',
    );
    fixture.componentInstance.control('minimize', 'first');
    fixture.componentInstance.control('minimize', 'second');
    await fixture.whenStable();
    fixture.componentInstance.restorePresentation();
    await fixture.whenStable();
    expect(fixture.componentInstance.layout().surfaces).toHaveLength(1);
    fixture.componentInstance.restorePresentation();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('section')).toHaveLength(2);
  });

  it.each(['close', 'minimize'])(
    'restores the original opener when an ancestor surface is removed by %s',
    async (action) => {
      fixture.componentInstance.dispatch(open());
      await fixture.whenStable();
      fixture.componentInstance.dispatch(open(2, 'nested', 'fixture'));
      await fixture.whenStable();
      expect(document.activeElement?.getAttribute('data-instance-id')).toBe(
        'nested',
      );
      fixture.componentInstance.dispatch(control(3, action));
      await fixture.whenStable();
      const nested: HTMLElement = fixture.nativeElement.querySelector(
        '[data-instance-id="nested"]',
      );
      nested.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await fixture.whenStable();
      expect(document.activeElement).toBe(opener);
    },
  );

  it('provides loading skeleton without granting unknown command authority', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
    expect(
      fixture.componentInstance.dispatch({
        ...open(),
        component: TestFixtureOrganism,
      }).status,
    ).toBe('rejected');
  });
});
