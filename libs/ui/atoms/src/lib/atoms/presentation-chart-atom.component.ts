import {
  afterRenderEffect,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  Chart,
  LineController,
  BarController,
  PieController,
  DoughnutController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Legend,
  Tooltip,
} from 'chart.js';
import {
  decodeWorkspaceChart,
  type WorkspaceChart,
} from '@stellar/desktop-contracts';
import { SkeletonAtom } from './skeleton-atom.component';
import { chartColors, chartConfiguration } from './presentation-chart-config';

Chart.register(
  LineController,
  BarController,
  PieController,
  DoughnutController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Legend,
  Tooltip,
);

@Component({
  selector: 'stellar-presentation-chart-atom',
  standalone: true,
  imports: [SkeletonAtom],
  templateUrl: './presentation-chart-atom.component.html',
  styleUrl: './presentation-chart-atom.component.css',
  host: {
    '[attr.aria-busy]': 'loading()',
    '[attr.data-render-state]': 'renderState()',
  },
})
export class PresentationChartAtom {
  readonly chart = input<WorkspaceChart | null>(null);
  readonly title = input('Chart');
  readonly loading = input(false);
  readonly renderState = signal<'loading' | 'ready' | 'error'>('loading');
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private instance?: Chart;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.instance?.destroy());
    afterRenderEffect(() => {
      const data = this.chart(),
        canvas = this.canvas()?.nativeElement;
      const loading = this.loading();
      this.instance?.destroy();
      this.instance = undefined;
      if (loading || !canvas || !data) {
        this.renderState.set('loading');
        return;
      }
      try {
        const validated = decodeWorkspaceChart(data);
        const style = getComputedStyle(this.host.nativeElement);
        const chart = new Chart(
          canvas,
          chartConfiguration(validated, chartColors(style)),
        );
        if (!chart.ctx) {
          chart.destroy();
          throw new Error('Chart context unavailable');
        }
        this.instance = chart;
        this.renderState.set('ready');
      } catch {
        this.renderState.set('error');
      }
    });
  }
}
