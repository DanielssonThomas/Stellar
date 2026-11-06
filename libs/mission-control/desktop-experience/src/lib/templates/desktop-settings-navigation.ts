import { signal } from '@angular/core';
import clsx from 'clsx';

export type DesktopSettingsSection =
  | 'overview'
  | 'microphone'
  | 'ivy'
  | 'awareness';
export const desktopSettingsSections = [
  { id: 'overview', label: 'Overview', icon: '◈' },
  { id: 'microphone', label: 'Microphone', icon: '◌' },
  { id: 'ivy', label: 'Ivy', icon: '✦' },
  { id: 'awareness', label: 'App awareness', icon: '◎' },
] as const;

export class DesktopSettingsNavigation {
  readonly sections = desktopSettingsSections;
  readonly selected = signal<DesktopSettingsSection>('overview');
  constructor(
    private readonly dialog: () => HTMLDialogElement,
    private readonly reducedMotion: () => boolean,
  ) {}

  classes(id: DesktopSettingsSection) {
    return clsx('settings-nav-item', {
      'settings-nav-selected': this.selected() === id,
    });
  }
  show(id: DesktopSettingsSection) {
    const viewport = this.dialog().querySelector<HTMLElement>(
      '[data-settings-scroll]',
    );
    const section = this.dialog().querySelector<HTMLElement>(
      `[data-settings-section="${id}"]`,
    );
    if (!viewport || !section) return;
    this.selected.set(id);
    const top =
      viewport.scrollTop +
      section.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top;
    viewport.scrollTo({
      top,
      behavior: this.reducedMotion() ? 'instant' : 'smooth',
    });
  }
  scrolled() {
    const viewport = this.dialog().querySelector<HTMLElement>(
      '[data-settings-scroll]',
    );
    if (!viewport) return;
    if (
      viewport.scrollHeight > viewport.clientHeight &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 8
    ) {
      this.selected.set('awareness');
      return;
    }
    const top = viewport.getBoundingClientRect().top + 28;
    let selected: DesktopSettingsSection = 'overview';
    for (const section of this.sections) {
      const element = viewport.querySelector<HTMLElement>(
        `[data-settings-section="${section.id}"]`,
      );
      if (element && element.getBoundingClientRect().top <= top)
        selected = section.id;
    }
    this.selected.set(selected);
  }
  keydown(event: KeyboardEvent) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const index = this.sections.findIndex(
      (section) => section.id === this.selected(),
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? this.sections.length - 1
          : (index +
              (event.key === 'ArrowDown' ? 1 : -1) +
              this.sections.length) %
            this.sections.length;
    event.preventDefault();
    const id = this.sections[next].id;
    this.show(id);
    this.dialog()
      .querySelector<HTMLElement>(`[data-settings-nav="${id}"]`)
      ?.focus();
  }
}
