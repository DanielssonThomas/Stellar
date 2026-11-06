import { describe, expect, it } from 'vitest';
import { VoicePreferences } from './voice-preferences';
describe('voice preferences', () => {
  it('persists wake mode and recognition visibility without persisting transcripts', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const preferences = new VoicePreferences(storage);
    expect(preferences.wakeSensitivity).toBe('standard');
    expect(preferences.showRecognition).toBe(false);
    preferences.setSensitivity('high');
    preferences.setRecognition(true);
    const restored = new VoicePreferences(storage);
    expect(restored.wakeSensitivity).toBe('high');
    expect(restored.showRecognition).toBe(true);
    expect([...values.keys()]).toEqual([
      'stellar.voice.wakeSensitivity',
      'stellar.voice.showRecognition',
    ]);
  });
  it('works for the current session when storage is denied or malformed', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const preferences = new VoicePreferences(storage);
    preferences.setSensitivity('high');
    preferences.setRecognition(true);
    expect(preferences.wakeSensitivity).toBe('high');
    expect(preferences.showRecognition).toBe(true);
    expect(
      new VoicePreferences({ getItem: () => 'other', setItem: () => undefined })
        .wakeSensitivity,
    ).toBe('standard');
  });
});
