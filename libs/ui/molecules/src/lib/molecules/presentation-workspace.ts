import { InjectionToken } from '@angular/core';

export interface BrowserView {
  readonly url: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly focused?: boolean;
}
export interface BrowserPane {
  navigate(url: string): void;
  control(action: 'back' | 'forward' | 'reload'): void;
  dispose(): void;
}
export interface PresentationWorkspace {
  preview(src: string, signal: AbortSignal): Promise<string>;
  browser(
    element: HTMLElement,
    url: string,
    change: (view: BrowserView) => void,
  ): BrowserPane | null;
  external(url: string): Promise<void>;
}
export const PRESENTATION_WORKSPACE = new InjectionToken<PresentationWorkspace>(
  'PRESENTATION_WORKSPACE',
  {
    providedIn: 'root',
    factory: () => ({
      preview: async (src) => {
        if (src.startsWith('/emblem/layers/') || src.startsWith('data:image/'))
          return src;
        throw Error('Native image preview unavailable');
      },
      browser: () => null,
      external: async (url) => {
        const parsed = new URL(url);
        if (
          parsed.protocol === 'https:' &&
          !parsed.username &&
          !parsed.password
        )
          globalThis.open?.(parsed.href, '_blank', 'noopener,noreferrer');
      },
    }),
  },
);
