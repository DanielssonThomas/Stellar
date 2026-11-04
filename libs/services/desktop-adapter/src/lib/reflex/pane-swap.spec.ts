import { describe, expect, it } from 'vitest';
import { isPaneSwap } from './pane-swap';
describe('two-pane swap shorthand', () => {
  it.each([
    'swap',
    'swap pane',
    'swap panes',
    'swap the pane positions',
    'Ivy, please swap the panes.',
    'Swap please!',
  ])('admits the complete shortcut %s', (text) =>
    expect(isPaneSwap(text)).toBe(true),
  );
  it.each([
    'do not swap',
    '"swap"',
    'swap images',
    'swap the browser for a document',
    'swap and close',
    'what does swap mean?',
    'swap panes tomorrow',
    'if I say swap',
    'swap memory',
  ])('retains normal routing for %s', (text) =>
    expect(isPaneSwap(text)).toBe(false),
  );
});
