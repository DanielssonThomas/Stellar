import { InjectionToken, Type } from '@angular/core';
import { ActivitySummaryMolecule } from '@stellar/ui-molecules';
import { decodeActivitySummary } from './stage-contract';

export interface StageSurfaceDefinition {
  readonly title: string;
  readonly component: Type<unknown>;
  readonly decode: (value: unknown) => unknown | null;
}

export type StageCatalogue = Readonly<Record<string, StageSurfaceDefinition>>;

export const STAGE_CATALOGUE = new InjectionToken<StageCatalogue>(
  'STAGE_CATALOGUE',
  {
    providedIn: 'root',
    factory: () =>
      Object.freeze({
        'activity-summary': Object.freeze({
          title: 'Activity summary',
          component: ActivitySummaryMolecule,
          decode: decodeActivitySummary,
        }),
      }),
  },
);
