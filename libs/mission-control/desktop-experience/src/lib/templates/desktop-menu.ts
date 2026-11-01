import { signal } from '@angular/core';

export class DesktopMenu {
  readonly open = signal(false);

  constructor(
    private readonly host: HTMLElement,
    private readonly trigger: () => HTMLButtonElement | null,
  ) {}

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }

    this.open.set(true);
    queueMicrotask(() => {
      if (!this.open()) return;

      this.host
        .querySelector<HTMLElement>('[data-desktop-menu]')
        ?.querySelector<HTMLElement>('button, input, select, textarea')
        ?.focus();
    });
  }

  close(restoreFocus = true): void {
    if (!this.open()) return;

    this.open.set(false);
    if (restoreFocus) this.trigger()?.focus();
  }

  keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.open()) return;

    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  outside(event: Event): void {
    if (!this.open()) return;

    const target = event.target;
    const targetNode = target instanceof Node ? target : null;
    if (!targetNode) return;

    const menu = this.host.querySelector('[data-desktop-menu]');
    const trigger = this.trigger();
    if (menu?.contains(targetNode) || trigger?.contains(targetNode)) return;

    this.close(false);
  }
}
