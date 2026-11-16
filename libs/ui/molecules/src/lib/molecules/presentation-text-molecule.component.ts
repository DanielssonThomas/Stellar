import { Component, input, inject, computed } from '@angular/core';
import { SkeletonAtom, PresentationChartAtom } from '@stellar/ui-atoms';
import type { PresentationTextPayload } from './presentation-model';
import { PRESENTATION_EDIT } from './presentation-edit';
import { statisticsChart } from './presentation-statistics';

@Component({
  selector: 'stellar-presentation-text-molecule',
  standalone: true,
  imports: [SkeletonAtom, PresentationChartAtom],
  templateUrl: './presentation-text-molecule.component.html',
  styleUrl: './presentation-text-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class PresentationTextMolecule {
  readonly payload = input<PresentationTextPayload | null>(null);
  readonly statisticsCharts = computed(
    () =>
      this.payload()?.blocks.map((block) =>
        block.kind === 'statistics' ? statisticsChart(block.statistics) : null,
      ) ?? [],
  );
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
