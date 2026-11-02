import { Component, computed, input, output, signal } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';

export interface FaultLogEntry {
  readonly id: number;
  readonly time: string;
  readonly category: string;
  readonly message: string;
  readonly status: 'active' | 'recovering' | 'resolved';
  readonly count: number;
}

@Component({
  selector: 'stellar-fault-log-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './fault-log-molecule.component.html',
  styleUrl: './fault-log-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class FaultLogMolecule {
  readonly entries = input<readonly FaultLogEntry[]>([]);
  readonly active = input(false);
  readonly recovering = input(false);
  readonly reducedMotion = input(false);
  readonly retry = output<void>();
  readonly controls = output<void>();
  readonly dismiss = output<void>();
  readonly recoverable = computed(() =>
    this.entries().some(
      (entry) =>
        entry.status !== 'resolved' &&
        ['Ivy', 'Voice'].includes(entry.category),
    ),
  );
  readonly page = signal(0);
  readonly pages = computed(() =>
    Math.max(1, Math.ceil(this.entries().length / 2)),
  );
  readonly currentPage = computed(() =>
    Math.min(this.page(), this.pages() - 1),
  );
  readonly shown = computed(() =>
    [...this.entries()]
      .sort(
        (a, b) =>
          Number(a.status === 'resolved') - Number(b.status === 'resolved'),
      )
      .slice(this.currentPage() * 2, this.currentPage() * 2 + 2),
  );
  time(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
  }
  readonly loading = input(false);
}
