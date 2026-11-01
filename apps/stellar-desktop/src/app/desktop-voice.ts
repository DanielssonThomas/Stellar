import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  NgZone,
  signal,
} from '@angular/core';
import { AudioActivityService } from '@stellar/service-audio-activity';
import {
  SpeechAdapterService,
  VoiceConversation,
  type VoiceView,
} from '@stellar/service-desktop-adapter';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopExperience } from './desktop-experience';

@Injectable()
export class DesktopVoice {
  private readonly audio = inject(AudioActivityService);
  private readonly speech = inject(SpeechAdapterService);
  private readonly assistant = inject(DesktopAssistant);
  private readonly experience = inject(DesktopExperience);
  private readonly zone = inject(NgZone);
  private readonly current = signal<VoiceView>({
    status: 'Local voice idle',
    muted: false,
    error: false,
    busy: false,
  });
  readonly state = this.current.asReadonly();
  private readonly conversation = new VoiceConversation({
    transcribe: (pcm, id) => this.speech.transcribe(pcm, id),
    submit: (text, id) => this.assistant.submit(text, id),
    speak: (text, id) => this.speech.speak(text, id),
    stop: () => this.speech.stop(),
    id: () => crypto.randomUUID(),
    onChange: (view) => this.zone.run(() => this.current.set(view)),
  });

  constructor() {
    const unsubscribe = this.audio.subscribePcm((event) =>
      this.conversation.accept(event),
    );
    effect(() =>
      this.conversation.update({
        audio: this.audio.state(),
        speech: this.speech.state(),
        assistant: this.assistant.state(),
        available: !['suspended', 'shutdown'].includes(
          this.experience.state().phase,
        ),
      }),
    );
    inject(DestroyRef).onDestroy(() => {
      unsubscribe();
      this.conversation.dispose();
    });
  }

  setMuted(muted: boolean) {
    this.conversation.setMuted(muted);
  }
  stop() {
    this.conversation.stopVoice();
  }
  retry() {
    this.conversation.retry();
  }
}
