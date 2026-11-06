import { describe, expect, it } from 'vitest';
import { VoiceInvocation, cancelsPrompt } from './voice-invocation';

describe('exact Ivy invocation', () => {
  it('accepts Hey Ivy without broadening ambient words', () => {
    const gate = new VoiceInvocation();
    expect(gate.accept('Hey Ivy, open the issue', false)).toEqual({
      text: 'open the issue',
      invoked: true,
    });
    gate.reset();
    expect(gate.accept('They said hey Ivy yesterday', false)).toBeNull();
  });
  it.each(['I mean', 'eerie', "I've"])(
    'accepts %s only as a high-sensitivity prefix and preserves following text',
    (alias) => {
      const gate = new VoiceInvocation();
      expect(gate.accept(`${alias}, show my calendar`, false)).toBeNull();
      gate.setSensitivity('high');
      expect(gate.accept(`${alias}, show my calendar`, false)).toEqual({
        text: 'show my calendar',
        invoked: true,
      });
      gate.reset();
      expect(gate.accept(`Tell me what ${alias} means`, false)).toBeNull();
      expect(gate.accept(`${alias}, keep this dictation`, true)).toEqual({
        text: `${alias}, keep this dictation`,
        invoked: false,
      });
    },
  );
  it('carries an acoustic wake into one following request without a transcribed wake spelling', () => {
    const gate = new VoiceInvocation();
    gate.activateAcoustically();
    expect(gate.active()).toBe(true);
    expect(gate.accept('prompt write a note', false)).toEqual({
      text: 'prompt write a note',
      invoked: true,
    });
    expect(gate.accept('another sentence', false)?.invoked).toBe(false);
    gate.activateAcoustically();
    gate.reset();
    expect(gate.accept('prompt write a note', false)).toBeNull();
  });
  it.each([
    'hello',
    'prompt',
    'send prompt',
    'clear',
    'ivory',
    'I have a request',
    'I think.',
    'I mean',
    'I mean, start the activity',
    'IV',
    'IV fluids',
    'I.Vision',
    'I.V.ory',
    "I.V.'s leaves",
    'Tell I.V. to start',
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

  it.each(['I.V', 'I.V.', 'i.v.', '  I.V...'])(
    'accepts the dotted phonetic spelling %s and requires re-invocation after reset',
    (wake) => {
      const gate = new VoiceInvocation();
      expect(gate.accept(wake, false)).toEqual({ text: '', invoked: true });
      expect(gate.accept('a normal request', false)?.text).toBe(
        'a normal request',
      );
      gate.reset();
      expect(gate.accept('I mean', false)).toBeNull();
      expect(gate.accept(`${wake}, prompt the next task`, false)).toEqual({
        text: 'prompt the next task',
        invoked: true,
      });
    },
  );

  it.each(['Ivy, prompt about gardens', 'I.V., prompt about gardens'])(
    'does not parse %s inside active dictation, even after a long pause',
    (text) => {
      const gate = new VoiceInvocation();
      expect(gate.accept(text, true)).toEqual({
        text,
        invoked: false,
      });
    },
  );
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
