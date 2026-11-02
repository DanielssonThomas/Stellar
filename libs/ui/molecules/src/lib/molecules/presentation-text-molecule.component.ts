import { Component, input } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type { PresentationTextPayload } from './presentation-model';

@Component({
  selector: 'stellar-presentation-text-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-text-molecule.component.html',
  styleUrl: './presentation-text-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class PresentationTextMolecule {
  readonly payload = input<PresentationTextPayload | null>(null);
  readonly loading = input(false);
}
