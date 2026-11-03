/* Test build only: installed before application scripts can request capture. */
(() => {
  let installed = false;
  let attempted = false;
  Object.defineProperty(window, '__STELLAR_SPEECH_GUARD__', {
    value: Object.freeze({
      get installed() {
        return installed;
      },
      get attempted() {
        return attempted;
      },
    }),
  });
  try {
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () => {
          attempted = true;
          return Promise.reject(
            new DOMException(
              'Capture disabled in recognition qualification',
              'NotAllowedError',
            ),
          );
        },
        writable: false,
        configurable: false,
      });
      installed = true;
    }
  } catch {
    // The probe refuses qualification if the pre-start guard could not install.
  }
})();
