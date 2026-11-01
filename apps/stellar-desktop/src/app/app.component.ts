import { afterNextRender, Component, inject, viewChild } from '@angular/core';
import { DesktopExperienceTemplate } from '@stellar/ui-templates';
import { DesktopExperience } from './desktop-experience';

@Component({
  imports: [DesktopExperienceTemplate],
  providers: [DesktopExperience],
  selector: 'stellar-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  readonly title = 'Stellar Desktop';
  readonly experience = inject(DesktopExperience);
  private readonly view = viewChild.required(DesktopExperienceTemplate);

  constructor() {
    afterNextRender(() =>
      this.experience.connect((command) => this.view().dispatch(command)),
    );
  }
}
