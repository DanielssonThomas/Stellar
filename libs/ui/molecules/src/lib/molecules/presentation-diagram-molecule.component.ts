import { Component, computed, input } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type { PresentationDiagramPayload } from './presentation-model';

@Component({
  selector: 'stellar-presentation-diagram-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-diagram-molecule.component.html',
  styleUrl: './presentation-diagram-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class PresentationDiagramMolecule {
  readonly payload = input<PresentationDiagramPayload | null>(null);
  readonly loading = input(false);
  readonly markerId = 'arrow-' + crypto.randomUUID();
  readonly nodes = computed(() =>
    (this.payload()?.nodes ?? []).map((node, index) => ({
      ...node,
      x: 30 + (index % 3) * 270,
      y: 30 + Math.floor(index / 3) * 150,
      lines: node.label.match(/.{1,23}(?:\s|$)|.{1,23}/g)?.slice(0, 3) ?? [],
    })),
  );
  readonly height = computed(() =>
    Math.max(150, Math.ceil(this.nodes().length / 3) * 150),
  );
  readonly edges = computed(() =>
    (this.payload()?.edges ?? []).flatMap((edge) => {
      const from = this.nodes().find((node) => node.id === edge.from),
        to = this.nodes().find((node) => node.id === edge.to);
      if (!from || !to) return [];
      const x1 = from.x + 115,
        y1 = from.y + 45,
        x2 = to.x + 115,
        y2 = to.y + 45;
      const dx = x2 - x1,
        dy = y2 - y1;
      if (!dx && !dy) return [];
      const inset = Math.min(115 / Math.abs(dx), 45 / Math.abs(dy));
      return [
        {
          ...edge,
          path: `M${x1 + dx * inset},${y1 + dy * inset} L${x2 - dx * inset},${y2 - dy * inset}`,
          x: (x1 + x2) / 2,
          y: (y1 + y2) / 2 - 9,
        },
      ];
    }),
  );
}
