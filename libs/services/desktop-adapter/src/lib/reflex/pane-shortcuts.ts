import { isPaneSwap } from './pane-swap';

/** Exact commands only: paint/paints is the user's admitted voice alias for Stellar panes. */
export function paneShortcut(text: string) {
  if (isPaneSwap(text))
    return {
      id: 'pane.swap_pair',
      reply: 'Swapped the panes.',
      unavailable:
        'I need exactly two visible panes for that shortcut. Which panes should I swap?',
    };
  if (
    /^(?:ivy[, ]+)?(?:please )?close (?:(?:all )?panes|(?:all )?paints?|all pane)(?: please)?[.!?]?$/i.test(
      text.trim(),
    )
  )
    return {
      id: 'layout.clear',
      reply: 'All panes are closed.',
      unavailable: 'Pane controls are unavailable right now.',
    };
  return null;
}
