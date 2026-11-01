import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmblemMotionMolecule } from './emblem-motion-molecule.component';
import type { EmblemManifest } from './emblem-motion-model';

const manifest: EmblemManifest = {
  version: 1,
  viewBox: [0, 0, 512, 512],
  layers: [
    {
      id: 'outer',
      file: 'layers/outer.svg',
      z: 0,
      anchor: { x: 256, y: 256 },
      assembled: { x: 0, y: 0, rotation: 0 },
      exploded: { x: -128, y: 0, rotation: -8 },
      spin: 'clockwise',
    },
    {
      id: 'inner',
      file: 'layers/inner.svg',
      z: 1,
      anchor: { x: 256, y: 256 },
      assembled: { x: 0, y: 0, rotation: 0 },
      exploded: { x: 128, y: 0, rotation: 8 },
      spin: 'counter-clockwise',
    },
  ],
};

describe('EmblemMotionMolecule', () => {
  let fixture: ComponentFixture<EmblemMotionMolecule>;
  let animate: ReturnType<typeof vi.fn>;
  let animations: {
    cancel: ReturnType<typeof vi.fn>;
    onfinish: (() => void) | null;
    oncancel: (() => void) | null;
  }[];
  const previousAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'animate',
  );

  beforeEach(async () => {
    animations = [];
    animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    await TestBed.configureTestingModule({
      imports: [EmblemMotionMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(EmblemMotionMolecule);
    fixture.componentRef.setInput('manifest', manifest);
    fixture.componentRef.setInput('assetBasePath', '/assets/emblem');
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    if (previousAnimate)
      Object.defineProperty(HTMLElement.prototype, 'animate', previousAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    vi.restoreAllMocks();
  });

  it('renders independent inert SVG images, accessible label and supplied origins', () => {
    const images: HTMLImageElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('img'),
    );
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      '/assets/emblem/layers/outer.svg',
      '/assets/emblem/layers/inner.svg',
    ]);
    expect(
      fixture.nativeElement
        .querySelector('[role="img"]')
        .getAttribute('aria-label'),
    ).toBe('Stellar emblem');
    expect(
      fixture.nativeElement.querySelector('.plane').style.transformOrigin,
    ).toBe('50% 50%');
    expect(fixture.nativeElement.querySelector('svg,object,iframe')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('focuses layers and clamps audio without restarting an unchanged listening target', async () => {
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(
      fixture.nativeElement.querySelector('.plane').style.transform,
    ).toContain('-25%');
    fixture.componentRef.setInput('phase', 'listening');
    fixture.componentRef.setInput('audioLevel', 8);
    await fixture.whenStable();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(
      fixture.nativeElement
        .querySelector('.emblem')
        .style.getPropertyValue('--emblem-audio'),
    ).toBe('1');
    fixture.componentRef.setInput('audioLevel', NaN);
    await fixture.whenStable();
    expect(fixture.componentInstance.level()).toBe(0);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.style.left).toBe('');
  });

  it('cancels focus when returning and disposes remaining animations', async () => {
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    const focusing = [...animations];
    fixture.componentRef.setInput('phase', 'returning');
    await fixture.whenStable();
    expect(
      focusing.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    expect(animate.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 260 });
    fixture.destroy();
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
  });

  it('renders static reduced-motion geometry and pauses optional rings', async () => {
    fixture.componentRef.setInput('environment', true);
    fixture.componentRef.setInput('reducedMotion', true);
    fixture.componentRef.setInput('phase', 'listening');
    await fixture.whenStable();
    expect(animate).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('.plane').style.transform,
    ).toContain('translateZ(0px)');
    expect(
      fixture.nativeElement.querySelector('.motion-paused'),
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelectorAll('.spin-clockwise,.spin-counter'),
    ).toHaveLength(2);
  });

  it.each(['suspended', 'shutdown'])(
    'cancels animation for %s',
    async (phase) => {
      fixture.componentRef.setInput('phase', 'focusing');
      await fixture.whenStable();
      fixture.componentRef.setInput('phase', phase);
      await fixture.whenStable();
      expect(
        animations.every(
          (animation) => animation.cancel.mock.calls.length === 1,
        ),
      ).toBe(true);
      expect(animate).toHaveBeenCalledTimes(2);
      expect(fixture.componentInstance.paused()).toBe(true);
    },
  );

  it('pauses when hidden or inactive and removes its visibility listener', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await fixture.whenStable();
    expect(fixture.componentInstance.paused()).toBe(true);
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
    fixture.componentRef.setInput('active', false);
    await fixture.whenStable();
    fixture.destroy();
    expect(remove).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
  });

  it('replaces imagery with the shared skeleton and cancels work while loading', async () => {
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(
      animations.every((animation) => animation.cancel.mock.calls.length === 1),
    ).toBe(true);
  });

  it('falls back on asset failure and recovers with a replacement manifest', async () => {
    fixture.nativeElement
      .querySelector('img')
      .dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Emblem unavailable');
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    fixture.componentRef.setInput('manifest', { ...manifest });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('img')).toHaveLength(2);
    fixture.componentRef.setInput('error', 'Host asset failure');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Emblem unavailable');
  });

  it('rejects invalid manifests and unsafe prefixes without inserting image sources', async () => {
    fixture.componentRef.setInput('assetBasePath', 'https://foreign.example');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    fixture.componentRef.setInput('assetBasePath', '');
    fixture.componentRef.setInput('manifest', {
      ...manifest,
      viewBox: [0, 0, 0, 512],
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Emblem unavailable');
  });
});
