import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssistantMessageMolecule } from './assistant-message-molecule.component';

describe('AssistantMessageMolecule', () => {
  let fixture: ComponentFixture<AssistantMessageMolecule>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AssistantMessageMolecule],
    }).compileComponents();
    fixture = TestBed.createComponent(AssistantMessageMolecule);
    await fixture.whenStable();
  });

  it('renders requested content as plain text', async () => {
    fixture.componentRef.setInput('payload', {
      title: 'Hello',
      body: '<img src=x onerror=alert(1)> **plain**',
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(
      '<img src=x onerror=alert(1)> **plain**',
    );
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
  });

  it('shows a skeleton while loading', async () => {
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('stellar-skeleton-atom'),
    ).not.toBeNull();
    expect(fixture.nativeElement.getAttribute('aria-busy')).toBe('true');
  });
});
