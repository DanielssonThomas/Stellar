import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IvyQuestionMolecule } from './ivy-question-molecule.component';

describe('IvyQuestionMolecule', () => {
  let fixture: ComponentFixture<IvyQuestionMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [IvyQuestionMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(IvyQuestionMolecule);
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector('dialog');
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    dialog.getClientRects = () => [new DOMRect(0, 0, 500, 400)];
  });

  const question = {
    id: 'q1',
    text: 'Which monitor?',
    choices: ['Left', 'Right'],
    multi_select: false,
    shown: true,
    answering: false,
  };

  it('acknowledges displayed content once and emits one exact choice', async () => {
    const shown = vi.fn();
    const answer = vi.fn();
    fixture.componentInstance.shown.subscribe(shown);
    fixture.componentInstance.answer.subscribe(answer);
    fixture.componentRef.setInput('question', question);
    await fixture.whenStable();
    expect(shown).toHaveBeenCalledExactlyOnceWith('q1');
    fixture.nativeElement.querySelector('.choice').click();
    fixture.componentInstance.choose(1);
    expect(answer).toHaveBeenCalledExactlyOnceWith({
      kind: 'answer',
      answer: 'Left',
    });
  });

  it('cannot acknowledge hidden content or accept an answer before acknowledgement', async () => {
    const shown = vi.fn();
    const answer = vi.fn();
    fixture.componentInstance.shown.subscribe(shown);
    fixture.componentInstance.answer.subscribe(answer);
    fixture.nativeElement.querySelector('dialog').getClientRects = () => [];
    fixture.componentRef.setInput('question', { ...question, shown: false });
    await fixture.whenStable();
    fixture.componentInstance.choose(0);
    expect(shown).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it('supports multiple choices, free text, skip and keyboard cancellation', async () => {
    const answer = vi.fn();
    fixture.componentInstance.answer.subscribe(answer);
    fixture.componentRef.setInput('question', {
      ...question,
      multi_select: true,
    });
    await fixture.whenStable();
    fixture.componentInstance.choose(1);
    fixture.componentInstance.choose(0);
    fixture.componentInstance.submit(new Event('submit'));
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'answer',
      answer: '["Right","Left"]',
    });
    fixture.componentInstance.submitted.set(false);
    fixture.componentInstance.draft.set('  My own answer  ');
    fixture.componentInstance.submit(new Event('submit'));
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'answer',
      answer: 'My own answer',
    });
    fixture.componentInstance.submitted.set(false);
    fixture.componentInstance.respond({ kind: 'skip' });
    expect(answer).toHaveBeenLastCalledWith({ kind: 'skip' });
    fixture.componentInstance.submitted.set(false);
    const cancel = new Event('cancel', { cancelable: true });
    fixture.componentInstance.cancel(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(answer).toHaveBeenLastCalledWith({ kind: 'cancel' });
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
