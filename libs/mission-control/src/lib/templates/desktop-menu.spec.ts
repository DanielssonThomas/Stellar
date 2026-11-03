import { afterEach, describe, expect, it } from 'vitest';
import { DesktopMenu } from '../../../desktop-experience/src/lib/templates/desktop-menu';

describe('desktop controls dialog', () => {
  afterEach(() => document.body.replaceChildren());
  function setup() {
    const host = document.createElement('div');
    host.tabIndex = -1;
    host.innerHTML =
      '<button id="origin">Origin</button><dialog><button>Close</button></dialog>';
    document.body.append(host);
    const dialog = host.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = () => {
      dialog.open = true;
      dialog.querySelector('button')?.focus();
    };
    dialog.close = () => {
      dialog.open = false;
    };
    const menu = new DesktopMenu(host, () => dialog);
    return {
      host,
      dialog,
      menu,
      origin: host.querySelector('button') as HTMLButtonElement,
    };
  }
  it('opens modally, toggles closed and restores the keyboard origin', () => {
    const { menu, origin } = setup();
    origin.focus();
    menu.toggle();
    expect(menu.open()).toBe(true);
    expect(document.activeElement?.textContent).toBe('Close');
    menu.toggle();
    expect(menu.open()).toBe(false);
    expect(document.activeElement).toBe(origin);
  });
  it('restores the desktop after native Escape closes the dialog or the origin disappears', () => {
    const { host, dialog, menu, origin } = setup();
    origin.focus();
    menu.toggle();
    origin.remove();
    dialog.close();
    menu.restoreFocus();
    expect(document.activeElement).toBe(host);
  });
  it('ignores a queued close event after reopening and restores the desktop for a body origin', () => {
    const { host, menu } = setup();
    menu.toggle();
    menu.close();
    expect(document.activeElement).toBe(host);
    menu.toggle();
    menu.restoreFocus();
    expect(menu.open()).toBe(true);
    expect(document.activeElement?.textContent).toBe('Close');
  });
});
