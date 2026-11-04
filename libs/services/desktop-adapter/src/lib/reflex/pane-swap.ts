/** Deliberately exact: quoted, negated, multi-action and unrelated swap requests keep normal routing. */
export function isPaneSwap(text: string): boolean {
  return /^(?:ivy[, ]+)?(?:please )?swap(?: (?:the )?(?:pane|panes)(?: positions)?)?(?: please)?[.!?]?$/i.test(
    text.trim(),
  );
}
