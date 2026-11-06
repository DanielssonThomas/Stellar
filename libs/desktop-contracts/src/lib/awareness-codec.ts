import type {
  AwarenessApp,
  AwarenessHealth,
  AwarenessMedia,
  AwarenessSnapshot,
  AwarenessWorkspace,
} from '../generated';
import {
  boundedString,
  DesktopContractError,
  record,
  sequence,
  version,
} from './wire-validation';

function text(value: unknown, limit: number): string {
  const label = boundedString(value, limit * 4);
  if (
    [...label].length > limit ||
    [...label].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new DesktopContractError('malformed');
  return label;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DesktopContractError('malformed');
  return value;
}
function health(value: unknown): AwarenessHealth {
  if (value !== 'available' && value !== 'unavailable' && value !== 'paused')
    throw new DesktopContractError('unknown-variant');
  return value;
}
function app(value: unknown): AwarenessApp | null {
  if (value === null) return null;
  const data = record(value, ['app', 'title', 'observed_at_ms']);
  const name = text(data['app'], 120);
  if (!name) throw new DesktopContractError('malformed');
  return {
    app: name,
    title: text(data['title'], 160),
    observed_at_ms: sequence(data['observed_at_ms']),
  };
}
function media(value: unknown): AwarenessMedia | null {
  if (value === null) return null;
  const data = record(value, ['title', 'artist', 'playing', 'observed_at_ms']);
  return {
    title: text(data['title'], 160),
    artist: text(data['artist'], 160),
    playing: flag(data['playing']),
    observed_at_ms: sequence(data['observed_at_ms']),
  };
}
function workspace(value: unknown): AwarenessWorkspace | null {
  if (value === null) return null;
  const data = record(value, ['version', 'epoch', 'panes']);
  if (!Array.isArray(data['panes']) || data['panes'].length > 8)
    throw new DesktopContractError('malformed');
  return {
    version: version(data['version']),
    epoch: sequence(data['epoch']),
    panes: data['panes'].map((value: unknown) => {
      const pane = record(value, ['title', 'surface', 'selected', 'minimized']);
      const surface = text(pane['surface'], 40);
      if (
        ![
          'rich-text',
          'image',
          'browser',
          'diagram',
          'workflow',
          'session',
          'assistant-message',
          'activity-summary',
        ].includes(surface)
      )
        throw new DesktopContractError('unknown-variant');
      return {
        title: text(pane['title'], 80),
        surface,
        selected: flag(pane['selected']),
        minimized: flag(pane['minimized']),
      };
    }),
  };
}
export function decodeAwarenessSnapshot(value: unknown): AwarenessSnapshot {
  const data = record(value, [
    'version',
    'revision',
    'enabled',
    'app_health',
    'media_health',
    'media_observed_at_ms',
    'foreground',
    'last_external',
    'spotify',
    'workspace',
  ]);
  const result: AwarenessSnapshot = {
    version: version(data['version']),
    revision: sequence(data['revision']),
    enabled: flag(data['enabled']),
    app_health: health(data['app_health']),
    media_health: health(data['media_health']),
    media_observed_at_ms:
      data['media_observed_at_ms'] === null
        ? null
        : sequence(data['media_observed_at_ms']),
    foreground: app(data['foreground']),
    last_external: app(data['last_external']),
    spotify: media(data['spotify']),
    workspace: workspace(data['workspace']),
  };
  if (
    (!result.enabled &&
      (result.app_health !== 'paused' ||
        result.media_health !== 'paused' ||
        result.media_observed_at_ms ||
        result.foreground ||
        result.last_external ||
        result.spotify ||
        result.workspace)) ||
    (result.enabled &&
      (result.app_health === 'paused' || result.media_health === 'paused')) ||
    (result.app_health !== 'available' && result.foreground !== null) ||
    (result.media_health !== 'available' &&
      (result.spotify !== null || result.media_observed_at_ms !== null)) ||
    (result.media_health === 'available' &&
      result.media_observed_at_ms === null)
  )
    throw new DesktopContractError('malformed');
  return result;
}
