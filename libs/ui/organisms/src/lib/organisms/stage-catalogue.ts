import { InjectionToken, Type } from '@angular/core';
import {
  ActivitySummaryMolecule,
  AssistantMessageMolecule,
  PresentationTextMolecule,
  PresentationMediaMolecule,
  PresentationDiagramMolecule,
  PresentationChartMolecule,
  PresentationIssueMolecule,
  PresentationTelemetryMolecule,
} from '@stellar/ui-molecules';
import {
  decodeActivitySummary,
  decodeAssistantMessage,
} from './stage-contract';
import {
  decodePresentationText,
  decodePresentationImage,
  decodePresentationBrowser,
  decodePresentationDiagram,
  decodePresentationChart,
  decodePresentationIssue,
  decodePresentationWorkflow,
  decodePresentationSession,
} from './presentation-decoders';

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
        'rich-text': Object.freeze({
          title: 'Rich text',
          component: PresentationTextMolecule,
          decode: decodePresentationText,
        }),
        image: Object.freeze({
          title: 'Image',
          component: PresentationMediaMolecule,
          decode: decodePresentationImage,
        }),
        browser: Object.freeze({
          title: 'Browser',
          component: PresentationMediaMolecule,
          decode: decodePresentationBrowser,
        }),
        diagram: Object.freeze({
          title: 'Diagram',
          component: PresentationDiagramMolecule,
          decode: decodePresentationDiagram,
        }),
        chart: Object.freeze({
          title: 'Chart',
          component: PresentationChartMolecule,
          decode: decodePresentationChart,
        }),
        workflow: Object.freeze({
          title: 'Stellar workflow',
          component: PresentationTelemetryMolecule,
          decode: decodePresentationWorkflow,
        }),
        'github-issue': Object.freeze({
          title: 'GitHub issue',
          component: PresentationIssueMolecule,
          decode: decodePresentationIssue,
        }),
        session: Object.freeze({
          title: 'Ivy session',
          component: PresentationTelemetryMolecule,
          decode: decodePresentationSession,
        }),
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
