import {
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import {
  decodeWorkspaceIssuePayload,
  type WorkspaceIssuePayload,
  type WorkspaceIssueReference,
} from '@stellar/desktop-contracts';

@Component({
  selector: 'stellar-presentation-issue-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-issue-molecule.component.html',
  styleUrl: './presentation-issue-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'busy()',
    '[attr.data-render-state]': 'renderState()',
  },
})
export class PresentationIssueMolecule {
  readonly payload = input<WorkspaceIssuePayload | null>(null);
  readonly loading = input(false);
  readonly value = computed(() => {
    try {
      return decodeWorkspaceIssuePayload(this.payload());
    } catch {
      return null;
    }
  });
  private readonly now = signal(Date.now());
  readonly busy = computed(
    () => this.loading() || this.value()?.status === 'loading',
  );
  readonly renderState = computed(() => {
    if (this.busy()) return 'loading';
    const status = this.value()?.status;
    if (!status || status === 'unavailable') return 'unavailable';
    return status === 'error' ? 'error' : 'ready';
  });
  readonly stale = computed(() => {
    const value = this.value();
    const now = Math.max(this.now(), Date.now());
    return (
      value?.status === 'stale' ||
      (value?.observed_at_ms !== null &&
        value?.observed_at_ms !== undefined &&
        (now - Number(value.observed_at_ms) > 900000 ||
          Number(value.observed_at_ms) > now))
    );
  });
  readonly observed = computed(() => {
    const time = this.value()?.observed_at_ms;
    return time ? new Date(Number(time)).toISOString() : null;
  });
  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  referenceUrl(ref: WorkspaceIssueReference, kind: 'issues' | 'pull') {
    return `https://github.com/${ref.repository}/${kind}/${ref.number}`;
  }
}
