import { InjectionToken, Type } from '@angular/core';
import {
  ActivitySummaryMolecule,
  AssistantMessageMolecule,
} from '@stellar/ui-molecules';
import {
  decodeActivitySummary,
  decodeAssistantMessage,
} from './stage-contract';

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
        'assistant-message': Object.freeze({
          title: 'Assistant message',
          component: AssistantMessageMolecule,
          decode: decodeAssistantMessage,
        }),
        'activity-summary': Object.freeze({
          title: 'Activity summary',
          component: ActivitySummaryMolecule,
          decode: decodeActivitySummary,
        }),
      }),
  },
);
