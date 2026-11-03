export function createEmblemImagePreparation(
  view: Pick<Window, 'setTimeout' | 'clearTimeout'> | null,
) {
  let timer: number | undefined;
  let generation = 0;
  let disposed = false;

  function cancel() {
    generation++;
    if (timer !== undefined) view?.clearTimeout(timer);
    timer = undefined;
  }

  return {
    schedule(images: readonly HTMLImageElement[]) {
      cancel();
      if (disposed || !view || images.length === 0) return;
      const request = generation;
      // Wait for responsive source selection and for a resize burst to settle.
      timer = view.setTimeout(() => {
        timer = undefined;
        const unique = new Map(
          images.map((image) => [image.currentSrc || image.src, image]),
        );
        const pending = [...unique.values()].filter(
          (image) =>
            Boolean(image.currentSrc || image.src) &&
            typeof image.decode === 'function',
        );
        let next = 0;
        const decode = async () => {
          while (!disposed && request === generation && next < pending.length) {
            const image = pending[next++];
            try {
              await image.decode();
            } catch {
              // Source replacement aborts decode; actual load failures use img's error event.
            }
          }
        };
        for (let worker = 0; worker < Math.min(4, pending.length); worker++)
          void decode();
      }, 120);
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
