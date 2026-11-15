import {
  decodeBrowserEvent,
  type BrowserAction,
  type BrowserBounds,
} from '@stellar/desktop-contracts';

export interface MediaNativeApi {
  core: {
    invoke(command: string, args: { request: unknown }): Promise<unknown>;
  };
  event: {
    listen(
      event: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void>;
  };
}
export interface BrowserPaneView {
  readonly url: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly focused?: boolean;
}

/** One serialized resource owner; disposal is ordered after creation and fences late listeners. */
export function createBrowserPane(
  api: MediaNativeApi,
  element: HTMLElement,
  initialUrl: string,
  change: (view: BrowserPaneView) => void,
) {
  const id = crypto.randomUUID();
  let disposed = false,
    opened = false,
    blocked = false,
    currentUrl = initialUrl;
  let tail = Promise.resolve();
  let generation = 1;
  let awaitingNavigation = true;
  let requestedUrl: string | null = initialUrl;
  let unsubscribe: (() => void) | undefined;
  let frame = 0;
  let trackingUntil = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let lastBounds = '';
  let pendingBounds: BrowserBounds | null = null;
  let syncing = false;
  let opening = false;
  let lastView: BrowserPaneView = {
    url: initialUrl,
    pending: true,
    error: null,
  };
  const report = (pending: boolean, error: string | null) => {
    lastView = { url: currentUrl, pending, error };
    if (!disposed) change(lastView);
  };
  const geometry = (): BrowserBounds => {
    const rect = element.getBoundingClientRect();
    const clip = element.closest('.pane-scroll')?.getBoundingClientRect();
    const left = Math.max(0, rect.x, clip?.x ?? 0),
      top = Math.max(0, rect.y, clip?.y ?? 0);
    const right = Math.min(
        window.innerWidth,
        rect.x + rect.width,
        clip ? clip.x + clip.width : window.innerWidth,
      ),
      bottom = Math.min(
        window.innerHeight,
        rect.y + rect.height,
        clip ? clip.y + clip.height : window.innerHeight,
      );
    const menu = element.ownerDocument.querySelector(
      '[aria-label="Experience menu"][aria-expanded="true"]',
    );
    const visible =
      !disposed &&
      !blocked &&
      element.isConnected &&
      right > left &&
      bottom > top &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[inert]') &&
      !menu;
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      visible,
    };
  };
  const invoke = (operation: BrowserAction, always = false) => {
    let succeeded = false;
    tail = tail
      .then(async () => {
        if (disposed && !always) return;
        await api.core.invoke('workspace_browser', {
          request: { version: 1, operation },
        });
        succeeded = true;
      })
      .catch(() => {
        if (!disposed) {
          blocked = true;
          report(
            false,
            'This page could not be opened. Try reload or open it externally.',
          );
        }
      });
    return tail.then(() => succeeded);
  };
  const sync = () => {
    frame = 0;
    if (!opened || disposed) return;
    const bounds = geometry(),
      key = JSON.stringify(bounds);
    if (key !== lastBounds) {
      lastBounds = key;
      pendingBounds = bounds;
      if (!syncing) {
        syncing = true;
        void (async () => {
          while (pendingBounds && !disposed) {
            const next = pendingBounds;
            pendingBounds = null;
            await invoke({ action: 'bounds', id, bounds: next });
          }
          syncing = false;
        })();
      }
    }
    if (performance.now() < trackingUntil) schedule();
  };
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(sync);
  };
  const layoutChange = (event: Event) => {
    if (
      !(event.target instanceof HTMLElement) ||
      !event.target.contains(element)
    )
      return;
    const duration = (event as CustomEvent<{ duration: number }>).detail
      ?.duration;
    trackingUntil =
      performance.now() +
      Math.max(0, Math.min(500, typeof duration === 'number' ? duration : 0));
    schedule();
  };
  const loading = () => {
    blocked = false;
    clearTimeout(timeout);
    report(true, null);
    timeout = setTimeout(() => {
      blocked = true;
      report(
        false,
        'The page did not finish loading. Try reload or open it externally.',
      );
      schedule();
    }, 20_000);
  };
  const observer =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  observer?.observe(element);
  const mutation =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(schedule)
      : null;
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
    mutation?.observe(node, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert'],
    });
  const menu = element.ownerDocument.querySelector(
    '[aria-label="Experience menu"]',
  );
  if (menu)
    mutation?.observe(menu, {
      attributes: true,
      attributeFilter: ['aria-expanded'],
    });
  window.addEventListener('resize', schedule);
  element.ownerDocument.addEventListener('scroll', schedule, true);
  window.addEventListener('stellar-stage-layout', layoutChange);
  const attemptOpen = () => {
    if (disposed || opening || !unsubscribe) return;
    opening = true;
    loading();
    const openGeneration = generation;
    void invoke({
      action: 'open',
      id,
      generation: openGeneration,
      url: currentUrl,
      bounds: geometry(),
    }).then((succeeded) => {
      opening = false;
      opened = succeeded;
      if (succeeded && !disposed && generation !== openGeneration)
        void invoke({ action: 'navigate', id, generation, url: currentUrl });
      if (!disposed) schedule();
    });
  };
  loading();
  void api.event
    .listen('stellar-browser', (event) => {
      if (disposed) return;
      let data;
      try {
        data = decodeBrowserEvent(event.payload);
      } catch {
        return;
      }
      if (data.id !== id) return;
      if (data.state === 'focused') {
        change({ ...lastView, focused: true });
        return;
      }
      if (data.generation !== generation) return;
      if (awaitingNavigation) {
        if (
          data.state !== 'loading' ||
          (requestedUrl && data.url !== requestedUrl)
        )
          return;
        awaitingNavigation = false;
      }
      if (data.state === 'failed') {
        clearTimeout(timeout);
        blocked = true;
        report(
          false,
          'This page could not be rendered. Open it externally for unsupported content.',
        );
        schedule();
        return;
      }
      if (data.state === 'blocked') {
        blocked = true;
        report(
          false,
          'Navigation blocked. Only public HTTPS pages are supported.',
        );
        schedule();
        return;
      }
      currentUrl = data.url;
      if (data.state === 'loading') loading();
      else {
        clearTimeout(timeout);
        blocked = false;
        report(false, null);
        schedule();
      }
    })
    .then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      unsubscribe = stop;
      attemptOpen();
    })
    .catch(() => {
      blocked = true;
      report(
        false,
        'Embedded browsing is unavailable. Open the page externally.',
      );
    });
  return {
    navigate(url: string) {
      if (generation === 4294967295) return;
      generation++;
      awaitingNavigation = true;
      requestedUrl = url;
      currentUrl = url;
      loading();
      if (opened) void invoke({ action: 'navigate', id, generation, url });
      schedule();
    },
    control(action: 'back' | 'forward' | 'reload') {
      if (!opened) {
        if (action === 'reload') attemptOpen();
        return;
      }
      if (generation === 4294967295) return;
      generation++;
      awaitingNavigation = true;
      requestedUrl = action === 'reload' ? currentUrl : null;
      if (action === 'reload') loading();
      void invoke({ action, id, generation });
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      mutation?.disconnect();
      unsubscribe?.();
      window.removeEventListener('resize', schedule);
      element.ownerDocument.removeEventListener('scroll', schedule, true);
      window.removeEventListener('stellar-stage-layout', layoutChange);
      void invoke({ action: 'close', id }, true);
    },
  };
}
