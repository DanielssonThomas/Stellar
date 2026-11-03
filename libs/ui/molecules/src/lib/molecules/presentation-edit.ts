import { InjectionToken } from '@angular/core';

/** User edits pass through the owning Stage decoder and advance its content revision. */
export const PRESENTATION_EDIT = new InjectionToken<(payload: unknown) => void>(
  'PRESENTATION_EDIT',
  { providedIn: 'root', factory: () => () => undefined },
);
export const PRESENTATION_SELECT = new InjectionToken<() => void>(
  'PRESENTATION_SELECT',
  { providedIn: 'root', factory: () => () => undefined },
);
