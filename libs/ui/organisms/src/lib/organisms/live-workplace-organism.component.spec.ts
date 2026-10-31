import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LiveWorkplaceOrganism,
  type WorkplaceAgent,
} from './live-workplace-organism.component';

function agent(id: string, state: WorkplaceAgent['state']): WorkplaceAgent {
  return {
    id,
    name: id === 'designer' ? 'Designer' : 'Peon',
    state,
    activity: state === 'running' ? 'Editing files' : null,
  };
}

describe('LiveWorkplaceOrganism', () => {
  let fixture: ComponentFixture<LiveWorkplaceOrganism>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LiveWorkplaceOrganism],
    }).compileComponents();
    fixture = TestBed.createComponent(LiveWorkplaceOrganism);
    await fixture.whenStable();
  });

  it('animates only verified running agents and emits workstation selection', async () => {
    fixture.componentRef.setInput('agents', [
      agent('peon', 'unknown'),
      agent('designer', 'running'),
    ]);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelectorAll('.station.is-running'),
    ).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelectorAll('.avatar.working'),
    ).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('Execution unknown');
    expect(fixture.nativeElement.textContent).toContain('Editing files');
    let selected = '';
    fixture.componentInstance.selectAgent.subscribe((id) => (selected = id));
    fixture.nativeElement
      .querySelector('[aria-label="Inspect Peon, Execution unknown"]')
      .click();
    expect(selected).toBe('peon');
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
