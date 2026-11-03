import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DesktopMenu } from './desktop-menu';
import {
  initialState,
  type InteractionEvent,
  type InteractionState,
} from '@stellar/desktop-interaction';
import {
  EmblemMotionMolecule,
  AudioVisualizerMolecule,
  type EmblemMusicLevels,
  type EmblemMusicMode,
  IvyActivityMolecule,
  type IvyActivityItem,
  PromptComposerMolecule,
  FaultLogMolecule,
  VoiceTranscriptMolecule,
  type FaultLogEntry,
  type ComposerFinalizedText,
  type PromptComposerStatus,
  type EmblemManifest,
} from '@stellar/ui-molecules';
import { StageOrganism } from '@stellar/ui-organisms';
import clsx from 'clsx';

export interface MicrophoneOption {
  readonly deviceId: string;
  readonly label: string;
}

@Component({
  selector: 'stellar-desktop-experience-template',
  standalone: true,
  imports: [
    StageOrganism,
    EmblemMotionMolecule,
    AudioVisualizerMolecule,
    IvyActivityMolecule,
    PromptComposerMolecule,
    FaultLogMolecule,
    VoiceTranscriptMolecule,
  ],
  templateUrl: './desktop-experience-template.component.html',
  styleUrl: './desktop-experience-template.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[attr.data-phase]': 'state().phase',
    '(keydown.escape)': 'dismiss($event)',
    '(document:pointerdown)': 'menu.outside($event)',
    '(document:focusin)': 'menu.outside($event)',
    '(document:keydown)': 'musicShortcut($event)',
  },
})
export class DesktopExperienceTemplate {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly menu = new DesktopMenu(this.host.nativeElement, () =>
    this.host.nativeElement.querySelector<HTMLButtonElement>(
      '[data-menu-trigger]',
    ),
  );
  readonly ivyActivity = input<readonly IvyActivityItem[]>([]);
  readonly ivyTurnId = input<string | null>(null);
  readonly ivyWorking = input(false);
  readonly ivyPreparing = input(false);
  readonly passiveListening = input(false);
  readonly assistantStatus = input('Ivy disconnected');
  readonly assistantReply = input('');
  readonly assistantBusy = input(false);
  readonly assistantUncertain = input(false);
  readonly assistantWaiting = input(false);
  readonly assistantNarrating = input(false);
  readonly conversationActive = input(false);
  readonly solActive = input(false);
  readonly faultActive = input(false);
  readonly faultVisible = input(false);
  readonly faultEntries = input<readonly FaultLogEntry[]>([]);
  readonly faultRecovering = input(false);
  readonly recoverFault = output<void>();
  readonly dismissFaults = output<void>();
  readonly showFaults = output<void>();
  readonly promptRaw = input('');
  readonly promptDraft = input<string | null>(null);
  readonly promptPreview = input('');
  readonly promptRefinementRevision = input(0);
  readonly promptRefined = input<string | null>(null);
  readonly promptStatus = input<PromptComposerStatus>('idle');
  readonly composing = computed(
    () =>
      this.solActive() &&
      !this.faultActive() &&
      !this.faultVisible() &&
      ['composing', 'refining', 'finalizing', 'error'].includes(
        this.promptStatus(),
      ) &&
      !['suspended', 'shutdown'].includes(this.state().phase),
  );
  readonly emblem = viewChild(EmblemMotionMolecule);
  readonly promptComposer = viewChild.required(PromptComposerMolecule);
  readonly assistantActive = computed(
    () =>
      !this.passiveListening() &&
      !['suspended', 'shutdown'].includes(this.state().phase) &&
      (this.assistantWaiting() || this.assistantNarrating()),
  );
  readonly emblemPhase = computed(() =>
    this.faultActive()
      ? ('idle' as const)
      : this.passiveListening() &&
          !this.state().manualActive &&
          !['suspended', 'shutdown'].includes(this.state().phase)
        ? ('idle' as const)
        : this.assistantActive() ||
            (this.conversationActive() &&
              !['suspended', 'shutdown'].includes(this.state().phase))
          ? ('listening' as const)
          : this.state().phase,
  );
  readonly retryIvy = output<void>();
  readonly cancelIvy = output<void>();
  readonly reconcileIvy = output<void>();
  readonly submitText = output<string>();
  readonly voiceStatus = input('Local voice idle');
  readonly voiceInputText = input('');
  readonly voiceNotice = input('');
  readonly voiceMuted = input(false);
  readonly voiceBusy = input(false);
  readonly voiceError = input(false);
  readonly muteVoice = output<boolean>();
  readonly stopVoice = output<void>();
  readonly retryVoice = output<void>();
  readonly draft = signal('');
  readonly draftTooLong = computed(
    () => new TextEncoder().encode(this.draft().trim()).length > 8192,
  );
  readonly requestedContent = signal(false);
  readonly state = input<InteractionState>(initialState);
  readonly manifest = input<EmblemManifest | null>(null);
  readonly loading = input(false);
  readonly assetError = input<string | null>(null);
  readonly assetUnavailable = output<void>();
  readonly level = input(0);
  readonly musicLevels = input<EmblemMusicLevels>({
    level: 0,
    bass: 0,
    mid: 0,
    treble: 0,
  });
  readonly musicSensitivity = input<EmblemMusicLevels>({
    level: 1,
    bass: 1,
    mid: 1,
    treble: 1,
  });
  readonly musicEnabled = input(false);
  readonly musicStatus = input('Music visualizer off');
  readonly toggleMusic = output<boolean>();
  readonly musicSensitivityChange = output<{
    band: keyof EmblemMusicLevels;
    value: number;
  }>();
  readonly musicControls = viewChild.required(AudioVisualizerMolecule);
  readonly musicMode = signal<EmblemMusicMode>('dynamic');
  readonly musicTone = input<number | null>(null);
  readonly statusText = input('Ready');
  readonly inputs = input<readonly MicrophoneOption[]>([]);
  readonly inputsVisible = input(false);
  readonly inputsLoading = input(false);
  readonly inputError = input<string | null>(null);
  readonly selectedInputId = input('');
  readonly selectedInputLabel = input('System default microphone');
  readonly activityStatus = input('Quiet');
  readonly chooseInputs = output<void>();
  readonly selectInput = output<string>();
  readonly inputMissing = computed(
    () =>
      this.selectedInputId() &&
      !this.inputs().some(
        (device) => device.deviceId === this.selectedInputId(),
      ),
  );
  readonly inputMeter = computed(() => {
    const level = this.level();
    return Number.isFinite(level) ? Math.min(100, Math.max(0, level * 100)) : 0;
  });
  readonly action = output<InteractionEvent>();
  readonly stopMicrophone = output<void>();
  readonly restoreSummary = output<void>();
  readonly stage = viewChild.required(StageOrganism);
  readonly controlsClass = computed(() =>
    clsx('controls', { 'active-controls': this.state().manualActive }),
  );

