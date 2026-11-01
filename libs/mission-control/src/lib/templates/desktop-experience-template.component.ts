import { Component, computed, input, output, viewChild } from '@angular/core';
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
  },
})
export class DesktopExperienceTemplate {
  readonly state = input<InteractionState>(initialState);
  readonly manifest = input<EmblemManifest | null>(null);
  readonly loading = input(false);
  readonly assetError = input<string | null>(null);
  readonly level = input(0);
  readonly statusText = input('Ready');
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
    if (this.state().phase === 'idle') return;
    event.preventDefault();
    this.action.emit({ type: 'dismiss' });
  }
  setReduced(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement)
      this.action.emit({ type: 'reduced-motion', enabled: target.checked });
  }
}
