import { Component, input, OnDestroy } from '@angular/core';

export const fixtureLifecycle = { destroyed: 0 };

@Component({
  selector: 'stellar-test-fixture-organism',
  standalone: true,
  template: '<p>{{ payload().label }}</p>',
})
export class TestFixtureOrganism implements OnDestroy {
  readonly payload = input.required<{ label: string }>();
  ngOnDestroy() {
    fixtureLifecycle.destroyed++;
  }
}
