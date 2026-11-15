import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ResponseCaptionMolecule } from './response-caption-molecule.component';

describe('ResponseCaptionMolecule', () => {
  let fixture: ComponentFixture<ResponseCaptionMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ResponseCaptionMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(ResponseCaptionMolecule);
    fixture.componentRef.setInput('text', 'I found the schedule.');
    await fixture.whenStable();
  });

  it('announces a committed update politely as literal text', async () => {
    const text = '<script>alert("no")</script> **Checking** <b>calendar</b>';
    fixture.componentRef.setInput('text', text);
    await fixture.whenStable();
    const caption = fixture.nativeElement.querySelector('[role="status"]');
    expect(caption.textContent.trim()).toBe(text);
    expect(caption.getAttribute('aria-live')).toBe('polite');
    expect(caption.getAttribute('aria-atomic')).toBe('true');
    expect(caption.tabIndex).toBe(0);
    expect(fixture.nativeElement.querySelector('script, b, strong')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('section').getAttribute('aria-label'),
    ).toBe('Ivy update');
  });

  it('replaces the update with the final answer without duplicate caption text', async () => {
    fixture.componentRef.setInput('kind', 'final');
    fixture.componentRef.setInput('text', 'You have two meetings today.');
    await fixture.whenStable();
    expect(fixture.nativeElement.getAttribute('data-response-kind')).toBe(
      'final',
    );
    expect(
      fixture.nativeElement.querySelector('section').getAttribute('aria-label'),
    ).toBe('Ivy answer');
    expect(
      fixture.nativeElement.querySelectorAll('[role="status"]'),
    ).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain(
      'You have two meetings today.',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'I found the schedule.',
    );
  });

  it('bounds displayed text and avoids splitting an astral character at the limit', async () => {
    fixture.componentRef.setInput(
      'text',
      `${'a'.repeat(4094)}🌠${'b'.repeat(20)}`,
    );
    await fixture.whenStable();
    const text = fixture.nativeElement
      .querySelector('[role="status"]')
      .textContent.trim();
    expect(text).toBe(`${'a'.repeat(4094)}…`);
    expect(text.length).toBeLessThanOrEqual(4096);
    fixture.componentRef.setInput('text', 'c'.repeat(4096));
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('[role="status"]').textContent.trim(),
    ).toBe('c'.repeat(4096));
  });

  it('accepts the reduced-motion preference without animating a different caption', async () => {
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.classList.contains('motion-reduced')).toBe(
      true,
    );
    expect(
      fixture.nativeElement.querySelector('[role="status"]').textContent.trim(),
    ).toBe('I found the schedule.');
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });
});
