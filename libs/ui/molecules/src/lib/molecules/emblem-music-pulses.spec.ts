import { describe, expect, it, vi } from 'vitest';
import { createEmblemMusicPulses } from './emblem-music-pulses';
import { silentEmblemMusic } from './emblem-music-motion';
import type { EmblemLayer } from './emblem-motion-model';

const ring: EmblemLayer = {
  id: 'arc',
  file: 'arc.png',
  z: 1,
  anchor: { x: 640, y: 640 },
  assembled: { x: 0, y: 0, rotation: 0 },
  exploded: { x: 0, y: 0, rotation: 0 },
  spin: 'clockwise',
  assembly: { file: 'ring.svg', index: 0, count: 3 },
};
const loud = { level: 0.8, bass: 0.9, mid: 0.5, treble: 0.3 };
function setup() {
  let time = 0;
  const animations: {
    cancel: ReturnType<typeof vi.fn>;
    onfinish: (() => void) | null;
  }[] = [];
  const elements = Array.from({ length: 3 }, () =>
    document.createElement('div'),
  );
  const region = document.createElement('div');
  for (const element of [...elements, region])
    element.animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation as unknown as Animation;
    });
  const targets = [
    { element: elements[0], layer: ring, order: 1 },
    { element: elements[1], layer: { ...ring, assembly: undefined }, order: 2 },
    {
      element: elements[2],
      layer: { ...ring, spin: undefined, assembly: undefined },
      order: 3,
      regions: [region],
    },
  ];
  const style = vi.fn(
    () =>
      ({
        transform: 'matrix(1,0,0,1,10,0)',
        filter: 'brightness(1.6)',
        opacity: '0.6',
      }) as CSSStyleDeclaration,
  );
  const pulses = createEmblemMusicPulses(
    { getComputedStyle: style },
    () => time,
  );
  return {
    pulses,
    targets,
    elements,
    region,
    animations,
    style,
    advance: (value: number) => {
      time += value;
    },
  };
}
describe('music transients', () => {
  it('returns ring arcs to identity, leaves whole rings untouched, and rate limits new beats', () => {
    const state = setup();
    state.pulses.update(state.targets, loud, 'dynamic', true, false);
    expect(state.elements[0].animate).toHaveBeenCalledOnce();
    expect(state.elements[1].animate).not.toHaveBeenCalled();
    expect(state.elements[2].animate).not.toHaveBeenCalled();
    expect(state.elements[0].animate).toHaveBeenCalledWith(
      expect.arrayContaining([{ transform: 'none', offset: 1 }]),
      expect.objectContaining({ duration: 440 }),
    );
    state.advance(1000);
    state.pulses.update(state.targets, loud, 'dynamic', true, false);
    expect(state.elements[0].animate).toHaveBeenCalledOnce();
    state.pulses.update(
      state.targets,
      silentEmblemMusic,
      'dynamic',
      true,
      false,
    );
    state.advance(1);
    state.pulses.update(state.targets, loud, 'dynamic', true, false);
    expect(state.elements[0].animate).toHaveBeenCalledTimes(2);
    state.pulses.update(
      state.targets,
      silentEmblemMusic,
      'dynamic',
      true,
      false,
    );
    state.advance(20);
    state.pulses.update(state.targets, loud, 'dynamic', true, false);
    expect(state.elements[0].animate).toHaveBeenCalledTimes(2);
    state.pulses.dispose();
    expect(state.animations.at(-1)?.cancel).toHaveBeenCalledOnce();
  });
  it('blinks selected individual fragments only in Flashy and smoothly settles on activity', () => {
    const state = setup();
    state.pulses.update(state.targets, loud, 'flashy', true, false);
    expect(
      state.elements.every(
        (element) =>
          element.style.opacity === '1' &&
          element.style.filter === 'brightness(0.72)',
      ),
    ).toBe(true);
    expect(state.region.animate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { opacity: 0, offset: 1 },
        { opacity: 1, offset: 0.18 },
      ]),
      expect.any(Object),
    );
    state.pulses.update(
      state.targets,
      silentEmblemMusic,
      'flashy',
      false,
      false,
    );
    expect(state.region.animate).toHaveBeenLastCalledWith(
      [{ opacity: '0.6' }, { opacity: '0' }],
      expect.objectContaining({ duration: 160 }),
    );
    expect(state.elements[0].style.transform).toBe('none');
    expect(
      state.elements.every((element) => element.style.opacity === '1'),
    ).toBe(true);
    state.style.mockClear();
    state.pulses.update(state.targets, silentEmblemMusic, 'calm', false, true);
    expect(state.style).not.toHaveBeenCalled();
    state.pulses.dispose();
  });

  it('gives the closest ring on each side an independent bass-only linear size release', () => {
    const state = setup();
    const near = [
      {
        element: state.elements[0],
        layer: {
          ...ring,
          id: 'near-left',
          exploded: { ...ring.exploded, depth: -170 },
        },
        order: 0,
      },
      {
        element: state.elements[1],
        layer: {
          ...ring,
          id: 'near-right',
          assembly: { ...ring.assembly!, file: 'right.svg' },
          exploded: { ...ring.exploded, depth: 150 },
        },
        order: 1,
      },
      {
        element: state.elements[2],
        layer: { ...ring, id: 'middle', assembly: undefined },
        order: 2,
      },
    ];
    state.pulses.update(
      near,
      { ...silentEmblemMusic, treble: 1 },
      'dynamic',
      true,
      false,
    );
    expect(
      state.elements.every(
        (element) => vi.mocked(element.animate).mock.calls.length === 0,
      ),
    ).toBe(true);
    state.advance(20);
    state.pulses.update(near, loud, 'dynamic', true, false);
    for (const element of state.elements.slice(0, 2)) {
      expect(element.animate).toHaveBeenCalledWith(
        [{ transform: 'scale(1.54)' }, { transform: 'none' }],
        expect.objectContaining({ easing: 'linear' }),
      );
      const options = vi.mocked(element.animate).mock
        .calls[0][1] as KeyframeAnimationOptions;
      expect(options.duration).toBeCloseTo(3375);
    }
    expect(state.elements[2].animate).not.toHaveBeenCalled();
    state.advance(1000);
    state.pulses.update(near, loud, 'dynamic', true, false);
    expect(state.elements[0].animate).toHaveBeenCalledOnce();
    state.pulses.update(near, silentEmblemMusic, 'dynamic', false, true);
    expect(
      state.animations.every(
        (animation) => animation.cancel.mock.calls.length === 1,
      ),
    ).toBe(true);
    state.pulses.dispose();
  });
});
