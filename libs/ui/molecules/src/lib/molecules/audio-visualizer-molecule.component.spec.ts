import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioVisualizerMolecule } from './audio-visualizer-molecule.component';

describe('AudioVisualizerMolecule', () => {
  let fixture: ComponentFixture<AudioVisualizerMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AudioVisualizerMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(AudioVisualizerMolecule);
    await fixture.whenStable();
  });

  it('offers four labelled sensitivity sliders and delegates listening explicitly', () => {
    expect(
      fixture.nativeElement.querySelectorAll('input[type="range"]'),
    ).toHaveLength(4);
    const changed = vi.fn();
    fixture.componentInstance.sensitivityChange.subscribe(changed);
    const bass: HTMLInputElement =
      fixture.nativeElement.querySelector('#music-bass');
    bass.value = '175';
    bass.dispatchEvent(new Event('input'));
    expect(changed).toHaveBeenCalledWith({ band: 'bass', value: 1.75 });
    const toggle = vi.fn();
    fixture.componentInstance.listeningChange.subscribe(toggle);
    fixture.nativeElement.querySelector('.listen-button').click();
    expect(toggle).toHaveBeenCalledWith(true);
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
