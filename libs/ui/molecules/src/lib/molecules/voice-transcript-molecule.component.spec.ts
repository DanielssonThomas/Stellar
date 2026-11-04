import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { VoiceTranscriptMolecule } from './voice-transcript-molecule.component';

describe('VoiceTranscriptMolecule', () => {
  let fixture: ComponentFixture<VoiceTranscriptMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VoiceTranscriptMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(VoiceTranscriptMolecule);
    await fixture.whenStable();
  });

  it('renders the recognized words as plain text without changing or interpreting them', async () => {
    fixture.componentRef.setInput(
      'text',
      'Ivy, <script>miss herd words</script>',
    );
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('[role="status"]').textContent,
    ).toBe('Ivy, <script>miss herd words</script>');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });

  it('reveals each replacement without retaining stale words or replacing the live region', async () => {
    fixture.componentRef.setInput('text', 'Show one quote.');
    await fixture.whenStable();
    const status: HTMLElement =
      fixture.nativeElement.querySelector('[role="status"]');
    const previous = status.firstElementChild;
    fixture.componentRef.setInput(
      'text',
      'Show two stoic quotes side by side.',
    );
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBe(status);
    expect(status.textContent).toBe('Show two stoic quotes side by side.');
    expect(status.firstElementChild).not.toBe(previous);
    expect(status.children).toHaveLength(1);
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.classList.contains('motion-reduced')).toBe(
      true,
    );
    expect(status.textContent).toBe('Show two stoic quotes side by side.');
  });
});
