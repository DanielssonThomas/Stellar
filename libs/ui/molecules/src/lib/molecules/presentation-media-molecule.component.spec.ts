import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PresentationMediaMolecule } from './presentation-media-molecule.component';

describe('PresentationMediaMolecule', () => {
  let fixture: ComponentFixture<PresentationMediaMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PresentationMediaMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(PresentationMediaMolecule);
    await fixture.whenStable();
  });

  it('shows actual image failure and resets it when the source changes', async () => {
    fixture.componentRef.setInput('payload', {
      kind: 'image',
      title: 'Reference',
      src: '/emblem/layers/missing.png',
      alt: 'Source image',
    });
    await fixture.whenStable();
    fixture.nativeElement
      .querySelector('img')
      .dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Image unavailable');
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'error',
    );
    fixture.componentRef.setInput('payload', {
      kind: 'image',
      title: 'Next',
      src: '/emblem/layers/next.png',
      alt: 'Next image',
    });
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('[aria-label="Loading image"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'loading',
    );
    fixture.nativeElement.querySelector('img').dispatchEvent(new Event('load'));
    await fixture.whenStable();
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'ready',
    );
  });
  it('exposes the browser limitation without creating a frame or fetching the remote address', async () => {
    fixture.componentRef.setInput('payload', {
      kind: 'browser',
      title: 'Documentation',
      url: 'https://example.com/',
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(
      'Embedded browsing requires the native desktop',
    );
    expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
    expect(fixture.nativeElement.getAttribute('data-render-state')).toBe(
      'error',
    );
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
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
