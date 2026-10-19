import { Component, signal } from '@angular/core';
import { ButtonAtom } from '@stellar/ui-atoms';

@Component({
  imports: [ButtonAtom],
  selector: 'stellar-root',
  templateUrl: './app.component.html',
})
export class AppComponent {
  readonly actionCount = signal(0);

  recordAction(): void {
    this.actionCount.update((count) => count + 1);
  }
}
