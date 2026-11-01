import { DOCUMENT } from '@angular/common';
import {
  ApplicationConfig,
  CSP_NONCE,
  inject,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    {
      provide: CSP_NONCE,
      // Tauri adds a fresh style nonce to embedded HTML; Angular creates its styles later.
      useFactory: () =>
        inject(DOCUMENT).querySelector<HTMLStyleElement>('#stellar-csp-anchor')
          ?.nonce || null,
    },
  ],
};
