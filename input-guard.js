// Prompt 12: mobile-first input guard for DEJA VU.
// Keeps touch, mouse, and keyboard on the native button click path while
// filtering duplicate pointer-originated clicks and preventing drag/select noise.

const cardGrid = document.querySelector('#card-grid');

const DUPLICATE_CLICK_WINDOW_MS = 350;
let lastPointerCard = null;
let lastPointerUpAt = 0;

function cardFromEvent(event) {
  return event.target.closest?.('.memory-card') || null;
}

cardGrid.addEventListener('pointerdown', (event) => {
  const card = cardFromEvent(event);
  if (!card || card.disabled || cardGrid.classList.contains('is-previewing')) return;
  if (event.pointerType === 'touch' || event.pointerType === 'pen') {
    card.dataset.pointerActive = 'true';
  }
}, true);

cardGrid.addEventListener('pointerup', (event) => {
  const card = cardFromEvent(event);
  if (!card) return;
  delete card.dataset.pointerActive;
  if (event.pointerType === 'touch' || event.pointerType === 'pen') {
    lastPointerCard = card;
    lastPointerUpAt = performance.now();
  }
}, true);

cardGrid.addEventListener('pointercancel', (event) => {
  const card = cardFromEvent(event);
  if (card) delete card.dataset.pointerActive;
}, true);

// Native button activation remains authoritative. Suppress only a second
// pointer-generated click on the same card inside the short ghost-click window.
cardGrid.addEventListener('click', (event) => {
  const card = cardFromEvent(event);
  if (!card) return;

  // Keyboard-triggered button clicks have detail === 0 and must always pass.
  if (event.detail === 0) return;

  const now = performance.now();
  if (card === lastPointerCard && now - lastPointerUpAt < DUPLICATE_CLICK_WINDOW_MS) {
    if (card.dataset.clickAccepted === 'true') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    card.dataset.clickAccepted = 'true';
    window.setTimeout(() => {
      delete card.dataset.clickAccepted;
      if (lastPointerCard === card) lastPointerCard = null;
    }, DUPLICATE_CLICK_WINDOW_MS);
  }
}, true);

// Cards are controls, not draggable content.
cardGrid.addEventListener('dragstart', (event) => {
  if (cardFromEvent(event)) event.preventDefault();
});

cardGrid.addEventListener('selectstart', (event) => {
  if (cardFromEvent(event)) event.preventDefault();
});
