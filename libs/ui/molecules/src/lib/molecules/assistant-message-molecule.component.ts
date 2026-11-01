import { Component, input } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';

@Component({
  selector: 'stellar-assistant-message-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './assistant-message-molecule.component.html',
  styleUrl: './assistant-message-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class AssistantMessageMolecule {
  readonly payload = input<{
    readonly title: string;
    readonly body: string;
  } | null>(null);
  readonly loading = input(false);
}
