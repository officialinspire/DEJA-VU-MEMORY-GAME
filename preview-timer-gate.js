// Prevent the one-second gameplay clock from advancing during the required
// initial memorization phase. Loaded before index.js so its interval is gated.
(function installPreviewTimerGate() {
  if (window.__DEJA_VU_TIMER_GATE_INSTALLED__) return;
  window.__DEJA_VU_TIMER_GATE_INSTALLED__ = true;
  window.DEJA_VU_PREVIEW_ACTIVE = false;

  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function gatedSetInterval(callback, delay, ...args) {
    if (Number(delay) !== 1000 || typeof callback !== 'function') {
      return nativeSetInterval(callback, delay, ...args);
    }

    return nativeSetInterval(() => {
      if (window.DEJA_VU_PREVIEW_ACTIVE) return;
      callback(...args);
    }, delay);
  };
})();
