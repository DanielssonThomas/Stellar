import { ViewEncapsulation, Component, input } from '@angular/core';
import { PresentationMarkdownPipe } from './presentation-markdown';
import { SkeletonAtom } from '@stellar/ui-atoms';

@Component({
  selector: 'stellar-assistant-message-molecule',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [SkeletonAtom, PresentationMarkdownPipe],
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
