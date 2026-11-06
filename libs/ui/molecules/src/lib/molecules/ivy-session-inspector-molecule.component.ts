import {
  afterRenderEffect,
  Component,
  computed,
  DOCUMENT,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { SkeletonAtom } from '@stellar/ui-atoms';
import type {
  IvyInspectorSnapshot,
  IvySessionMessage,
  IvySessionSummary,
} from '@stellar/desktop-contracts';
import clsx from 'clsx';

@Component({
  selector: 'stellar-ivy-session-inspector-molecule',
  standalone: true,
  imports: [SkeletonAtom, DatePipe, DecimalPipe],
  templateUrl: './ivy-session-inspector-molecule.component.html',
  styleUrl: './ivy-session-inspector-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class IvySessionInspectorMolecule {
  readonly visible = input(false);
  readonly loading = input(false);
  readonly snapshot = input<IvyInspectorSnapshot | null>(null);
  readonly sessions = input<readonly IvySessionSummary[]>([]);
  readonly messages = input<readonly IvySessionMessage[]>([]);
  readonly error = input('');
  readonly status = input('Disconnected');
  readonly voice = input('Local voice idle');
  readonly reflex = input('Unavailable');
  readonly model = input('Terra');
  readonly verifiedModel = input('Unverified');
  readonly busy = input(false);
  readonly routeLabel = computed(() =>
    this.verifiedModel().toLowerCase() === this.model().toLowerCase()
      ? 'Route confirmed'
      : 'Unverified route',
  );
  readonly closed = output<void>();
  readonly selected = output<string | null>();
  readonly refresh = output<void>();
  readonly moreSessions = output<void>();
  readonly olderMessages = output<void>();
  readonly newSession = output<void>();
  readonly query = signal('');
  readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.sessions().filter(
      (s) =>
        !query || `${s.title} ${s.model ?? ''}`.toLowerCase().includes(query),
    );
  });
  readonly current = computed(() =>
    this.sessions().find((s) => s.id === this.snapshot()?.selected_session_id),
  );
  readonly contextPercent = computed(() => {
    const context = this.snapshot()?.context;
    return context?.used !== null &&
      context?.used !== undefined &&
      context.limit
      ? Math.round((context.used / context.limit) * 100)
      : null;
  });
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly document = inject(DOCUMENT);
  private origin: HTMLElement | null = null;

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      if (this.visible() && !dialog.open) {
        const active = this.document.activeElement;
        this.origin = active instanceof HTMLElement ? active : null;
        dialog.showModal();
      } else if (!this.visible() && dialog.open) {
        dialog.close();
        if (this.origin?.isConnected) this.origin.focus();
        this.origin = null;
      }
    });
  }
  rowClass(id: string) {
    return clsx('session-row', {
      'session-selected': id === this.snapshot()?.selected_session_id,
    });
  }
  stale(observed: string | null | undefined, seconds: number) {
    return !!observed && Date.now() - Date.parse(observed) > seconds * 1000;
  }
  search(event: Event) {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }
  keydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      this.dialog().nativeElement.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && this.document.activeElement === first && last) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      this.document.activeElement === last &&
      first
    ) {
      event.preventDefault();
      first.focus();
    }
  }
}
