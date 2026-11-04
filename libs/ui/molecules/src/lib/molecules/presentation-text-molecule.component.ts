import { ViewEncapsulation, Component, input, inject } from '@angular/core';
import { PresentationMarkdownPipe } from './presentation-markdown';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type { PresentationTextPayload } from './presentation-model';
import { PRESENTATION_EDIT } from './presentation-edit';

@Component({
  selector: 'stellar-presentation-text-molecule',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [SkeletonAtom, PresentationMarkdownPipe],
  templateUrl: './presentation-text-molecule.component.html',
  styleUrl: './presentation-text-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class PresentationTextMolecule {
  readonly payload = input<PresentationTextPayload | null>(null);
  readonly loading = input(false);
  private readonly edit = inject(PRESENTATION_EDIT);
  toggle(blockIndex: number, itemIndex: number) {
    const payload = this.payload();
    if (!payload) return;
    this.edit({
      ...payload,
      blocks: payload.blocks.map((block, index) =>
        index === blockIndex && block.kind === 'checklist'
          ? {
              ...block,
              items: block.items.map((item, i) =>
                i === itemIndex ? { ...item, checked: !item.checked } : item,
              ),
            }
          : block,
      ),
    });
  }
}
