import { DestroyRef, inject, Injectable, InjectionToken } from '@angular/core';
import { DesktopAdapter } from '../desktop-adapter';
import {
  createBrowserDesktopTransport,
  createNativeDesktopTransport,
  type DesktopTransport,
  type NativeDesktopApi,
} from '../desktop-transport';

export const DESKTOP_TRANSPORT = new InjectionToken<DesktopTransport>(
  'DesktopTransport',
  {
    providedIn: 'root',
    factory: () => {
      const api = (
        globalThis as typeof globalThis & { __TAURI__?: NativeDesktopApi }
      ).__TAURI__;
      return api
        ? createNativeDesktopTransport(api)
        : createBrowserDesktopTransport();
    },
  },
);

@Injectable({ providedIn: 'root' })
export class DesktopAdapterService extends DesktopAdapter {
  constructor() {
    super(inject(DESKTOP_TRANSPORT));
    inject(DestroyRef).onDestroy(() => this.dispose());
  }
}
