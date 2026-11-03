import type { MusicSnapshot, MusicStatus } from '../generated';
import {
  DesktopContractError,
  record,
  sequence,
  version,
} from './wire-validation';

const statuses: Record<MusicStatus, true> = {
  idle: true,
  starting: true,
  capturing: true,
  unavailable: true,
};

export function decodeMusicSnapshot(value: unknown): MusicSnapshot {
  const data = record(value, ['version', 'sequence', 'status', 'levels']);
  const levels = record(data['levels'], ['level', 'bass', 'mid', 'treble']);
  const status = data['status'];
  if (typeof status !== 'string' || !Object.hasOwn(statuses, status))
    throw new DesktopContractError('unknown-variant');
  const bounded = (value: unknown): number => {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      throw new DesktopContractError('malformed');
    return value;
  };
  return {
    version: version(data['version']),
    sequence: sequence(data['sequence']),
    status: status as MusicStatus,
    levels: {
      level: bounded(levels['level']),
      bass: bounded(levels['bass']),
      mid: bounded(levels['mid']),
      treble: bounded(levels['treble']),
    },
  };
}
