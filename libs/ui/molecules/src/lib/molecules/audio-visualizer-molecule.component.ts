import { Component, ElementRef, input, output, viewChild } from '@angular/core';
import { SkeletonAtom } from '@stellar/ui-atoms';
import {
  silentEmblemMusic,
  type EmblemMusicLevels,
  type EmblemMusicMode,
} from './emblem-music-motion';

@Component({
  selector: 'stellar-audio-visualizer-molecule',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './audio-visualizer-molecule.component.html',
  styleUrl: './audio-visualizer-molecule.component.css',
  host: { '[attr.aria-busy]': 'loading()' },
})
export class AudioVisualizerMolecule {
  readonly enabled = input(false);
  readonly status = input('Music visualizer off');
  readonly levels = input<EmblemMusicLevels>(silentEmblemMusic);
  readonly sensitivity = input<EmblemMusicLevels>({
    level: 1,
    bass: 1,
    mid: 1,
    treble: 1,
  });
  readonly listeningChange = output<boolean>();
  readonly mode = input<EmblemMusicMode>('dynamic');
  readonly modeChange = output<EmblemMusicMode>();
  readonly modes: readonly {
    value: EmblemMusicMode;
    label: string;
    detail: string;
  }[] = [
    { value: 'calm', label: 'Calm', detail: 'Gentle drift · soft ring pulses' },
    {
      value: 'dynamic',
      label: 'Dynamic',
      detail: 'Directional fragments · ring kicks',
    },
    {
      value: 'flashy',
      label: 'Flashy',
      detail: 'Dimmed pieces · glittering sound pulses',
    },
  ];
  readonly sensitivityChange = output<{
    band: keyof EmblemMusicLevels;
    value: number;
  }>();
  readonly bands: readonly {
    key: keyof EmblemMusicLevels;
    label: string;
    detail: string;
  }[] = [
    { key: 'level', label: 'Overall sensitivity', detail: 'All movement' },
    { key: 'bass', label: 'Bass', detail: 'Low sounds · kick and bass' },
    {
      key: 'mid',
      label: 'Midrange',
      detail: 'Middle sounds · voices and instruments',
    },
    {
      key: 'treble',
      label: 'Treble',
      detail: 'High sounds · cymbals and detail',
    },
  ];
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  open() {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) dialog.showModal();
  }
  close() {
    this.dialog().nativeElement.close();
  }
  changeSensitivity(band: keyof EmblemMusicLevels, event: Event) {
    if (
      event.target instanceof HTMLInputElement &&
      Number.isFinite(event.target.valueAsNumber)
    )
      this.sensitivityChange.emit({
        band,
        value: event.target.valueAsNumber / 100,
      });
  }
  readonly loading = input(false);
}
