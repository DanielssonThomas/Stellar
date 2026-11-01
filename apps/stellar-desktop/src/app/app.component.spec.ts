import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { provideHttpClient } from '@angular/common/http';
import { server } from '@stellar/test-support';
import { http, HttpResponse } from 'msw';

describe('AppComponent', () => {
  it('renders the application name', async () => {
    server.use(
      http.get('*/emblem/manifest.json', () =>
        HttpResponse.json({
          version: 1,
          viewBox: [0, 0, 512, 512],
          layers: [],
        }),
      ),
    );
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideHttpClient()],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('h1').textContent).toContain(
      'Stellar Desktop',
    );
  });
});
