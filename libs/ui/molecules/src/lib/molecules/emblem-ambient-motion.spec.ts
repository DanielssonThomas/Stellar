import { describe, expect, it, vi } from 'vitest';
import { createEmblemAmbientMotion } from './emblem-ambient-motion';

describe('emblem ambient motion', () => {
  it('snapshots all ambient poses before clearing any of them and avoids style reads when paused', () => {
    const elements = [
      document.createElement('div'),
      document.createElement('div'),
    ];
    for (const [index, element] of elements.entries()) {
      element.style.transform = `translateY(${index + 1}px)`;
      element.animate = vi.fn(
        () => ({ cancel: vi.fn() }) as unknown as Animation,
      );
    }
    const snapshots: string[][] = [];
    const getComputedStyle = vi.fn((element: Element) => {
      snapshots.push(elements.map((item) => item.style.transform));
      return {
        transform: (element as HTMLElement).style.transform,
      } as CSSStyleDeclaration;
    });
    const motion = createEmblemAmbientMotion({ getComputedStyle });
    const targets = elements.map((element, order) => ({ element, order }));
    motion.update(targets, true, false);
    expect(snapshots).toEqual([
      ['translateY(1px)', 'translateY(2px)'],
      ['translateY(1px)', 'translateY(2px)'],
    ]);
    getComputedStyle.mockClear();
    motion.update(targets, false, true);
    expect(getComputedStyle).not.toHaveBeenCalled();
    motion.dispose();
  });

  it('precesses rings independently, rebases assembly, and cancels suspended or removed work', () => {
    const animations: {
      cancel: ReturnType<typeof vi.fn>;
      onfinish: null | (() => void);
      oncancel: null | (() => void);
    }[] = [];
    const element = document.createElement('div');
    element.animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    const motion = createEmblemAmbientMotion({
      getComputedStyle: () =>
        ({ transform: 'matrix(1, 0, 0, 1, 0, 2)' }) as CSSStyleDeclaration,
    });
    const target = { element, spin: 'clockwise' as const, order: 0 };
    motion.update([target], true, false);
    expect(element.animate).toHaveBeenCalledWith(
      expect.arrayContaining([{ transform: 'rotateZ(360deg)' }]),
      expect.objectContaining({ iterations: Infinity }),
    );
    motion.update([target], true, false);
    expect(element.animate).toHaveBeenCalledTimes(1);
    motion.update([target], false, false);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(element.animate).toHaveBeenLastCalledWith(
      [{ transform: 'matrix(1, 0, 0, 1, 0, 2)' }, { transform: 'none' }],
      expect.objectContaining({ iterations: 1, duration: 1000 }),
    );
    motion.update([target], false, true);
    expect(animations[1].cancel).toHaveBeenCalledOnce();
    expect(element.style.transform).toBe('none');
    motion.update([{ ...target, order: -100 }], true, false);
    expect(element.animate).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ duration: 16000 }),
    );
    motion.update([], true, false);
    expect(animations[2].cancel).toHaveBeenCalledOnce();
    motion.dispose();
    motion.update([target], true, false);
    expect(animations).toHaveLength(3);
  });
});
