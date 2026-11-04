import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageRenderState, settleStage } from './stage-observation';

describe('observed Stage rendering', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });
  function fixture() {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const host = document.createElement('div');
    const panel = document.createElement('section');
    panel.dataset['instanceId'] = 'pane';
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      width: 220,
      height: 140,
      x: 0,
      y: 0,
    } as DOMRect);
    const media = document.createElement('div');
    panel.append(media);
    host.append(panel);
    document.body.append(host);
    return {
      host,
      panel,
      media,
      state: () => stageRenderState(host, 'pane', false),
    };
  }
  it('uses actual mounted media state and never reports hidden, failed or absent content as ready', () => {
    const f = fixture();
    expect(f.state()).toBe('ready');
    for (const state of ['loading', 'error', 'unavailable', 'ready']) {
      f.media.dataset['renderState'] = state;
      expect(f.state()).toBe(state);
    }
    expect(stageRenderState(f.host, 'pane', true)).toBe('hidden');
    expect(stageRenderState(f.host, 'missing', false)).toBe('unavailable');
    f.panel.setAttribute('aria-hidden', 'true');
    expect(f.state()).toBe('hidden');
    f.panel.removeAttribute('aria-hidden');
    f.host.remove();
    expect(f.state()).toBe('unavailable');
  });
  it('waits for media and stable geometry, bounds perpetual loading and exits on cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.media.dataset['renderState'] = 'loading';
    const observe: Parameters<typeof settleStage>[1] = () => [
      { render_state: f.state() },
    ];
    const finished = vi.fn();
    const pending = settleStage(f.host, observe, () => true).then(finished);
    await vi.advanceTimersByTimeAsync(200);
    expect(finished).not.toHaveBeenCalled();
    f.media.dataset['renderState'] = 'ready';
    await vi.advanceTimersByTimeAsync(150);
    await pending;
    expect(finished).toHaveBeenCalledOnce();
    f.media.dataset['renderState'] = 'loading';
    const bounded = settleStage(f.host, observe, () => true);
    await vi.advanceTimersByTimeAsync(4000);
    await bounded;
    expect(f.state()).toBe('loading');
    let current = true;
    const cancelled = settleStage(f.host, observe, () => current);
    current = false;
    await vi.advanceTimersByTimeAsync(50);
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });
});
