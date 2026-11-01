import {
  Component,
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
  imports: [StageOrganism, EmblemMotionMolecule],
  templateUrl: './desktop-experience-template.component.html',
  styleUrl: './desktop-experience-template.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[attr.data-phase]': 'state().phase',
    '(keydown.escape)': 'dismiss($event)',
    '(document:pointerdown)': 'menu.outside($event)',
    '(document:focusin)': 'menu.outside($event)',
  },
})
export class DesktopExperienceTemplate {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly menu = new DesktopMenu(this.host.nativeElement, () =>
    this.host.nativeElement.querySelector<HTMLButtonElement>(
      '[data-menu-trigger]',
    ),
  );
  readonly assistantStatus = input('Ivy disconnected');
  readonly assistantReply = input('');
  readonly assistantBusy = input(false);
  readonly assistantUncertain = input(false);
  readonly retryIvy = output<void>();
  readonly cancelIvy = output<void>();
  readonly reconcileIvy = output<void>();
  readonly submitText = output<string>();
  readonly draft = signal('');
  readonly draftTooLong = computed(
    () => new TextEncoder().encode(this.draft().trim()).length > 8192,
  );
  readonly requestedContent = signal(false);
  readonly state = input<InteractionState>(initialState);
  readonly manifest = input<EmblemManifest | null>(null);
  readonly loading = input(false);
  readonly assetError = input<string | null>(null);
  readonly level = input(0);
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

  dispatch(command: unknown) {
    return this.stage().dispatch(command);
  }
  dismiss(event: Event) {
    if (this.menu.open()) {
      this.menu.keydown(event as KeyboardEvent);
      return;
    }
    if (this.state().phase === 'idle') return;
    event.preventDefault();
    this.dismissExperience();
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
