import { Component } from '@angular/core';
import { MissionControlTemplate } from '@stellar/ui-templates';

@Component({
  imports: [MissionControlTemplate],
  selector: 'stellar-root',
  template: '<stellar-mission-control-template />',
})
export class AppComponent {}
