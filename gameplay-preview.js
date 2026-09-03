// Initial DEJA VU memorization phase.
// A fresh board is revealed immediately, then every unmatched card flips face-down
// together before normal tap-to-match gameplay begins. Resumed games skip this phase.

const cardGrid = document.querySelector('#card-grid');
const gameMessage = document.querySelector('#game-message');
const difficultyDialog = document.querySelector('#difficulty-dialog');
const playAgainButton = document.querySelector('#btn-play-again');
const continueButton = document.querySelector('#btn-continue');

const PREVIEW_MS = Object.freeze({
  12: 3200,
  16: 4000,
  20: 4800,
  30: 6200,
});

const FLIP_SETTLE_MS = 480;
let pendingFreshBoard = false;
let previewToken = 0;
let previewTimer = 0;
let settleTimer = 0;

function clearPreviewTimers() {
  window.clearTimeout(previewTimer);
  window.clearTimeout(settleTimer);
  previewTimer = 0;
  settleTimer = 0;
  previewToken += 1;
  window.DEJA_VU_PREVIEW_ACTIVE = false;
}

function setPreviewInteractionLocked(locked) {
  cardGrid.classList.toggle('is-previewing', locked);
  cardGrid.setAttribute('aria-busy', locked ? 'true' : 'false');
  window.DEJA_VU_PREVIEW_ACTIVE = locked;
}

function revealBoardForPreview() {
  const cards = [...cardGrid.querySelectorAll('.memory-card')];
  if (!cards.length) return;

  clearPreviewTimers();
  const token = previewToken;
  const duration = PREVIEW_MS[cards.length] || 4200;

  cardGrid.dataset.previewComplete = 'false';
  setPreviewInteractionLocked(true);
  cardGrid.classList.add('is-preview-revealing');

  cards.forEach((card) => {
    if (card.classList.contains('is-matched')) return;
    card.classList.remove('is-wrong');
    card.classList.add('is-flipped', 'is-preview-card');
    card.setAttribute('tabindex', '-1');
  });

  gameMessage.textContent = `Memorize the board — ${Math.ceil(duration / 1000)} seconds.`;
  gameMessage.classList.remove('is-error');
  gameMessage.classList.add('is-preview-message');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => cardGrid.classList.remove('is-preview-revealing'));
  });

  previewTimer = window.setTimeout(() => {
    if (token !== previewToken) return;

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

function markFreshBoardPending() {
  clearPreviewTimers();
  pendingFreshBoard = true;
  cardGrid.dataset.previewComplete = 'false';
}

// Capture these before index.js bubble handlers create/render the next board.
difficultyDialog?.addEventListener('click', (event) => {
  if (event.target.closest('[data-difficulty]')) markFreshBoardPending();
}, true);

playAgainButton?.addEventListener('click', markFreshBoardPending, true);

// Continue resumes an existing board and should never replay the memorization phase.
continueButton?.addEventListener('click', () => {
  clearPreviewTimers();
  pendingFreshBoard = false;
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
