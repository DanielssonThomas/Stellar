import { Component, input } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';

@Component({
  selector: 'stellar-voice-transcript-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './voice-transcript-molecule.component.html',
  styleUrl: './voice-transcript-molecule.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[class.motion-reduced]': 'reducedMotion()',
  },
})
export class VoiceTranscriptMolecule {
  readonly label = input('Recognized speech');
  readonly ariaLabel = input('Voice input');
  readonly text = input('');
  readonly status = input('');
  readonly loading = input(false);
  readonly reducedMotion = input(false);
}
