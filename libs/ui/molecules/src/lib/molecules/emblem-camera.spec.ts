import { describe, expect, it } from 'vitest';
import { cameraTransform, idleMotionEnabled } from './emblem-camera';

describe('emblem camera', () => {
  it('looks down the common depth axis from the upper left and restores a front view', () => {
    expect(cameraTransform('idle')).toContain(
      'rotateX(-12deg) rotateY(-42deg)',
    );
    expect(cameraTransform('returning')).toBe(cameraTransform('idle'));
    for (const phase of [
      'focusing',
      'listening',
      'hangover',
      'docking',
      'presenting',
    ] as const)
      expect(cameraTransform(phase)).toContain(
        'rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)',
      );
  });

  it('limits autonomous movement to visible idle and return phases', () => {
    expect(idleMotionEnabled('idle', false)).toBe(true);
    expect(idleMotionEnabled('returning', false)).toBe(true);
    for (const phase of ['idle', 'listening', 'suspended', 'shutdown'] as const)
      expect(idleMotionEnabled(phase, true)).toBe(false);
    expect(idleMotionEnabled('suspended', false)).toBe(false);
  });
});
