export type PresentationTextBlock =
  | {
      readonly kind: 'paragraph' | 'heading' | 'markdown';
      readonly text: string;
      readonly level?: 1 | 2 | 3 | 4 | 5 | 6;
    }
  | { readonly kind: 'code'; readonly text: string; readonly language?: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | {
      readonly kind: 'checklist';
      readonly items: readonly {
        readonly text: string;
        readonly checked: boolean;
      }[];
    }
  | {
      readonly kind: 'table';
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export interface PresentationTextPayload {
  readonly title: string;
  readonly typography?: {
    readonly family?: 'sans' | 'serif' | 'mono';
    readonly fontSize?: number;
    readonly bold?: boolean;
    readonly italic?: boolean;
  };
  readonly blocks: readonly PresentationTextBlock[];
}
export type PresentationMediaPayload =
  | {
      readonly kind: 'image';
      readonly title: string;
      readonly src: string;
      readonly alt: string;
      readonly caption?: string;
      readonly source?: string;
      readonly images?: readonly PresentationImage[];
      readonly selected?: number;
      readonly zoom?: number;
    }
  | {
      readonly kind: 'browser';
      readonly title: string;
      readonly chrome?: boolean;
      readonly url: string;
      readonly refresh?: number;
    };
export interface PresentationImage {
  readonly src: string;
  readonly alt: string;
  readonly caption?: string;
  readonly source?: string;
}
export interface PresentationDiagramPayload {
  readonly title: string;
  readonly nodes: readonly { readonly id: string; readonly label: string }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly label?: string;
  }[];
}
export interface PresentationTelemetryPayload {
  readonly kind: 'workflow' | 'session';
  readonly title: string;
  readonly project?: 'stellar' | 'stellar-design';
  readonly agentId?: string;
}
export interface PresentationSourceView {
  readonly source: string;
  readonly observedAt: string | null;
  readonly state: 'loading' | 'available' | 'unavailable';
  readonly rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly detail?: string;
    readonly project?: string;
  }[];
}
