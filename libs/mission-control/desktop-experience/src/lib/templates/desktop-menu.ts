export class DesktopMenu {
  private origin: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly dialog: () => HTMLDialogElement,
  ) {}

  open(): boolean {
    return this.dialog().open;
  }

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }

    const active = this.host.ownerDocument.activeElement;
    this.origin =
      active instanceof HTMLElement && active !== document.body
        ? active
        : this.host;
    this.dialog().showModal();
  }

  close(): void {
    if (!this.open()) return;

    this.dialog().close();
    this.restoreFocus();
  }

  keydown(event: Event): void {
    if (
      !(event instanceof KeyboardEvent) ||
      event.key !== 'Tab' ||
      !this.open()
    )
      return;
    const dialog = this.dialog();
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]',
      ),
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled') &&
        element.getClientRects().length > 0,
    );
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = dialog.ownerDocument.activeElement;
    if (event.shiftKey && active === first && last) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last && first) {
      event.preventDefault();
      first.focus();
    }
  }

  restoreFocus(): void {
    // A queued close event may arrive after the dialog has been reopened.
    if (this.open()) return;
    const origin = this.origin;
    this.origin = null;
    if (!origin) return;
    if (origin.isConnected && !origin.closest('dialog:not([open])'))
      origin.focus();
    else this.host.focus();
  }
}
