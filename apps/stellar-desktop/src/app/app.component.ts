import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DesktopAdapterService } from '@stellar/service-desktop-adapter';
import { capabilityLabel } from '@stellar/desktop-contracts';

@Component({
  imports: [RouterOutlet],
  selector: 'stellar-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  host: {
    '[attr.data-desktop-ready]': 'desktopReady()',
    '[attr.data-desktop-event]': 'eventSeen()',
    '[attr.data-desktop-capabilities]': 'capabilities()',
  },
})
export class AppComponent {
  readonly title = 'Stellar Desktop';
  readonly desktopReady = signal(false);
  readonly eventSeen = signal(false);
  readonly capabilities = signal('');
  private readonly adapter = inject(DesktopAdapterService);

  constructor() {
    let destroyed = false;
    let unsubscribe: () => void = () => undefined;
    inject(DestroyRef).onDestroy(() => {
      destroyed = true;
      unsubscribe();
    });
    void (async () => {
      try {
        const stop = await this.adapter.subscribe(
          (event) => {
            if (!destroyed && event.info.sequence === '18446744073709551615')
              this.eventSeen.set(true);
          },
          () => this.desktopReady.set(false),
        );
        if (destroyed) {
          stop();
          return;
        }
        unsubscribe = stop;
        const info = await this.adapter.appInfo({
          version: 1,
          sequence: '18446744073709551615',
        });
        if (!destroyed) {
          this.capabilities.set(
            info.capabilities.map(capabilityLabel).join(', '),
          );
          this.desktopReady.set(true);
        }
      } catch {
        unsubscribe();
      }
    })();
  }
}
