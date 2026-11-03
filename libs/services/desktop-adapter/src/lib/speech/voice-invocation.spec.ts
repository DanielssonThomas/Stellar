import { describe, expect, it } from 'vitest';
import { VoiceInvocation, cancelsPrompt } from './voice-invocation';

describe('exact Ivy invocation', () => {
  it.each([
    'hello',
    'prompt',
    'send prompt',
    'clear',
    'ivory',
    'I have a request',
    'I think.',
    'Und dann',
    'Ivybridge',
    "Ivy's leaves",
    'poison ivy',
    'Tell Ivy to start',
    '“Ivy” is a name',
  ])('rejects ambient %s', (text) => {
    const gate = new VoiceInvocation();
    expect(gate.accept(text, false)).toBeNull();
    expect(gate.active()).toBe(false);
  });

  it('strips the exact leading wake word and retains follow-ups until reset', () => {
    const gate = new VoiceInvocation();
    expect(gate.accept('IVY, tell me the time', false)).toEqual({
      text: 'tell me the time',
      invoked: true,
    });
    expect(gate.accept('and tomorrow?', false)?.text).toBe('and tomorrow?');
    expect(gate.accept('another request', false)?.text).toBe('another request');
    expect(gate.accept('Ivy', false)?.text).toBe('');
    gate.reset();
    expect(gate.accept('another request', false)).toBeNull();
  });

  it('does not parse wake words inside active dictation, even after a long pause', () => {
    const gate = new VoiceInvocation();
    expect(gate.accept('Ivy, prompt about gardens', true)).toEqual({
      text: 'Ivy, prompt about gardens',
      invoked: false,
    });
  });
});

describe('prompt cancellation suffix', () => {
  it.each([
    'prompt cancel',
    'Prompt, cancel!',
    'Keep the draft local. Prompt cancel.',
    'Some draft, prompt cancel. Send prompt.',
  ])('cancels %s', (text) => expect(cancelsPrompt(text)).toBe(true));
  it.each([
    'prompt cancelled',
    'implement prompt cancellation',
    'prompt cancel button',
    'explain the prompt cancel command',
  ])('retains dictation %s', (text) => expect(cancelsPrompt(text)).toBe(false));
});
