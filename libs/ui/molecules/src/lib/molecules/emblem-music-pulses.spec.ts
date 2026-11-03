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
  for (const element of elements)
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
    },
  ];
  const style = vi.fn(
    () =>
      ({
        transform: 'matrix(1,0,0,1,10,0)',
        opacity: '0.5',
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
      expect.arrayContaining([{ transform: 'none', opacity: 1, offset: 1 }]),
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
      state.elements.every((element) => element.style.opacity === '0.62'),
    ).toBe(true);
    expect(state.elements[2].animate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { opacity: 0.62, offset: 1 },
        { opacity: 1, offset: 0.22 },
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
    expect(state.elements[2].animate).toHaveBeenLastCalledWith(
      [{ opacity: '0.5' }, { opacity: '1' }],
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
});
