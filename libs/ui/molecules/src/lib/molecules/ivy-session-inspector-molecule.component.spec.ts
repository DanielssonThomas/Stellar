import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IvySessionInspectorMolecule } from './ivy-session-inspector-molecule.component';

describe('IvySessionInspectorMolecule', () => {
  let fixture: ComponentFixture<IvySessionInspectorMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [IvySessionInspectorMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(IvySessionInspectorMolecule);
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector('dialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    dialog.close = vi.fn(() => dialog.removeAttribute('open'));
  });

  it('renders honest unavailable state and current runtime status while open', async () => {
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Ivy sessions');
    expect(fixture.nativeElement.textContent).toContain('Unavailable');
    expect(fixture.nativeElement.textContent).toContain('Disconnected');
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });
  it('filters and selects old conversations without invoking a lifecycle action', async () => {
    fixture.componentRef.setInput('visible', true);
    const selected = vi.fn(),
      newSession = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    fixture.componentInstance.newSession.subscribe(newSession);
    fixture.componentRef.setInput('sessions', [
      {
        id: 'a',
        title: 'Calendar review',
        model: 'terra',
        started_at: null,
        last_activity_at: null,
        message_count: 2,
      },
      {
        id: 'b',
        title: 'Git issue',
        model: 'sol',
        started_at: null,
        last_activity_at: null,
        message_count: 3,
      },
    ]);
    fixture.componentInstance.query.set('calendar');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.session-row')).toHaveLength(
      1,
    );
    fixture.nativeElement.querySelector('.session-row').click();
    expect(selected).toHaveBeenCalledExactlyOnceWith('a');
    expect(newSession).not.toHaveBeenCalled();
  });
  it('opens and closes its dialog, and renders transcript content as text', async () => {
    fixture.componentRef.setInput('messages', [
      {
        id: 1,
        role: 'assistant',
        text: '<script>private()</script>',
        at: null,
      },
    ]);
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector('dialog');
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('.message-text').textContent,
    ).toContain('<script>');
    fixture.componentRef.setInput('visible', false);
    await fixture.whenStable();
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('.message-text')).toBeNull();
    expect(fixture.nativeElement.querySelector('.status-line')).toBeNull();
  });
  it('keeps closed inspector runtime and conversation content out of the DOM', async () => {
    fixture.componentRef.setInput('status', 'Ivy recovery timed out');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain(
      'Ivy recovery timed out',
    );
    expect(fixture.nativeElement.querySelector('.inspector-shell')).toBeNull();
  });
});
