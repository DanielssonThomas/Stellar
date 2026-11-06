import { describe, expect, it } from 'vitest';
import { waitingCueEligible } from './waiting-cue';
describe('conversational waiting cue', () => {
  it.each([
    'Hi',
    'Hello Ivy!',
    'Hello there',
    'Hi there',
    'Hello again',
    'Hey girl',
    'Hey Ivy how are you?',
    'Good morning',
    'Thanks',
    'Thank you Ivy',
    'Okay',
    'Sounds good.',
    'Cancel that',
    'Stop',
    'Never mind',
    "I'm done",
    'New session',
    'Prompt cancel',
  ])('does not fill social or control utterance %s', (text) =>
    expect(waitingCueEligible(text)).toBe(false),
  );
  it.each([
    "What's on my schedule today?",
    'Look up that GitHub issue',
    'Hello Ivy, check my calendar',
    'Tell me a story',
    'Please explain what happened',
  ])('allows a still-pending substantive request %s', (text) =>
    expect(waitingCueEligible(text)).toBe(true),
  );
});
