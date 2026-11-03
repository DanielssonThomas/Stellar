import { decodeImagePreview } from '@stellar/desktop-contracts';
import {
  createBrowserPane,
  type BrowserPaneView,
  type MediaNativeApi,
} from './browser-pane';

export function createNativeMediaWorkspace(api: MediaNativeApi) {
  return {
    async preview(src: string, signal: AbortSignal) {
      if (/^\/emblem\/layers\/[a-z0-9-]+\.(png|webp)$/.test(src)) return src;
      if (signal.aborted) throw Error('Cancelled');
      const result = decodeImagePreview(
        await api.core.invoke('workspace_image', {
          request: { version: 1, url: src },
        }),
      );
      if (signal.aborted) throw Error('Cancelled');
      return result.data_uri;
    },
    browser: (
      element: HTMLElement,
      url: string,
      change: (view: BrowserPaneView) => void,
    ) => createBrowserPane(api, element, url, change),
    async external(url: string) {
      await api.core.invoke('workspace_browser', {
        request: { version: 1, operation: { action: 'external', url } },
      });
    },
  };
}
