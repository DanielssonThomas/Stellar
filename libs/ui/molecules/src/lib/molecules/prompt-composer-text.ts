export function promptTextEdit(raw: string, refined: string) {
  const segments = (text: string) =>
    typeof Intl.Segmenter === 'function'
      ? [
          ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
            text,
          ),
        ].map((part) => part.segment)
      : Array.from(text);
  const source = segments(raw),
    target = segments(refined);
  let prefix = 0;
  while (prefix < source.length && source[prefix] === target[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(source.length, target.length) - prefix &&
    source[source.length - 1 - suffix] === target[target.length - 1 - suffix]
  )
    suffix++;
  const removed = source.length - prefix - suffix;
  const ending = suffix ? target.slice(-suffix) : [];
  return {
    steps: removed + target.length - prefix - suffix,
    at(step: number) {
      return step <= removed
        ? [...source.slice(0, source.length - suffix - step), ...ending].join(
            '',
          )
        : [...target.slice(0, prefix + step - removed), ...ending].join('');
    },
  };
}

export function fitPromptText(
  group: HTMLElement,
  host: HTMLElement,
  texts: readonly string[],
) {
  const stack = group.querySelector<HTMLElement>('.text-stack');
  const view = group.ownerDocument.defaultView;
  if (!stack || !view || host.clientHeight <= 0 || stack.clientWidth <= 0)
    return;
  group.style.removeProperty('--composer-text-size');
  const maximum = Number.parseFloat(view.getComputedStyle(group).fontSize);
  const style = view.getComputedStyle(stack);
  const vertical =
    Number.parseFloat(style.paddingTop) +
    Number.parseFloat(style.paddingBottom);
  const width =
    stack.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight);
  const available = Math.max(0, host.clientHeight - vertical);
  if (width <= 0 || available <= 0) {
    group.dataset['textFits'] = 'false';
    return;
  }
  if (!Number.isFinite(maximum)) return;
  const probe = group.ownerDocument.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    width: `${width}px`,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    lineHeight: '1.45',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  });
  group.append(probe);
  const heightAt = (size: number) => {
    probe.style.fontSize = `${size}px`;
    return Math.max(
      ...texts.map((text) => {
        probe.textContent = text || ' ';
        return probe.getBoundingClientRect().height;
      }),
    );
  };
  try {
    let low = 0.5,
      high = maximum;
    if (heightAt(low) > available) {
      group.dataset['textFits'] = 'false';
      return;
    }
    for (let pass = 0; pass < 12; pass++) {
      const middle = (low + high) / 2;
      if (heightAt(middle) <= available) low = middle;
      else high = middle;
    }
    const fitted = Math.floor(low * 100) / 100;
    group.style.setProperty('--composer-text-size', `${fitted}px`);
    group.style.height = `${Math.min(host.clientHeight, Math.max(60, heightAt(fitted) + vertical))}px`;
    group.dataset['textFits'] = 'true';
  } finally {
    probe.remove();
  }
}
