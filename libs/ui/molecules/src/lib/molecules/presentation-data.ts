import { InjectionToken, signal, type Signal } from '@angular/core';
import type { PresentationSourceView } from './presentation-model';
export interface PresentationData {
  readonly workflow: Signal<PresentationSourceView>;
  readonly session: Signal<PresentationSourceView>;
  readonly acquire: () => () => void;
}
export const PRESENTATION_DATA = new InjectionToken<PresentationData>(
  'PRESENTATION_DATA',
  {
    providedIn: 'root',
    factory: () => {
      const unavailable = signal<PresentationSourceView>({
        source: 'No connected source',
        observedAt: null,
        state: 'unavailable',
        rows: [],
      }).asReadonly();
      return {
        workflow: unavailable,
        session: unavailable,
        acquire: () => () => undefined,
      };
    },
  },
);
