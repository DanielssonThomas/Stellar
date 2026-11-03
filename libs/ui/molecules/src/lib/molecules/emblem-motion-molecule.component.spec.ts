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

  it('adds music without restarting individual floats, and neutralizes it during activity or reduced motion', async () => {
    fixture.componentRef.setInput('manifest', {
      ...manifest,
      layers: [{ ...manifest.layers[0], spin: undefined }],
    });
    await fixture.whenStable();
    const before = animate.mock.calls.length;
    fixture.componentRef.setInput('musicLevels', {
      level: 0.7,
      bass: 0.8,
      mid: 0.4,
      treble: 0.2,
    });
    await fixture.whenStable();
    const music = fixture.nativeElement.querySelector(
      '.music-piece',
    ) as HTMLElement;
    expect(music.style.transform).toContain('1.248%');
    expect(animate.mock.calls).toHaveLength(before);
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    expect(music.style.transform).toBe('none');
    fixture.componentRef.setInput('phase', 'idle');
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(music.style.transform).toBe('none');
  });

  it('explodes a fault without changing canonical layers and restores the selected pose after recovery', async () => {
    fixture.componentRef.setInput('phase', 'listening');
    fixture.componentRef.setInput('solActive', true);
    fixture.componentRef.setInput('fault', true);
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(fixture.componentInstance.posePhase()).toBe('idle');
    expect(
      fixture.nativeElement.querySelector('.fault-identity'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.sol-accents')).toBeNull();
    expect(fixture.nativeElement.querySelector('.idle-motion')).toBeNull();
    expect(
      fixture.nativeElement
        .querySelector('[role="img"]')
        .getAttribute('aria-label'),
    ).toContain('error state');
    expect(fixture.nativeElement.querySelector('img').style.filter).toContain(
      'fault-light',
    );
    expect(fixture.componentInstance.layers().map((layer) => layer.id)).toEqual(
      ['outer', 'inner'],
    );
    fixture.componentRef.setInput('fault', false);
    await fixture.whenStable();
    expect(fixture.componentInstance.posePhase()).toBe('listening');
    expect(fixture.nativeElement.querySelector('img').style.filter).toBe('');
  });

  it('shows a separate star ring only while waiting and suppresses it on suspension', async () => {
    fixture.componentRef.setInput('phase', 'listening');
    fixture.componentRef.setInput('waiting', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelectorAll('.waiting-ring path'),
    ).toHaveLength(4);
    expect(
      fixture.nativeElement.querySelector('.waiting-response'),
    ).not.toBeNull();
    fixture.componentRef.setInput('reducedMotion', true);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector(
        '.waiting-response.motion-paused.motion-reduced',
      ),
    ).not.toBeNull();
    fixture.componentRef.setInput('waiting', false);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.waiting-ring')).toBeNull();
    expect(fixture.nativeElement.querySelector('.waiting-response')).toBeNull();
    fixture.componentRef.setInput('waiting', true);
    fixture.componentRef.setInput('phase', 'suspended');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.waiting-ring')).toBeNull();
  });

  it('shows one concentric Sol ring and two eye glints only after assembly settles', async () => {
    fixture.componentRef.setInput('solActive', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.sol-accents')).toBeNull();
    fixture.componentRef.setInput('phase', 'listening');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.sol-accents')).toBeNull();
    for (const animation of animations) animation.onfinish?.();
    await fixture.whenStable();
    const ring = fixture.nativeElement.querySelector('.sol-ring');
    expect(fixture.nativeElement.querySelectorAll('.sol-ring')).toHaveLength(1);
    expect([
      ring.getAttribute('cx'),
      ring.getAttribute('cy'),
      ring.getAttribute('r'),
    ]).toEqual(['640', '640', '510']);
    expect(fixture.nativeElement.querySelectorAll('mask path')).toHaveLength(4);
    expect(ring.getAttribute('mask')).toBe(
      `url(#${fixture.componentInstance.solMaskId})`,
    );
    expect(
      fixture.nativeElement
        .querySelector('.sol-eye')
        .getAttribute('d')
        .match(/M/g),
    ).toHaveLength(2);
    fixture.componentRef.setInput('solActive', false);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.sol-accents')).toBeNull();
  });

  it('keeps body fragments during motion and consolidates only after real settlement', async () => {
    fixture.componentRef.setInput('manifest', {
      ...manifest,
      layers: manifest.layers.map((layer, index) => ({
        ...layer,
        file: 'layers/body.png',
        clip: [0, index * 256, 512, 256],
      })),
    });
    await fixture.whenStable();
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    expect(
      fixture.componentInstance.layers().map((layer) => layer.clipPath),
    ).toEqual(['inset(0% 0% 50% 0%)', 'inset(50% 0% 0% 0%)']);
    for (const animation of animations) animation.onfinish?.();
    await fixture.whenStable();
    expect(
      fixture.componentInstance.layers().map((layer) => layer.clipPath),
    ).toEqual(['none', 'inset(100%)']);
    fixture.componentRef.setInput('phase', 'returning');
    await fixture.whenStable();
    expect(
      fixture.componentInstance.layers().map((layer) => layer.clipPath),
    ).toEqual(['inset(0% 0% 50% 0%)', 'inset(50% 0% 0% 0%)']);
  });

  it('preloads strand originals and swaps only at settlement, restoring pieces on return', async () => {
    fixture.componentRef.setInput('manifest', {
      ...manifest,
      layers: manifest.layers.map((layer, index) => ({
        ...layer,
        file: `layers/strand-${index}.png`,
        assembly: { file: 'layers/hair.png', index, count: 2 },
      })),
    });
    await fixture.whenStable();
    expect(fixture.componentInstance.assemblySources()).toEqual([
      { src: '/assets/emblem/layers/hair.png', srcset: null },
    ]);
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    expect(
      fixture.componentInstance.layers().map((layer) => layer.src),
    ).toEqual([
      '/assets/emblem/layers/strand-0.png',
      '/assets/emblem/layers/strand-1.png',
    ]);
    for (const animation of animations) animation.onfinish?.();
    await fixture.whenStable();
    expect(
      fixture.componentInstance
        .layers()
        .map((layer) => [layer.src, layer.clipPath]),
    ).toEqual([
      ['/assets/emblem/layers/hair.png', 'none'],
      ['/assets/emblem/layers/hair.png', 'inset(100%)'],
    ]);
    fixture.componentRef.setInput('phase', 'returning');
    await fixture.whenStable();
    expect(
      fixture.componentInstance.layers().map((layer) => layer.src),
    ).toEqual([
      '/assets/emblem/layers/strand-0.png',
      '/assets/emblem/layers/strand-1.png',
    ]);
    fixture.nativeElement
      .querySelector('.emblem-presence > img')
      .dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(fixture.componentInstance.unavailable()).toBe(true);
  });

  it('waits for container measurement and sizes fragments and preloaded originals without restarting motion', async () => {
    fixture.componentRef.setInput('manifest', {
      ...manifest,
      rasterSizes: [128, 256],
      layers: manifest.layers.map((layer, index) => ({
        ...layer,
        file: `layers/hair-${index}.png`,
        assembly: { file: 'layers/hair.png', index, count: 2 },
      })),
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('img')).toHaveLength(0);
    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    const width = vi
      .spyOn(fixture.nativeElement, 'clientWidth', 'get')
      .mockReturnValue(96);
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    const images: HTMLImageElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('img'),
    );
    expect(images).toHaveLength(3);
    expect(images.every((image) => image.sizes === '96px')).toBe(true);
    expect(images[0].srcset).toContain(
      '/assets/emblem/resolutions/128/layers/hair.png 128w',
    );
    expect(images[1].srcset).toContain(
      '/assets/emblem/resolutions/256/layers/hair-0.png 256w',
    );
    expect(images[1].srcset).toContain('/assets/emblem/layers/hair-0.png 512w');
    const animationCount = animate.mock.calls.length;
    width.mockReturnValue(400);
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    expect(images.every((image) => image.sizes === '400px')).toBe(true);
    expect(animate).toHaveBeenCalledTimes(animationCount);
  });

  it('keeps independent floats for every non-ring fragment and retains existing ring spin', async () => {
    fixture.componentRef.setInput('manifest', {
      ...manifest,
      layers: [
        ...manifest.layers,
        ...Array.from({ length: 20 }, (_, index) => ({
          ...manifest.layers[0],
          id: `fragment-${index}`,
          z: index + 2,
          spin: undefined,
        })),
      ],
    });
    animate.mockClear();
    await fixture.whenStable();
    const infinite = animate.mock.calls.filter(
      (call) => call[1]?.iterations === Infinity,
    );
    expect(infinite).toHaveLength(20);
    expect(
      fixture.nativeElement.querySelectorAll('.camera .plane'),
    ).toHaveLength(22);
    expect(
      fixture.nativeElement.querySelectorAll('.spin-clockwise,.spin-counter'),
    ).toHaveLength(2);
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
    expect(
      fixture.nativeElement.querySelector(
        'svg:not(.filter-definitions),object,iframe',
      ),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelectorAll('.filter-definitions filter'),
    ).toHaveLength(2);
    expect(
      animate.mock.calls.filter((call) => call[1]?.iterations !== Infinity),
    ).toHaveLength(0);
  });

  it('focuses layers and clamps audio without restarting an unchanged listening target', async () => {
    fixture.componentRef.setInput('phase', 'focusing');
    await fixture.whenStable();
    expect(
      animate.mock.calls.filter((call) => call[1]?.iterations !== Infinity),
    ).toHaveLength(3);
    expect(
      fixture.nativeElement.querySelector('.plane').style.transform,
    ).toContain('translate(0% , 0%)');
    fixture.componentRef.setInput('phase', 'listening');
    fixture.componentRef.setInput('audioLevel', 8);
    await fixture.whenStable();
    expect(
      animate.mock.calls.filter((call) => call[1]?.iterations !== Infinity),
    ).toHaveLength(3);
    expect(
      fixture.nativeElement
        .querySelector('.emblem')
        .style.getPropertyValue('--emblem-audio'),
    ).toBe('1');
    fixture.componentRef.setInput('audioLevel', NaN);
    await fixture.whenStable();
    expect(fixture.componentInstance.level()).toBe(0);
    expect(
      animate.mock.calls.filter((call) => call[1]?.iterations !== Infinity),
    ).toHaveLength(3);
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
    expect(animate.mock.calls.some((call) => call[1]?.duration === 1000)).toBe(
      true,
    );
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
    expect(
      animate.mock.calls.filter((call) => call[1]?.iterations !== Infinity),
    ).toHaveLength(0);
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
      expect(
        animate.mock.calls.filter((call) => call[1]?.iterations !== Infinity),
      ).toHaveLength(3);
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
