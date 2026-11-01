export interface ActivitySummaryPayload {
  readonly durationMs: number;
  readonly peakLevel: number;
  readonly inputLabel?: string;
}
