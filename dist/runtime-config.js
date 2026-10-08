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
  const performanceBands = Object.freeze([
    Object.freeze({ rating: 'EXCELLENT', minimum: 85, maximum: 100 }),
    Object.freeze({ rating: 'GOOD', minimum: 70, maximum: 84 }),
    Object.freeze({ rating: 'AVERAGE', minimum: 50, maximum: 69 }),
    Object.freeze({ rating: 'POOR', minimum: 0, maximum: 49 }),
  ]);

  function difficultyKeyFromBoard() {
    const grid = document.querySelector('#card-grid');
    const rows = Number(grid?.getAttribute('aria-rowcount'));
    const cols = Number(grid?.getAttribute('aria-colcount'));
    return Object.entries(difficulties).find(([, item]) => item.rows === rows && item.cols === cols)?.[0] || 'easy';
  }

  function calculateScore(key, mistakes, elapsedSeconds) {
    const difficulty = difficulties[key] || difficulties.easy;
    const safeMistakes = Math.max(0, Number(mistakes) || 0);
    const safeSeconds = Math.max(0, Number(elapsedSeconds) || 0);
    return Math.max(0,
      difficulty.pairs * scoring.basePerPair -
      safeMistakes * scoring.mistakePenalty -
      safeSeconds * scoring.timePenaltyPerSecond
    );
  }

  function calculatePerformancePercent(key, score) {
    const difficulty = difficulties[key] || difficulties.easy;
    const maximumScore = difficulty.pairs * scoring.basePerPair;
    const safeScore = Math.min(maximumScore, Math.max(0, Number(score) || 0));
    return Math.min(100, Math.max(0, Math.round((safeScore / maximumScore) * 100)));
  }

  function getPerformanceRating(performancePercent) {
    const safePercent = Math.min(100, Math.max(0, Math.round(Number(performancePercent) || 0)));
    return performanceBands.find((band) => safePercent >= band.minimum)?.rating || 'POOR';
  }

  function calculatePerformance(key, mistakes, elapsedSeconds) {
    const difficulty = difficulties[key] || difficulties.easy;
    const score = calculateScore(key, mistakes, elapsedSeconds);
    const performancePercent = calculatePerformancePercent(key, score);
    return Object.freeze({
      score,
      maximumScore: difficulty.pairs * scoring.basePerPair,
      performancePercent,
      rating: getPerformanceRating(performancePercent),
    });
  }

  const runtime = Object.freeze({
    difficulties,
    scoring,
    performanceBands,
    difficultyKeyFromBoard,
    calculateScore,
    calculatePerformancePercent,
    getPerformanceRating,
    calculatePerformance,
  });
  window.DEJA_VU_RUNTIME = runtime;
  window.DEJA_VU_BALANCE = runtime; // compatibility alias for preview/results modules
  window.DEJA_VU_PREVIEW_ACTIVE = false;

  // Timing used to live here as global setTimeout/setInterval overrides keyed
  // on magic delays. Gameplay now schedules explicitly on gameplay-clock.js,
  // which pauses with the game and keeps the memorize preview off the score.
})();
