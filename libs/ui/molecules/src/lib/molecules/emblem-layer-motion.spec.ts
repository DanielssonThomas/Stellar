import { describe, expect, it, vi } from 'vitest';
import { createEmblemLayerMotion } from './emblem-layer-motion';

function setup() {
  const element = document.createElement('div');
  const animations: {
    onfinish: (() => void) | null;
    oncancel: (() => void) | null;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const animate = vi.fn<
    (frames: Keyframe[], options: KeyframeAnimationOptions) => Animation
  >(() => {
    const animation = { onfinish: null, oncancel: null, cancel: vi.fn() };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  element.animate = animate;
  const motion = createEmblemLayerMotion({
    getComputedStyle: () =>
      ({ transform: 'matrix(1, 0, 0, 1, 12, 3)' }) as CSSStyleDeclaration,
  });
  motion.update([{ element, transform: 'translateX(0%)' }], 220);
  return { element, animate, animations, motion };
}

describe('emblem layer motion', () => {
  it('rebases interrupted transitions from rendered transforms', () => {
    const { element, animate, animations, motion } = setup();
    motion.update([{ element, transform: 'translateX(25%)' }], 220);
    motion.update([{ element, transform: 'translateX(0%)' }], 260);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animations[0].onfinish).toBeNull();
    expect(animate.mock.calls[1][0]).toEqual([
      { transform: 'matrix(1, 0, 0, 1, 12, 3)' },
      { transform: 'translateX(0%)' },
    ]);
    expect(element.style.transform).toBe('translateX(0%)');
    motion.dispose();
  });

  it('retains identical targets, cancels removed layers and ignores updates after disposal', () => {
    const { element, animate, animations, motion } = setup();
    motion.update([{ element, transform: 'translateX(25%)' }], 220);
    motion.update([{ element, transform: 'translateX(25%)' }], 220);
    expect(animate).toHaveBeenCalledOnce();
    motion.update([], 220);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    motion.dispose();
    motion.dispose();
    motion.update([{ element, transform: 'translateX(50%)' }], 220);
    expect(animate).toHaveBeenCalledOnce();
  });

  it('cancels animation and settles immediately when motion pauses', () => {
    const { element, animate, animations, motion } = setup();
    motion.update([{ element, transform: 'translateX(25%)' }], 220);
    motion.update([{ element, transform: 'translateX(25%)' }], 0);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledOnce();
    expect(element.style.transform).toBe('translateX(25%)');
    motion.dispose();
  });

  it('keeps final styles after completion and supports non-browser environments', () => {
    const { element, animations, motion } = setup();
    motion.update([{ element, transform: 'translateX(25%)' }], 220);
    animations[0].onfinish?.();
    motion.dispose();
    expect(animations[0].cancel).not.toHaveBeenCalled();
    expect(element.style.transform).toBe('translateX(25%)');
    const staticMotion = createEmblemLayerMotion(null);
    staticMotion.update([{ element, transform: 'none' }], 0);
    expect(element.style.transform).toBe('none');
  });
});
