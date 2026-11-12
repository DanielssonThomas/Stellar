import { Component, input } from '@angular/core';
import { SkeletonAtom, PresentationChartAtom } from '@stellar/ui-atoms';
import type { WorkspaceChartPayload } from '@stellar/desktop-contracts';

@Component({
  selector: 'stellar-presentation-chart-molecule',
  standalone: true,
  imports: [SkeletonAtom, PresentationChartAtom],
  templateUrl: './presentation-chart-molecule.component.html',
  styleUrl: './presentation-chart-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class PresentationChartMolecule {
  readonly payload = input<WorkspaceChartPayload | null>(null);
  readonly loading = input(false);
}
