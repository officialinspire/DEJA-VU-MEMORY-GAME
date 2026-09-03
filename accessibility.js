// Prompt 13: accessibility and focus management for DEJA VU.
// Enhances the existing native-button/keyboard path without duplicating gameplay logic.

const cardGrid = document.querySelector('#card-grid');
const gameMessage = document.querySelector('#game-message');
const pauseDialog = document.querySelector('#pause-dialog');
const completeDialog = document.querySelector('#complete-dialog');
const pauseButton = document.querySelector('#btn-pause');

let preferredFocusIndex = 0;
let pauseReturnTarget = null;
let pairBusy = false;

function setAttrIfChanged(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function cards() {
  return [...cardGrid.querySelectorAll('.memory-card')];
}

function playableCards() {
  return cards().filter((card) => !card.disabled && !card.classList.contains('is-matched'));
}

function cardIndex(card) {
  return Number(card?.dataset.index ?? -1);
}

function setRovingFocus(preferredIndex = preferredFocusIndex) {
  const available = playableCards();
  if (!available.length) return;

  const preferred = available.find((card) => cardIndex(card) === preferredIndex) ||
    available.find((card) => cardIndex(card) > preferredIndex) ||
    available[0];

  preferredFocusIndex = cardIndex(preferred);
  available.forEach((card) => setAttrIfChanged(card, 'tabindex', card === preferred ? '0' : '-1'));
  cards().filter((card) => card.disabled || card.classList.contains('is-matched'))
    .forEach((card) => setAttrIfChanged(card, 'tabindex', '-1'));
}

function normalizeCardAccessibility() {
  const previewing = cardGrid.classList.contains('is-previewing');

  cards().forEach((card) => {
    const index = cardIndex(card);
    const matched = card.classList.contains('is-matched') || card.disabled;
    const revealed = card.classList.contains('is-flipped') && !matched;

    setAttrIfChanged(card, 'aria-disabled', matched ? 'true' : 'false');

    if (previewing) {
      // Do not expose memorized face identities to assistive technology during
      // the visual-only study phase.
      setAttrIfChanged(card, 'aria-label', `Memory card ${index + 1}`);
      setAttrIfChanged(card, 'aria-pressed', 'false');
      setAttrIfChanged(card, 'tabindex', '-1');
      return;
    }

    if (matched) {
      setAttrIfChanged(card, 'aria-pressed', 'true');
      setAttrIfChanged(card, 'tabindex', '-1');
      return;
    }

    if (!revealed) {
      setAttrIfChanged(card, 'aria-label', `Hidden card ${index + 1}`);
      setAttrIfChanged(card, 'aria-pressed', 'false');
    }
  });

  if (!previewing) setRovingFocus();
}

function updatePairBusyState() {
  if (cardGrid.classList.contains('is-previewing')) {
    setAttrIfChanged(cardGrid, 'aria-busy', 'true');
    return;
  }

  const revealedUnmatched = cards().filter((card) =>
    card.classList.contains('is-flipped') &&
    !card.classList.contains('is-matched') &&
    !card.disabled
  );
  const shouldBeBusy = revealedUnmatched.length >= 2;

  if (shouldBeBusy !== pairBusy) pairBusy = shouldBeBusy;
  setAttrIfChanged(cardGrid, 'aria-busy', shouldBeBusy ? 'true' : 'false');
}

function refreshAccessibility() {
  normalizeCardAccessibility();
  updatePairBusyState();
}

setAttrIfChanged(cardGrid, 'aria-describedby', 'game-message');
setAttrIfChanged(gameMessage, 'aria-atomic', 'true');

cardGrid.addEventListener('focusin', (event) => {
  const card = event.target.closest?.('.memory-card');
  if (!card || card.disabled) return;
  preferredFocusIndex = cardIndex(card);
  setRovingFocus(preferredFocusIndex);
});

// Native buttons already activate with Enter/Space. This only prevents the
// grid-navigation handler from running while the preview is locked.
cardGrid.addEventListener('keydown', (event) => {
  if (!cardGrid.classList.contains('is-previewing')) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

pauseButton?.addEventListener('click', () => {
  pauseReturnTarget = document.activeElement?.closest?.('.memory-card') || null;
}, true);

pauseDialog?.addEventListener('close', () => {
  requestAnimationFrame(() => {
    if (pauseReturnTarget && document.contains(pauseReturnTarget) && !pauseReturnTarget.disabled) {
      preferredFocusIndex = cardIndex(pauseReturnTarget);
      setRovingFocus(preferredFocusIndex);
      pauseReturnTarget.focus({ preventScroll: true });
    } else {
      const next = playableCards()[0];
      next?.focus({ preventScroll: true });
    }
    pauseReturnTarget = null;
  });
});

completeDialog?.addEventListener('close', () => {
  pauseReturnTarget = null;
});

const observer = new MutationObserver(refreshAccessibility);
observer.observe(cardGrid, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'disabled', 'aria-label', 'aria-pressed'],
});

refreshAccessibility();
