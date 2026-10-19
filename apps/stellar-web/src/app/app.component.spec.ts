import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  it('composes the shared button and responds to user activation', async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    await fixture.whenStable();

    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('[data-testid="action-count"]')
        .textContent,
    ).toContain('Actions: 1');
  });
});
