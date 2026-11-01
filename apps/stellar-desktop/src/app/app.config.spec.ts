import { DOCUMENT } from '@angular/common';
import { CSP_NONCE } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { appConfig } from './app.config';

describe('desktop runtime style nonce', () => {
  it('passes the nonce supplied by Tauri to Angular component styles', () => {
    const page = document.implementation.createHTMLDocument();
    const anchor = page.createElement('style');
    anchor.id = 'stellar-csp-anchor';
    anchor.nonce = 'fresh-response-nonce';
    page.head.appendChild(anchor);
    TestBed.configureTestingModule({
      providers: [appConfig.providers, { provide: DOCUMENT, useValue: page }],
    });
    expect(TestBed.inject(CSP_NONCE)).toBe('fresh-response-nonce');
  });

  it('uses no nonce in the browser development server without a response nonce', () => {
    const page = document.implementation.createHTMLDocument();
    page.head.innerHTML = '<style id="stellar-csp-anchor"></style>';
    TestBed.configureTestingModule({
      providers: [appConfig.providers, { provide: DOCUMENT, useValue: page }],
    });
    expect(TestBed.inject(CSP_NONCE)).toBeNull();
  });
});
