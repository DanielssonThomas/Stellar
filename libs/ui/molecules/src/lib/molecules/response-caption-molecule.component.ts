import { Component, computed, input } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';

@Component({
  selector: 'stellar-response-caption-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './response-caption-molecule.component.html',
  styleUrl: './response-caption-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[attr.data-response-kind]': 'kind()',
    '[class.motion-reduced]': 'reducedMotion()',
  },
})
export class ResponseCaptionMolecule {
  readonly text = input('');
  readonly kind = input<'commentary' | 'final'>('commentary');
  readonly loading = input(false);
  readonly reducedMotion = input(false);
  readonly visibleText = computed(() => {
    const text = this.text();
    if (text.length <= 4096) return text;
    let prefix = text.slice(0, 4095);
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
    return `${prefix}…`;
  });
}
