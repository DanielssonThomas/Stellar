import type { ReflexMediaAction } from '@stellar/desktop-contracts';

export const mediaActionDescriptions: Record<ReflexMediaAction, string> = {
  play: 'Resume or start current player playback; unpause music. Does not unmute output.',
  pause:
    'Pause current player playback; put the music on hold. Does not mute output.',
  next: 'Skip the current song and play the next track.',
  previous: 'Return to the previous track.',
  volume_up:
    'Raise Windows output volume by 10 percentage points; does not unmute or resume.',
  volume_down:
    'Lower Windows output volume by 10 percentage points; does not mute or pause.',
  mute: 'Mute Windows output; silence sound without pausing playback.',
  unmute:
    'Unmute Windows output; restore muted sound without resuming or changing volume.',
  inspect:
    'Read the current playback, player, track, volume and mute state without changing anything.',
};
