import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopSettingsNavigation } from '../../../desktop-experience/src/lib/templates/desktop-settings-navigation';

describe('settings section navigation', () => {
  afterEach(() => document.body.replaceChildren());

  function setup(reduced = false) {
    const dialog = document.createElement('dialog');
    dialog.open = true;
    const ids = ['overview', 'microphone', 'ivy', 'awareness'];
    dialog.innerHTML =
      ids
        .map((id) => `<button data-settings-nav="${id}">${id}</button>`)
        .join('') +
      `<div data-settings-scroll>${ids.map((id) => `<section data-settings-section="${id}"></section>`).join('')}</div>`;
    document.body.append(dialog);
    const viewport = dialog.querySelector<HTMLElement>(
      '[data-settings-scroll]',
    ) as HTMLElement;
    const scroll = vi.fn();
    viewport.scrollTo = scroll;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1600 },
      clientHeight: { value: 400 },
    });
    viewport.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    for (const [index, section] of Array.from(viewport.children).entries()) {
      section.getBoundingClientRect = () =>
        ({ top: 100 + index * 400 - viewport.scrollTop }) as DOMRect;
    }
    return {
      dialog,
      viewport,
      scroll,
      navigation: new DesktopSettingsNavigation(
        () => dialog,
        () => reduced,
      ),
    };
  }

  it('scrolls the requested section in its own viewport and respects reduced motion', () => {
    const { navigation, scroll, viewport } = setup(true);
    viewport.scrollTop = 200;
    navigation.show('ivy');
    expect(scroll).toHaveBeenCalledWith({ top: 800, behavior: 'instant' });
    expect(navigation.selected()).toBe('ivy');
    expect(navigation.classes('ivy')).toContain('settings-nav-selected');
  });

  it('tracks manual scrolling and selects the final section at the viewport bottom', () => {
    const { navigation, viewport } = setup();
    viewport.scrollTop = 410;
    navigation.scrolled();
    expect(navigation.selected()).toBe('microphone');
    viewport.scrollTop = 1198;
    navigation.scrolled();
    expect(navigation.selected()).toBe('awareness');
  });

  it('supports cyclic arrow navigation, Home and End with focus on the destination', () => {
    const { navigation, dialog, scroll } = setup();
    for (const [key, id] of [
      ['ArrowUp', 'awareness'],
      ['ArrowDown', 'overview'],
      ['End', 'awareness'],
      ['Home', 'overview'],
    ]) {
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      navigation.keydown(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(
        dialog.querySelector(`[data-settings-nav="${id}"]`),
      );
      expect(navigation.selected()).toBe(id);
    }
    expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    const event = new KeyboardEvent('keydown', { key: 'c', cancelable: true });
    navigation.keydown(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
