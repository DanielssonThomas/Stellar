import { describe, expect, it, vi } from 'vitest';
import { createStageMotion, revealOrigin } from './stage-motion';

describe('Stage structural motion', () => {
  it('reveals supporting panes from the edge being reclaimed from existing content', () => {
    const full = { x: 0, y: 0, width: 1000, height: 800 };
    expect(
      revealOrigin({ x: 540, y: 0, width: 460, height: 800 }, [full]),
    ).toEqual({ x: 1000, y: 0, width: 0, height: 800 });
    expect(
      revealOrigin({ x: 540, y: 400, width: 460, height: 400 }, [
        { x: 540, y: 0, width: 460, height: 800 },
      ]),
    ).toEqual({ x: 540, y: 800, width: 460, height: 0 });
    expect(
      revealOrigin({ x: 0, y: 0, width: 540, height: 800 }, [full]),
    ).toEqual({ x: 0, y: 0, width: 0, height: 800 });
  });
  it('captures an interrupted intermediate rectangle and cancels owned animation on replacement/disposal', () => {
    const element = document.createElement('section');
    element.dataset['instanceId'] = 'one';
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
      timeline: { currentTime: 23 },
      startTime: 0,
    } as unknown as Animation;
    const animate = vi.fn().mockReturnValue(animation);
    Object.assign(element, { animate });
    const getComputedStyle = vi
      .fn()
      .mockReturnValue({
        left: '0px',
        top: '0px',
        width: '760px',
        height: '800px',
      });
    const motion = createStageMotion({ getComputedStyle });
    motion.capture([element]);
    motion.update(
      [{ element, instanceId: 'one', x: 0, y: 0, width: 540, height: 800 }],
      false,
    );
    expect(animate.mock.calls[0][0][0].width).toBe('760px');
    expect(animation.startTime).toBe(23);
    getComputedStyle.mockReturnValue({
      left: '0px',
      top: '0px',
      width: '650px',
      height: '800px',
    });
    motion.capture([element]);
    motion.update(
      [{ element, instanceId: 'one', x: 0, y: 0, width: 1000, height: 800 }],
      false,
    );
    expect(animate.mock.calls[1][0][0].width).toBe('650px');
    expect(animation.cancel).toHaveBeenCalledOnce();
    motion.dispose();
    expect(animation.cancel).toHaveBeenCalledTimes(2);
  });
  it('does not animate updates without a structural change or with reduced motion', () => {
    const element = document.createElement('section');
    element.dataset['instanceId'] = 'one';
    const animate = vi.fn();
    Object.assign(element, { animate });
    const motion = createStageMotion({
      getComputedStyle: () =>
        ({
          left: '0px',
          top: '0px',
          width: '100px',
          height: '100px',
        }) as CSSStyleDeclaration,
    });
    motion.capture([element]);
    motion.update(
      [{ element, instanceId: 'one', x: 0, y: 0, width: 100, height: 100 }],
      false,
    );
    motion.capture([element]);
    motion.update(
      [{ element, instanceId: 'one', x: 0, y: 0, width: 200, height: 100 }],
      true,
    );
    expect(animate).not.toHaveBeenCalled();
    motion.dispose();
  });
});
