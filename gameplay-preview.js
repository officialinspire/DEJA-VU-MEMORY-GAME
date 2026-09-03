// Initial DEJA VU memorization phase.
// A fresh board is revealed immediately, then every unmatched card flips face-down
// together before normal tap-to-match gameplay begins. Resumed games skip this phase.

const cardGrid = document.querySelector('#card-grid');
const gameMessage = document.querySelector('#game-message');
const difficultyDialog = document.querySelector('#difficulty-dialog');
const playAgainButton = document.querySelector('#btn-play-again');
const continueButton = document.querySelector('#btn-continue');

// Prompt 11: one authoritative configuration for the required study phase.
const PREVIEW_CONFIG = Object.freeze({
  easy: Object.freeze({ durationMs: 4000, rows: 3, cols: 4 }),
  intermediate: Object.freeze({ durationMs: 5000, rows: 4, cols: 4 }),
  advanced: Object.freeze({ durationMs: 6000, rows: 4, cols: 5 }),
  insane: Object.freeze({ durationMs: 8000, rows: 6, cols: 5 }),
});

const FLIP_SETTLE_MS = 480;
let pendingFreshBoard = false;
let pendingDifficulty = '';
let previewToken = 0;
let previewTimer = 0;
let settleTimer = 0;
let countdownTimer = 0;

function clearPreviewTimers() {
  window.clearTimeout(previewTimer);
  window.clearTimeout(settleTimer);
  window.clearInterval(countdownTimer);
  previewTimer = 0;
  settleTimer = 0;
  countdownTimer = 0;
  previewToken += 1;
  window.DEJA_VU_PREVIEW_ACTIVE = false;
}

function setPreviewInteractionLocked(locked) {
  cardGrid.classList.toggle('is-previewing', locked);
  cardGrid.setAttribute('aria-busy', locked ? 'true' : 'false');
  window.DEJA_VU_PREVIEW_ACTIVE = locked;
}

function difficultyFromBoard() {
  const rows = Number(cardGrid.getAttribute('aria-rowcount'));
  const cols = Number(cardGrid.getAttribute('aria-colcount'));
  return Object.entries(PREVIEW_CONFIG).find(([, config]) => config.rows === rows && config.cols === cols)?.[0] || 'easy';
}

function setMemorizeMessage(secondsRemaining) {
  const seconds = Math.max(1, Math.ceil(secondsRemaining));
  gameMessage.textContent = `Memorize the board — ${seconds}`;
  gameMessage.classList.remove('is-error', 'is-success');
  gameMessage.classList.add('is-preview-message');
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
  const duration = config.durationMs;
  pendingDifficulty = '';

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

  const previewStartedAt = performance.now();
  setMemorizeMessage(duration / 1000);

  countdownTimer = window.setInterval(() => {
    if (token !== previewToken) return;
    const remainingMs = Math.max(0, duration - (performance.now() - previewStartedAt));
    if (remainingMs <= 0) {
      window.clearInterval(countdownTimer);
      countdownTimer = 0;
      return;
    }
    setMemorizeMessage(remainingMs / 1000);
  }, 250);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => cardGrid.classList.remove('is-preview-revealing'));
  });

  previewTimer = window.setTimeout(() => {
    if (token !== previewToken) return;
    window.clearInterval(countdownTimer);
    countdownTimer = 0;

    cards.forEach((card) => {
      if (card.classList.contains('is-matched')) return;
      card.classList.remove('is-flipped', 'is-preview-card');
    });

    gameMessage.textContent = 'Cards down… get ready.';

    settleTimer = window.setTimeout(() => {
      if (token !== previewToken) return;

      setPreviewInteractionLocked(false);
      cardGrid.dataset.previewComplete = 'true';
      cards.forEach((card) => card.removeAttribute('tabindex'));
      gameMessage.textContent = 'Go! Tap a card to reveal it.';
      gameMessage.classList.remove('is-preview-message');
      cardGrid.querySelector('.memory-card:not(:disabled)')?.focus({ preventScroll: true });
    }, FLIP_SETTLE_MS);
  }, duration);
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
  cardGrid.classList.remove('is-preview-revealing');
  cardGrid.dataset.previewComplete = 'true';
}, true);

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
  if (['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

const observer = new MutationObserver(() => {
  if (!pendingFreshBoard) return;
  const cards = cardGrid.querySelectorAll('.memory-card');
  if (!cards.length) return;
  pendingFreshBoard = false;
  // MutationObserver callbacks run before paint, so the first visible frame of
  // a new game is already the face-up memorization board.
  revealBoardForPreview();
});

observer.observe(cardGrid, { childList: true });
