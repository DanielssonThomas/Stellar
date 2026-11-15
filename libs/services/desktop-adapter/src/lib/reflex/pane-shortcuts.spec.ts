import { describe, expect, it } from 'vitest';
import { paneShortcut } from './pane-shortcuts';

describe('admitted pane shortcuts', () => {
  it.each([
    'close panes',
    'close all panes',
    'close paints',
    'close paint',
    'close all paints',
    'close all paint',
    'Ivy, please close all panes.',
    'Close paints please!',
  ])('closes Stellar panes for the complete command %s', (text) =>
    expect(paneShortcut(text)?.id).toBe('layout.clear'),
  );
  it.each([
    'close pane',
    'do not close paints',
    '"close panes"',
    'close paintings',
    'close paint files',
    'if I say close panes',
    'close all panes and open a browser',
    'can you explain close panes',
    'close Paint on my computer',
  ])(
    'keeps unrelated, singular-target, quoted and combined input on normal routing: %s',
    (text) => expect(paneShortcut(text)).toBeNull(),
  );
  it('retains the two-pane swap shortcut', () =>
    expect(paneShortcut('swap')?.id).toBe('pane.swap_pair'));
});
