import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AudioActivityState } from '@stellar/service-audio-activity';
import {
  createStageRegistry,
  decodeActivitySummary,
} from '@stellar/ui-organisms';
import { DesktopSession } from './desktop-session';
import { motionDurations } from '@stellar/desktop-interaction';

function setup() {
  vi.useFakeTimers();
  const audio = {
    startMicrophone: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const registry = createStageRegistry({
    'activity-summary': decodeActivitySummary,
  });
  const commands = vi.fn((command) => registry.dispatch(command));
  const session = new DesktopSession({
    audio,
    now: () => Date.now(),
    onState: vi.fn(),
    onCommand: commands,
    clock: {
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
  });
  return { session, audio, registry, commands };
}
const audioState = (
  status: AudioActivityState['status'],
  active = false,
): AudioActivityState => ({
  status,
  activity: {
    active,
    calibrating: false,
    level: active ? 0.5 : 0,
    peakLevel: 0.7,
    durationMs: 3000,
    noiseFloor: 0.01,
    clipped: false,
  },
});

describe('desktop composition session', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the real controller and registry for repeated manual loops without capture', () => {
    const { session, audio, registry } = setup();
    for (let count = 0; count < 3; count++) {
      session.dispatch({ type: 'manual-start' });
      vi.advanceTimersByTime(1000);
      expect(session.state.phase).toBe('listening');
      session.dispatch({ type: 'manual-end' });
      vi.advanceTimersByTime(session.state.hangoverMs + motionDurations.dock);
      expect(session.state.phase).toBe('presenting');
      expect(registry.snapshot()).toHaveLength(1);
      expect(registry.snapshot()[0].payload).toEqual({
        durationMs: 1000,
        peakLevel: 0,
        inputLabel: 'Manual activity',
      });
      session.dispatch({ type: 'dismiss' });
      vi.runAllTimers();
      expect(registry.snapshot()).toHaveLength(0);
      expect(session.state.phase).toBe('idle');
    }
    expect(audio.startMicrophone).not.toHaveBeenCalled();
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels stale docking and disposal timers', () => {
    const { session, registry } = setup();
    session.dispatch({ type: 'manual-start' });
    vi.advanceTimersByTime(motionDurations.focus);
    session.dispatch({ type: 'manual-end' });
    vi.advanceTimersByTime(950);
    expect(session.state.phase).toBe('docking');
    session.dispatch({ type: 'manual-start' });
    vi.advanceTimersByTime(motionDurations.focus);
    expect(session.state.phase).toBe('listening');
    expect(registry.snapshot()).toHaveLength(0);
    session.dispatch({ type: 'dismiss' });
    session.dispose();
    vi.runAllTimers();
    expect(session.state.phase).toBe('shutdown');
    expect(registry.snapshot()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the existing summary after resumed activity without duplicating surfaces', () => {
    const { session, registry, commands } = setup();
    session.dispatch({ type: 'reduced-motion', enabled: true });
    for (const duration of [1000, 2000]) {
      session.dispatch({ type: 'manual-start' });
      vi.advanceTimersByTime(duration);
      session.dispatch({ type: 'manual-end' });
      vi.runAllTimers();
      expect(registry.snapshot()).toHaveLength(1);
      expect(registry.snapshot()[0].payload.durationMs).toBe(duration);
    }
    expect(
      commands.mock.calls.filter(([command]) => command.action === 'open'),
    ).toHaveLength(1);
  });

  it('requires explicit capture, retains manual fallback after denial, and ignores stale audio', () => {
    const { session, audio, registry } = setup();
    session.updateAudio(audioState('capturing', true));
    expect(session.state.phase).toBe('idle');
    expect(audio.startMicrophone).not.toHaveBeenCalled();
    session.dispatch({ type: 'capture-request' });
    expect(audio.startMicrophone).toHaveBeenCalledTimes(1);
    session.updateAudio(audioState('denied'));
    expect(session.state.microphone.status).toBe('denied');
    session.updateAudio(audioState('capturing', true));
    expect(session.state.phase).toBe('idle');
    session.dispatch({ type: 'manual-start' });
    vi.advanceTimersByTime(300);
    session.dispatch({ type: 'manual-end' });
    vi.runAllTimers();
    expect(registry.snapshot()).toHaveLength(1);
  });

  it('opens measured summary, restores minimized summary, and releases capture on dismissal', () => {
    const { session, registry, audio } = setup();
    session.dispatch({ type: 'reduced-motion', enabled: true });
    session.dispatch({ type: 'capture-request' });
    session.updateAudio(audioState('capturing', true));
    session.updateAudio(audioState('capturing', false));
    vi.runAllTimers();
    const surface = registry.snapshot()[0];
    expect(surface.payload).toEqual({
      durationMs: 3000,
      peakLevel: 0.7,
      inputLabel: 'Microphone activity',
    });
    registry.interact('minimize', surface.instanceId);
    session.showSummary();
    expect(registry.snapshot()[0].minimized).toBe(false);
    session.dispatch({ type: 'dismiss' });
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(session.state.phase).toBe('idle');
    expect(registry.snapshot()).toHaveLength(0);
  });

  it('handles loss and minimize without auto-restarting microphone on resume', () => {
    const { session, audio } = setup();
    session.dispatch({ type: 'capture-request' });
    session.updateAudio(audioState('capturing', true));
    session.updateAudio(audioState('disconnected'));
    expect(session.state.microphone.status).toBe('disconnected');
    expect(session.state.phase).toBe('idle');
    session.dispatch({ type: 'capture-request' });
    session.dispatch({ type: 'minimized' });
    session.updateAudio(audioState('capturing', true));
    session.dispatch({ type: 'resume' });
    expect(session.state.phase).toBe('idle');
    expect(session.state.microphone.status).toBe('stopped');
    expect(audio.startMicrophone).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a presented microphone summary on stop instead of relabeling it as manual', () => {
    const { session, registry, commands } = setup();
    session.dispatch({ type: 'reduced-motion', enabled: true });
    session.dispatch({ type: 'capture-request' });
    session.updateAudio(audioState('capturing', true));
    session.updateAudio(audioState('capturing', false));
    vi.runAllTimers();
    expect(registry.snapshot()[0].payload.inputLabel).toBe(
      'Microphone activity',
    );
    const before = commands.mock.calls.length;
    session.stopMicrophone();
    expect(session.state.phase).toBe('idle');
    expect(registry.snapshot()).toHaveLength(0);
    expect(
      commands.mock.calls.slice(before).map(([command]) => command.action),
    ).toEqual(['close']);
  });
});
