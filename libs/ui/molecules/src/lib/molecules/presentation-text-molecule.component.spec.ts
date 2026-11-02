import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PresentationTextMolecule } from './presentation-text-molecule.component';

describe('PresentationTextMolecule', () => {
  let fixture: ComponentFixture<PresentationTextMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationTextMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PresentationTextMolecule);
    await fixture.whenStable();
  });

  it('renders structured text literally, including code, tables and checklist semantics', async () => {
    fixture.componentRef.setInput('payload', {
      title: 'Plan',
      blocks: [
        { kind: 'paragraph', text: '<script>literal</script>' },
        {
          kind: 'code',
          text: 'const path = "C:\\work";',
          language: 'TypeScript',
        },
        { kind: 'table', columns: ['Name'], rows: [['<img src=x>']] },
        {
          kind: 'checklist',
          items: [{ text: 'Retain requirements', checked: true }],
        },
      ],
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.querySelector('code').textContent).toContain(
      'C:\\work',
    );
    expect(fixture.nativeElement.querySelector('td').textContent).toBe(
      '<img src=x>',
    );
    expect(
      fixture.nativeElement.querySelector('[aria-label="Complete"]'),
    ).not.toBeNull();
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
