import { Component, computed, input, signal } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type { PresentationMediaPayload } from './presentation-model';

@Component({
  selector: 'stellar-presentation-media-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-media-molecule.component.html',
  styleUrl: './presentation-media-molecule.component.css',
  host: { '[attr.aria-busy]': 'pending()' },
})
export class PresentationMediaMolecule {
  readonly payload = input<PresentationMediaPayload | null>(null);
  readonly loading = input(false);
  private readonly settled = signal<{ src: string; failed: boolean } | null>(
    null,
  );
  readonly image = computed(() => {
    const content = this.payload();
    return content?.kind === 'image' ? content : null;
  });
  readonly currentResult = computed(() =>
    this.settled()?.src === this.image()?.src ? this.settled() : null,
  );
  readonly pending = computed(
    () => this.loading() || (!!this.image() && !this.currentResult()),
  );
  settle(event: Event, failed: boolean) {
    const src =
      event.target instanceof HTMLImageElement
        ? event.target.getAttribute('src')
        : null;
    if (src && src === this.image()?.src) this.settled.set({ src, failed });
  }
}
