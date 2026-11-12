import { describe, expect, it } from 'vitest';
import { decodeAwarenessSnapshot } from './awareness-codec';

const snapshot = () => ({
  version: 1,
  revision: '3',
  enabled: true,
  app_health: 'available',
  media_health: 'available',
  media_observed_at_ms: '124',
  foreground: { app: 'game.exe', title: 'Racing', observed_at_ms: '123' },
  last_external: null,
  spotify: {
    title: 'Track',
    artist: 'Artist',
    playing: true,
    observed_at_ms: '124',
  },
  workspace: null,
});
describe('awareness wire validation', () => {
  it('preserves bounded source observations without interpreting metadata', () => {
    const frame = snapshot();
    frame.foreground.title = '<script>data</script>';
    expect(decodeAwarenessSnapshot(frame).foreground?.title).toBe(
      frame.foreground.title,
    );
  });
  it('rejects unknown variants, malformed clocks and impossible paused state', () => {
    for (const frame of [
      { ...snapshot(), media_health: 'invented' },
      { ...snapshot(), enabled: false },
      { ...snapshot(), revision: '-1' },
      { ...snapshot(), extra: 'data' },
      {
        ...snapshot(),
        foreground: { ...snapshot().foreground, title: 'a\nb' },
      },
      { ...snapshot(), spotify: { ...snapshot().spotify, playing: 'yes' } },
    ])
      expect(() => decodeAwarenessSnapshot(frame)).toThrow();
  });
  it('rejects oversized workspace and unsupported surfaces', () => {
    const pane = {
      title: 'Pane',
      surface: 'browser',
      selected: true,
      minimized: false,
    };
    expect(() =>
      decodeAwarenessSnapshot({
        ...snapshot(),
        workspace: { version: 1, epoch: '0', panes: Array(9).fill(pane) },
      }),
    ).toThrow();
    expect(() =>
      decodeAwarenessSnapshot({
        ...snapshot(),
        workspace: {
          version: 1,
          epoch: '0',
          panes: [{ ...pane, surface: 'executable' }],
        },
      }),
    ).toThrow();
  });
  it('preserves a mixed chart and text workspace through snapshot decoding', () => {
    const workspace = {
      version: 1,
      epoch: '4',
      panes: [
        {
          title: 'Weekly visits',
          surface: 'chart',
          selected: true,
          minimized: false,
        },
        {
          title: 'Report',
          surface: 'rich-text',
          selected: false,
          minimized: true,
        },
      ],
    };
    expect(
      decodeAwarenessSnapshot({ ...snapshot(), workspace }).workspace,
    ).toEqual(workspace);
    for (const panes of [
      [...workspace.panes, { ...workspace.panes[0], surface: 'unknown-chart' }],
      Array(9).fill(workspace.panes[0]),
      [{ ...workspace.panes[0], title: 'x'.repeat(81) }],
    ]) {
      expect(() =>
        decodeAwarenessSnapshot({
          ...snapshot(),
          workspace: { ...workspace, panes },
        }),
      ).toThrow();
    }
  });
});
