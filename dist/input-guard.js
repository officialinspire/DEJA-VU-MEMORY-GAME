// DEJA VU input hardening.
// Native button click is the single authoritative activation path for touch,
// mouse, pen, and keyboard. The core game state machine already rejects the
// same open card, matched cards, locked turns, and third-card input, so no
// pointer/click deduplication layer is necessary here.

const cardGrid = document.querySelector('#card-grid');

function cardFromEvent(event) {
  return event.target.closest?.('.memory-card') || null;
}

// Cards are controls, not draggable/selectable content. These guards do not
// participate in activation and therefore cannot delay or swallow a tap.
cardGrid?.addEventListener('dragstart', (event) => {
  if (cardFromEvent(event)) event.preventDefault();
});

cardGrid?.addEventListener('selectstart', (event) => {
  if (cardFromEvent(event)) event.preventDefault();
});
