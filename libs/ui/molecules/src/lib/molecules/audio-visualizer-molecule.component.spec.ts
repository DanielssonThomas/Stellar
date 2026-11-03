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

  it('delegates mode selection and keeps sensitivity controls in every mode', async () => {
    const changed = vi.fn();
    fixture.componentInstance.modeChange.subscribe(changed);
    const modes = [
      ...fixture.nativeElement.querySelectorAll('.modes button'),
    ] as HTMLButtonElement[];
    expect(modes).toHaveLength(3);
    modes[2].click();
    expect(changed).toHaveBeenCalledWith('flashy');
    fixture.componentRef.setInput('mode', 'flashy');
    await fixture.whenStable();
    expect(modes[2].getAttribute('aria-pressed')).toBe('true');
    expect(
      fixture.nativeElement.querySelectorAll('input[type="range"]'),
    ).toHaveLength(4);
  });
});
