// DEJA VU shared runtime configuration.
// Loaded before index.js so gameplay, preview, scoring, and legacy timing hooks
// all consume one authoritative difficulty/scoring table.
(function installRuntimeConfig() {
  if (window.DEJA_VU_RUNTIME) return;

  const difficulties = Object.freeze({
    easy: Object.freeze({ label: 'Easy', rows: 3, cols: 4, pairs: 6, memorizeMs: 4000, mismatchStudyMs: 1050 }),
    intermediate: Object.freeze({ label: 'Intermediate', rows: 4, cols: 4, pairs: 8, memorizeMs: 5000, mismatchStudyMs: 950 }),
    advanced: Object.freeze({ label: 'Advanced', rows: 4, cols: 5, pairs: 10, memorizeMs: 6000, mismatchStudyMs: 850 }),
    insane: Object.freeze({ label: 'Insane', rows: 6, cols: 5, pairs: 15, memorizeMs: 8000, mismatchStudyMs: 750 }),
  });

  const scoring = Object.freeze({
    basePerPair: 1000,
    mistakePenalty: 350,
    timePenaltyPerSecond: 5,
  });

  function difficultyKeyFromBoard() {
    const grid = document.querySelector('#card-grid');
    const rows = Number(grid?.getAttribute('aria-rowcount'));
    const cols = Number(grid?.getAttribute('aria-colcount'));
    return Object.entries(difficulties).find(([, item]) => item.rows === rows && item.cols === cols)?.[0] || 'easy';
  }

  function calculateScore(key, mistakes, elapsedSeconds) {
    const difficulty = difficulties[key] || difficulties.easy;
    return Math.max(0,
      difficulty.pairs * scoring.basePerPair -
      mistakes * scoring.mistakePenalty -
      elapsedSeconds * scoring.timePenaltyPerSecond
    );
  }

  const runtime = Object.freeze({ difficulties, scoring, difficultyKeyFromBoard, calculateScore });
  window.DEJA_VU_RUNTIME = runtime;
  // Compatibility alias for modules introduced before the architecture cleanup.
  window.DEJA_VU_BALANCE = runtime;
  window.DEJA_VU_PREVIEW_ACTIVE = false;

  // Legacy index.js still requests the original 920ms mismatch-study delay.
  // Keep the compatibility hook isolated here until the core engine is modularized.
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function configuredSetTimeout(callback, delay, ...args) {
    if (Number(delay) === 920 && typeof callback === 'function' && document.querySelector('#screen-game')?.classList.contains('is-active')) {
      return nativeSetTimeout(callback, difficulties[difficultyKeyFromBoard()].mismatchStudyMs, ...args);
    }
    return nativeSetTimeout(callback, delay, ...args);
  };

  // The core clock is the only one-second interval registered during startup.
  // Gate it during the mandatory memorization phase so study time is never scored.
  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function configuredSetInterval(callback, delay, ...args) {
    if (Number(delay) !== 1000 || typeof callback !== 'function') {
      return nativeSetInterval(callback, delay, ...args);
    }
    return nativeSetInterval(() => {
      if (window.DEJA_VU_PREVIEW_ACTIVE) return;
      callback(...args);
    }, delay);
  };

  const completeScore = document.querySelector('#complete-score');
  if (completeScore) {
    new MutationObserver(() => {
      const key = difficultyKeyFromBoard();
      const mistakes = Number(document.querySelector('#stat-mistakes')?.textContent || 0);
      const [minutes, seconds] = (document.querySelector('#stat-time')?.textContent || '00:00').split(':').map(Number);
      const score = calculateScore(key, Math.max(0, mistakes || 0), Math.max(0, (minutes || 0) * 60 + (seconds || 0)));
      const formatted = score.toLocaleString();
      if (completeScore.textContent !== formatted) completeScore.textContent = formatted;
    }).observe(completeScore, { childList: true, characterData: true, subtree: true });
  }

  const helpCopy = document.querySelector('#screen-help .help-copy');
  if (helpCopy && !document.querySelector('#score-explainer')) {
    const note = document.createElement('p');
    note.id = 'score-explainer';
    note.innerHTML = '<strong>Scoring:</strong> each pair is worth 1,000 points, minus 350 per mistake and 5 per gameplay second. Memorization time does not reduce your score.';
    helpCopy.append(note);
  }
})();
