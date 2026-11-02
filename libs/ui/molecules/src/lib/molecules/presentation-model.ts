export type PresentationTextBlock =
  | { readonly kind: 'paragraph' | 'heading'; readonly text: string }
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
  readonly blocks: readonly PresentationTextBlock[];
}
export type PresentationMediaPayload =
  | {
      readonly kind: 'image';
      readonly title: string;
      readonly src: string;
      readonly alt: string;
      readonly caption?: string;
    }
  | { readonly kind: 'browser'; readonly title: string; readonly url: string };
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
