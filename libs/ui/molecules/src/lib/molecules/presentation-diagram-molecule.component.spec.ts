import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PresentationDiagramMolecule } from './presentation-diagram-molecule.component';

describe('PresentationDiagramMolecule', () => {
  let fixture: ComponentFixture<PresentationDiagramMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationDiagramMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PresentationDiagramMolecule);
    await fixture.whenStable();
  });

  it('keeps node identity and marker scope while rendering labels literally', async () => {
    fixture.componentRef.setInput('payload', {
      title: 'Flow',
      nodes: [
        { id: 'one', label: '<script>literal</script>' },
        { id: 'two', label: 'Done' },
      ],
      edges: [{ from: 'one', to: 'two' }],
    });
    await fixture.whenStable();
    const node = fixture.nativeElement.querySelector('g');
    const marker = fixture.componentInstance.markerId;
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('rect').length).toBe(2);
    fixture.componentRef.setInput('payload', {
      title: 'Updated',
      nodes: [{ id: 'one', label: 'Still here' }],
      edges: [],
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('g')).toBe(node);
    expect(fixture.componentInstance.markerId).toBe(marker);
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
