import {
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type { PresentationTelemetryPayload } from './presentation-model';
import { PRESENTATION_DATA } from './presentation-data';

@Component({
  selector: 'stellar-presentation-telemetry-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-telemetry-molecule.component.html',
  styleUrl: './presentation-telemetry-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading() || view().state === "loading"' },
})
export class PresentationTelemetryMolecule {
  readonly payload = input<PresentationTelemetryPayload | null>(null);
  readonly loading = input(false);
  private readonly data = inject(PRESENTATION_DATA);
  private readonly now = signal(Date.now());
  readonly view = computed(() =>
    this.payload()?.kind === 'session'
      ? this.data.session()
      : this.data.workflow(),
  );
  readonly age = computed(() => {
    const at = this.view().observedAt;
    const parsed = at ? Date.parse(at) : NaN;
    return Number.isFinite(parsed) && parsed <= this.now()
      ? Math.floor((this.now() - parsed) / 1000)
      : null;
  });
  readonly live = computed(
    () => this.view().state === 'available' && (this.age() ?? Infinity) <= 10,
  );
  readonly rows = computed(() =>
    this.view().rows.filter(
      (row) =>
        !this.payload()?.project || row.project === this.payload()?.project,
    ),
  );
  constructor() {
    const release = this.data.acquire();
    const clock = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(clock);
      release();
    });
  }
}
