// Initial DEJA VU memorization phase.
// A fresh board is revealed immediately, then every unmatched card flips face-down
// together before normal tap-to-match gameplay begins. Resumed games skip this phase.

const cardGrid = document.querySelector('#card-grid');
const gameMessage = document.querySelector('#game-message');
const difficultyDialog = document.querySelector('#difficulty-dialog');
const playAgainButton = document.querySelector('#btn-play-again');
const continueButton = document.querySelector('#btn-continue');
const pauseButton = document.querySelector('#btn-pause');
const pauseDialog = document.querySelector('#pause-dialog');

const BALANCE = window.DEJA_VU_RUNTIME || window.DEJA_VU_BALANCE;
const PREVIEW_CONFIG = BALANCE?.difficulties || Object.freeze({
  easy: Object.freeze({ memorizeMs: 4000, rows: 3, cols: 4 }),
  intermediate: Object.freeze({ memorizeMs: 5000, rows: 4, cols: 4 }),
  advanced: Object.freeze({ memorizeMs: 6000, rows: 4, cols: 5 }),
  insane: Object.freeze({ memorizeMs: 8000, rows: 6, cols: 5 }),
});

const FLIP_SETTLE_MS = 480;
let pendingFreshBoard = false;
let pendingDifficulty = '';
let previewToken = 0;
let previewTimer = 0;
let settleTimer = 0;
let countdownTimer = 0;
let previewPhase = 'idle';
let phaseRemainingMs = 0;
let phaseStartedAt = 0;
let previewCards = [];

function clearScheduledPreviewWork() {
  window.clearTimeout(previewTimer);
  window.clearTimeout(settleTimer);
  window.clearInterval(countdownTimer);
  previewTimer = 0;
  settleTimer = 0;
  countdownTimer = 0;
}

function clearPreviewTimers() {
  clearScheduledPreviewWork();
  previewPhase = 'idle';
  phaseRemainingMs = 0;
  phaseStartedAt = 0;
  previewCards = [];
  previewToken += 1;
  window.DEJA_VU_PREVIEW_ACTIVE = false;
}

function setPreviewInteractionLocked(locked) {
  cardGrid.classList.toggle('is-previewing', locked);
  cardGrid.setAttribute('aria-busy', locked ? 'true' : 'false');
  window.DEJA_VU_PREVIEW_ACTIVE = locked;
}

function difficultyFromBoard() {
  return BALANCE?.difficultyKeyFromBoard?.() || (() => {
    const rows = Number(cardGrid.getAttribute('aria-rowcount'));
    const cols = Number(cardGrid.getAttribute('aria-colcount'));
    return Object.entries(PREVIEW_CONFIG).find(([, config]) => config.rows === rows && config.cols === cols)?.[0] || 'easy';
  })();
}

function setMemorizeMessage(millisecondsRemaining) {
  const seconds = Math.max(1, Math.ceil(millisecondsRemaining / 1000));
  gameMessage.textContent = `Memorize the board — ${seconds}`;
  gameMessage.classList.remove('is-error', 'is-success');
  gameMessage.classList.add('is-preview-message');
}

function previewCanRun() {
  return !document.hidden && !pauseDialog?.open;
}

function updateRemainingFromElapsed() {
  if (!phaseStartedAt || phaseRemainingMs <= 0) return;
  phaseRemainingMs = Math.max(0, phaseRemainingMs - (performance.now() - phaseStartedAt));
  phaseStartedAt = 0;
}

function pausePreviewClock() {
  if (!cardGrid.classList.contains('is-previewing') || previewPhase === 'idle') return;
  updateRemainingFromElapsed();
  clearScheduledPreviewWork();
}

function finishPreview(token) {
  if (token !== previewToken) return;
  previewPhase = 'idle';
  phaseRemainingMs = 0;
  phaseStartedAt = 0;
  setPreviewInteractionLocked(false);
  cardGrid.dataset.previewComplete = 'true';
  previewCards.forEach((card) => card.removeAttribute('tabindex'));
  previewCards = [];
  gameMessage.textContent = 'Go! Tap a card to reveal it.';
  gameMessage.classList.remove('is-preview-message');
  cardGrid.querySelector('.memory-card:not(:disabled)')?.focus({ preventScroll: true });
}

function beginSettlePhase(token) {
  if (token !== previewToken) return;
  previewCards.forEach((card) => {
    if (card.classList.contains('is-matched')) return;
    card.classList.remove('is-flipped', 'is-preview-card');
  });
  gameMessage.textContent = 'Cards down… get ready.';
  previewPhase = 'settle';
  phaseRemainingMs = FLIP_SETTLE_MS;
  resumePreviewClock();
}

