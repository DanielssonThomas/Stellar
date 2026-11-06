import {
  Component,
  effect,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
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
  RequestStatusMolecule,
  IvyQuestionMolecule,
  type RequestStatusEntry,
} from '@stellar/ui-molecules';
import { StageOrganism } from '@stellar/ui-organisms';
import type {
  IvyQuestion,
  IvyQuestionAction,
} from '@stellar/desktop-contracts';

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
    RequestStatusMolecule,
    IvyQuestionMolecule,
  ],
  templateUrl: './desktop-experience-template.component.html',
  styleUrl: './desktop-experience-template.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[attr.data-phase]': 'state().phase',
    '(keydown.escape)': 'dismiss($event)',
    '(keydown)': 'menu.keydown($event)',
    tabindex: '-1',
    'aria-keyshortcuts': 'M P S',
    '(document:keydown)': 'controlsShortcut($event)',
  },
})
export class DesktopExperienceTemplate {
  readonly questions = input<readonly IvyQuestion[]>([]);
  readonly questionShown = output<string>();
  readonly questionAnswer = output<{ id: string; action: IvyQuestionAction }>();
  readonly statusVisible = signal(false);
  readonly paneControlsVisible = signal(false);
  readonly requestTimeline = input<readonly RequestStatusEntry[]>([]);
  readonly cloudStatus = input('unavailable');
  readonly cloudLabel = input('Terra');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly controlsDialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('controlsDialog');
  readonly menu = new DesktopMenu(
    this.host.nativeElement,
    () => this.controlsDialog().nativeElement,
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
  readonly reflexEnabled = input(false);
  readonly awarenessEnabled = input(true);
  readonly awarenessStatus = input('Awareness unavailable');
  readonly toggleAwareness = output<boolean>();
  readonly reflexStatus = input('Unavailable');
  readonly reflexLastRoute = input('');
  readonly toggleReflex = output<boolean>();
  readonly copyReflexDiagnostics = output<void>();
  readonly reflexDiagnosticNotice = input('');
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
  readonly focusFallback = this.host.nativeElement;

  constructor() {
    effect(() => {
      if (this.questions().length) {
        this.menu.close();
        this.musicControls().close();
      }
    });
  }

  dispatch(command: unknown) {
    return this.stage().dispatch(command);
  }
  openFaultControls() {
    this.musicControls().close();
    if (!this.menu.open()) this.menu.toggle();
  }
  presentFinalizedPrompt(text: ComposerFinalizedText, signal: AbortSignal) {
    return this.promptComposer().presentFinalized(text, signal);
  }
  dismiss(event: Event) {
    if (event.target instanceof Element && event.target.closest('dialog[open]'))
      return;
    if (this.state().phase === 'idle') return;
    event.preventDefault();
    this.dismissExperience();
  }
  controlsShortcut(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      this.questions().length > 0 ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !['m', 'p', 's'].includes(event.key.toLowerCase())
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
    if (event.key.toLowerCase() === 's') this.toggleStatus();
    else if (event.key.toLowerCase() === 'p') this.openMusicControls();
    else {
      this.musicControls().close();
      this.menu.toggle();
    }
  }
  toggleStatus() {
    this.menu.close();
    this.statusVisible.update((visible) => !visible);
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

  setPaneControls(event: Event) {
    if (event.target instanceof HTMLInputElement)
      this.paneControlsVisible.set(event.target.checked);
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
