// Prompt 14: centralized difficulty and scoring balance for DEJA VU.
// Mandatory memorize time is excluded from gameplay time by preview-timer-gate.js.
(function installBalanceConfig() {
  if (window.DEJA_VU_BALANCE) return;

  const difficulties = Object.freeze({
    easy: Object.freeze({ label: 'Easy', rows: 3, cols: 4, pairs: 6, memorizeMs: 4000, mismatchStudyMs: 1050 }),
    intermediate: Object.freeze({ label: 'Intermediate', rows: 4, cols: 4, pairs: 8, memorizeMs: 5000, mismatchStudyMs: 950 }),
    advanced: Object.freeze({ label: 'Advanced', rows: 4, cols: 5, pairs: 10, memorizeMs: 6000, mismatchStudyMs: 850 }),
    insane: Object.freeze({ label: 'Insane', rows: 6, cols: 5, pairs: 15, memorizeMs: 8000, mismatchStudyMs: 750 }),
  });

  // Score = (pairs × basePerPair) − (mistakes × mistakePenalty) − (gameplaySeconds × timePenaltyPerSecond).
  // The required memorize countdown is not gameplay time and is therefore never charged here.
  const scoring = Object.freeze({
    basePerPair: 1000,
    mistakePenalty: 350,
    timePenaltyPerSecond: 5,
  });

  window.DEJA_VU_BALANCE = Object.freeze({ difficulties, scoring });

  function difficultyKeyFromBoard() {
    const rows = Number(document.querySelector('#card-grid')?.getAttribute('aria-rowcount'));
    const cols = Number(document.querySelector('#card-grid')?.getAttribute('aria-colcount'));
    return Object.entries(difficulties).find(([, item]) => item.rows === rows && item.cols === cols)?.[0] || 'easy';
  }

  // index.js currently schedules mismatch study with its legacy 920ms constant.
  // Route that one gameplay delay through the balance table without changing turn/session guards.
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function balancedSetTimeout(callback, delay, ...args) {
    if (Number(delay) === 920 && typeof callback === 'function' && document.querySelector('#screen-game')?.classList.contains('is-active')) {
      const balancedDelay = difficulties[difficultyKeyFromBoard()].mismatchStudyMs;
      return nativeSetTimeout(callback, balancedDelay, ...args);
    }
    return nativeSetTimeout(callback, delay, ...args);
  };

  function calculateScore(key, mistakes, elapsedSeconds) {
    const difficulty = difficulties[key] || difficulties.easy;
    return Math.max(0,
      difficulty.pairs * scoring.basePerPair -
      mistakes * scoring.mistakePenalty -
      elapsedSeconds * scoring.timePenaltyPerSecond
    );
  }

  window.DEJA_VU_BALANCE.calculateScore = calculateScore;

  // Keep completion/stat presentation explicitly tied to the centralized formula.
  const completeScore = document.querySelector('#complete-score');
  if (completeScore) {
    const observer = new MutationObserver(() => {
      const key = difficultyKeyFromBoard();
      const mistakes = Number(document.querySelector('#stat-mistakes')?.textContent || 0);
      const timeText = document.querySelector('#stat-time')?.textContent || '00:00';
      const [minutes, seconds] = timeText.split(':').map(Number);
      const elapsed = Math.max(0, (minutes || 0) * 60 + (seconds || 0));
      const score = calculateScore(key, Math.max(0, mistakes || 0), elapsed);
      const formatted = score.toLocaleString();
      if (completeScore.textContent !== formatted) completeScore.textContent = formatted;
    });
    observer.observe(completeScore, { childList: true, characterData: true, subtree: true });
  }

  const helpCopy = document.querySelector('#screen-help .help-copy');
  if (helpCopy && !document.querySelector('#score-explainer')) {
    const note = document.createElement('p');
    note.id = 'score-explainer';
    note.innerHTML = '<strong>Scoring:</strong> each pair is worth 1,000 points, minus 350 per mistake and 5 per gameplay second. Memorization time does not reduce your score.';
    helpCopy.append(note);
  }
})();