  constructor() {
    effect(() => {
      if (this.faultVisible()) untracked(() => this.menu.close());
    });
  }

  dispatch(command: unknown) {
    return this.stage().dispatch(command);
  }
  openFaultControls() {
    if (!this.menu.open()) this.menu.toggle();
  }
  presentFinalizedPrompt(text: ComposerFinalizedText, signal: AbortSignal) {
    return this.promptComposer().presentFinalized(text, signal);
  }
  dismiss(event: Event) {
    if (event.target instanceof Element && event.target.closest('dialog[open]'))
      return;
    if (this.menu.open()) {
      this.menu.keydown(event as KeyboardEvent);
      return;
    }
    if (this.state().phase === 'idle') return;
    event.preventDefault();
    this.dismissExperience();
  }
  musicShortcut(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key.toLowerCase() !== 'p'
    )
      return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    if (['suspended', 'shutdown'].includes(this.state().phase)) return;
    event.preventDefault();
    this.openMusicControls();
  }
  openMusicControls() {
    this.menu.close();
    this.musicControls().open();
  }
  dismissExperience() {
    this.stage().closePresentations();
    this.action.emit({ type: 'dismiss' });
  }
  setReduced(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement)
      this.action.emit({ type: 'reduced-motion', enabled: target.checked });
  }

  chooseInput(event: Event) {
    if (event.target instanceof HTMLSelectElement)
      this.selectInput.emit(event.target.value);
  }

  editDraft(event: Event) {
    if (event.target instanceof HTMLTextAreaElement)
      this.draft.set(event.target.value);
  }

  send(event: Event) {
    event.preventDefault();
    const text = this.draft().trim();
    if (!text || this.draftTooLong() || this.assistantBusy()) return;
    this.submitText.emit(text);
  }
}