function resumePreviewClock() {
  if (!cardGrid.classList.contains('is-previewing') || previewPhase === 'idle' || !previewCanRun()) return;
  clearScheduledPreviewWork();
  const token = previewToken;
  phaseStartedAt = performance.now();

  if (previewPhase === 'memorize') {
    setMemorizeMessage(phaseRemainingMs);
    countdownTimer = window.setInterval(() => {
      if (token !== previewToken || previewPhase !== 'memorize') return;
      const remaining = Math.max(0, phaseRemainingMs - (performance.now() - phaseStartedAt));
      if (remaining > 0) setMemorizeMessage(remaining);
    }, 250);

    previewTimer = window.setTimeout(() => {
      if (token !== previewToken || previewPhase !== 'memorize') return;
      clearScheduledPreviewWork();
      phaseRemainingMs = 0;
      phaseStartedAt = 0;
      beginSettlePhase(token);
    }, phaseRemainingMs);
    return;
  }

  settleTimer = window.setTimeout(() => {
    if (token !== previewToken || previewPhase !== 'settle') return;
    clearScheduledPreviewWork();
    finishPreview(token);
  }, phaseRemainingMs);
}

function revealBoardForPreview() {
  const cards = [...cardGrid.querySelectorAll('.memory-card')];
  if (!cards.length) return;

  clearPreviewTimers();
  const token = previewToken;
  const difficultyKey = pendingDifficulty && PREVIEW_CONFIG[pendingDifficulty]
    ? pendingDifficulty
    : difficultyFromBoard();
  const config = PREVIEW_CONFIG[difficultyKey];
  const duration = config.memorizeMs ?? config.durationMs ?? 4000;
  pendingDifficulty = '';
  previewCards = cards;

  cardGrid.dataset.previewComplete = 'false';
  cardGrid.dataset.previewDifficulty = difficultyKey;
  setPreviewInteractionLocked(true);
  cardGrid.classList.add('is-preview-revealing');

  cards.forEach((card) => {
    if (card.classList.contains('is-matched')) return;
    card.classList.remove('is-wrong');
    card.classList.add('is-flipped', 'is-preview-card');
    card.setAttribute('tabindex', '-1');
  });

  previewPhase = 'memorize';
  phaseRemainingMs = duration;
  setMemorizeMessage(duration);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => cardGrid.classList.remove('is-preview-revealing'));
  });

  if (token === previewToken) resumePreviewClock();
}

function markFreshBoardPending(difficultyKey = '') {
  clearPreviewTimers();
  pendingFreshBoard = true;
  pendingDifficulty = PREVIEW_CONFIG[difficultyKey] ? difficultyKey : '';
  cardGrid.dataset.previewComplete = 'false';
}

// Capture these before index.js bubble handlers create/render the next board.
difficultyDialog?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-difficulty]');
  if (button) markFreshBoardPending(button.dataset.difficulty);
}, true);

playAgainButton?.addEventListener('click', () => markFreshBoardPending(difficultyFromBoard()), true);

// Continue resumes an existing board and should never replay the memorization phase.
continueButton?.addEventListener('click', () => {
  clearPreviewTimers();
  pendingFreshBoard = false;
  pendingDifficulty = '';
  cardGrid.classList.remove('is-preview-revealing', 'is-previewing');
  cardGrid.dataset.previewComplete = 'true';
  cardGrid.setAttribute('aria-busy', 'false');
}, true);

// Manual pause/backgrounding freezes the study countdown instead of consuming it.
pauseButton?.addEventListener('click', pausePreviewClock, true);
pauseDialog?.addEventListener('close', () => requestAnimationFrame(resumePreviewClock));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausePreviewClock();
  else requestAnimationFrame(resumePreviewClock);
});

// Block all card activation while the initial board is being memorized or hiding.
cardGrid.addEventListener('click', (event) => {
  if (!cardGrid.classList.contains('is-previewing')) return;
  if (event.target.closest('.memory-card')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

cardGrid.addEventListener('pointerdown', (event) => {
  if (!cardGrid.classList.contains('is-previewing')) return;
  if (event.target.closest('.memory-card')) event.preventDefault();
}, true);

cardGrid.addEventListener('keydown', (event) => {
  if (!cardGrid.classList.contains('is-previewing')) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

const observer = new MutationObserver(() => {
  if (!pendingFreshBoard) return;
  const cards = cardGrid.querySelectorAll('.memory-card');
  if (!cards.length) return;
  pendingFreshBoard = false;
  revealBoardForPreview();
});

observer.observe(cardGrid, { childList: true });
