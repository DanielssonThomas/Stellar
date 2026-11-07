export type WakeSensitivity = 'standard' | 'high';
export interface RecognitionObservation {
  text: string;
  status:
    | 'Wake detected'
    | 'Wake suppressed'
    | 'No wake detected'
    | 'Active conversation';
}

function localStoragePort(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export class VoicePreferences {
  wakeSensitivity: WakeSensitivity = 'standard';
  showRecognition = false;
  constructor(private readonly storage = localStoragePort()) {
    try {
      this.wakeSensitivity =
        storage?.getItem('stellar.voice.wakeSensitivity') === 'high'
          ? 'high'
          : 'standard';
      this.showRecognition =
        storage?.getItem('stellar.voice.showRecognition') === 'true';
    } catch {
      /* Current-session controls remain usable without storage. */
    }
  }
  setSensitivity(value: WakeSensitivity) {
    if (!['standard', 'high'].includes(value)) return;
    this.wakeSensitivity = value;
    try {
      this.storage?.setItem('stellar.voice.wakeSensitivity', value);
    } catch {
      /* Session-only preference. */
    }
  }
  setRecognition(value: boolean) {
    this.showRecognition = value;
    try {
      this.storage?.setItem('stellar.voice.showRecognition', String(value));
    } catch {
      /* Session-only preference. */
    }
  }
}
