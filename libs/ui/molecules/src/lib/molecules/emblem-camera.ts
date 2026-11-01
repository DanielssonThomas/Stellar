import type { Phase } from '@stellar/desktop-interaction';
import { isExplodedPhase } from './emblem-motion-model';

const IDLE_CAMERA =
  'perspective(300cqw) rotateX(-12deg) rotateY(-42deg) scale3d(0.72, 0.72, 0.72)';
const ACTIVE_CAMERA =
  'perspective(300cqw) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';

export function cameraTransform(phase: Phase): string {
  return isExplodedPhase(phase) ? IDLE_CAMERA : ACTIVE_CAMERA;
}

export function idleMotionEnabled(phase: Phase, paused: boolean): boolean {
  return !paused && (phase === 'idle' || phase === 'returning');
}
