import { afterEach, describe, expect, it } from 'vitest';
import { DesktopMenu } from '../../../desktop-experience/src/lib/templates/desktop-menu';

describe('desktop menu disclosure', () => {
  afterEach(() => document.body.replaceChildren());
  it('closes on Escape and restores the trigger; outside dismissal preserves clicked focus', async () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<button id="trigger">Menu</button><section data-desktop-menu><button>Start</button></section><button id="outside">Outside</button>';
    document.body.append(host);
    const trigger = host.querySelector<HTMLButtonElement>('#trigger');
    const outside = host.querySelector<HTMLButtonElement>('#outside');
    if (!trigger || !outside) throw new Error('Missing test controls');
    const menu = new DesktopMenu(host, () => trigger);
    menu.toggle();
    await Promise.resolve();
    expect(document.activeElement?.textContent).toBe('Start');
    menu.keydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.open()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    menu.toggle();
    await Promise.resolve();
    outside.focus();
    outside.addEventListener('pointerdown', (event) => menu.outside(event));
    outside.dispatchEvent(new Event('pointerdown'));
    expect(menu.open()).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});
