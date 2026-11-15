(async () => {
  // Fixed synthetic pixels in the isolated smoke window, never the user's desktop.
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    zIndex: '2147483647',
  });
  document.body.append(overlay);
  let seed = 41;
  let fullBytes = 0;
  for (let pane = 0; pane < 2; pane++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(innerWidth / 2);
    canvas.height = innerHeight;
    canvas.style.width = '50%';
    canvas.style.height = '100%';
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[offset + channel] = seed >>> 24;
      }
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    overlay.append(canvas);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    fullBytes += blob.size;
  }
  if (fullBytes <= 4 * 1024 * 1024) return false;
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (
        !(await window.__TAURI__.core.invoke('smoke_capture_window', {
          detailed: true,
        }))
      )
        return false;
    }
    return true;
  } finally {
    overlay.remove();
  }
})();
