// DEJA VU shared runtime configuration.
// Loaded before index.js so gameplay, preview, scoring, and timing consume one
// authoritative difficulty/scoring table.
(function installRuntimeConfig() {
  if (window.DEJA_VU_RUNTIME) return;

  const difficulties = Object.freeze({
    easy: Object.freeze({ label: 'Easy', rows: 3, cols: 4, pairs: 6, memorizeMs: 4000, mismatchStudyMs: 1050 }),
    intermediate: Object.freeze({ label: 'Intermediate', rows: 4, cols: 4, pairs: 8, memorizeMs: 5000, mismatchStudyMs: 950 }),
    advanced: Object.freeze({ label: 'Advanced', rows: 4, cols: 5, pairs: 10, memorizeMs: 6000, mismatchStudyMs: 850 }),
    insane: Object.freeze({ label: 'Insane', rows: 6, cols: 5, pairs: 15, memorizeMs: 8000, mismatchStudyMs: 750 }),
  });

  const scoring = Object.freeze({ basePerPair: 1000, mistakePenalty: 350, timePenaltyPerSecond: 5 });

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
  window.DEJA_VU_BALANCE = runtime; // compatibility alias for preview/results modules
  window.DEJA_VU_PREVIEW_ACTIVE = false;

  const nativeSetTimeout = window.setTimeout.bind(window);
  const gameplayDelays = new Set([460, 470, 450, 10, 120]);

  function gameplayIsSuspended() {
    return document.hidden || Boolean(document.querySelector('#pause-dialog')?.open);
  }

  function runWhenGameplayActive(callback, args) {
    if (gameplayIsSuspended()) {
      nativeSetTimeout(() => runWhenGameplayActive(callback, args), 100);
      return;
    }
    callback(...args);
  }

  window.setTimeout = function configuredSetTimeout(callback, delay, ...args) {
    let configuredDelay = Number(delay);
    const gameScreenActive = document.querySelector('#screen-game')?.classList.contains('is-active');
    if (configuredDelay === 920 && typeof callback === 'function' && gameScreenActive) {
      configuredDelay = difficulties[difficultyKeyFromBoard()].mismatchStudyMs;
    }

    const isGameplayResolution = typeof callback === 'function' && gameScreenActive &&
      (gameplayDelays.has(Number(delay)) || Number(delay) === 920);
    if (isGameplayResolution) {
      return nativeSetTimeout(() => runWhenGameplayActive(callback, args), configuredDelay);
    }
    return nativeSetTimeout(callback, configuredDelay, ...args);
  };

  // The core clock is the only one-second interval registered during startup.
  // Gate it during memorization so mandatory study time is never scored.
  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = function configuredSetInterval(callback, delay, ...args) {
    if (Number(delay) !== 1000 || typeof callback !== 'function') return nativeSetInterval(callback, delay, ...args);
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
