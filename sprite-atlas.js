// DEJA VU sprite atlas contract.
// card-flip-sprite-sheet.png is treated as a 5-column x 4-row atlas.
// Gameplay currently uses 17 face cells. The shared card back is cell (2, 3).

export const SPRITE_ATLAS = Object.freeze({
  image: './card-flip-sprite-sheet.png',
  columns: 5,
  rows: 4,
  back: Object.freeze({ col: 2, row: 3 }),
  playableFaces: Object.freeze([
    Object.freeze({ col: 0, row: 0, name: 'red circle' }),
    Object.freeze({ col: 1, row: 0, name: 'blue square' }),
    Object.freeze({ col: 2, row: 0, name: 'green triangle' }),
    Object.freeze({ col: 3, row: 0, name: 'purple rectangle' }),
    Object.freeze({ col: 4, row: 0, name: 'orange oval' }),
    Object.freeze({ col: 0, row: 1, name: 'cyan diamond' }),
    Object.freeze({ col: 1, row: 1, name: 'pink pentagon' }),
    Object.freeze({ col: 2, row: 1, name: 'yellow hexagon' }),
    Object.freeze({ col: 3, row: 1, name: 'teal octagon' }),
    Object.freeze({ col: 4, row: 1, name: 'gold star' }),
    Object.freeze({ col: 0, row: 2, name: 'purple crescent' }),
    Object.freeze({ col: 1, row: 2, name: 'red semicircle' }),
    Object.freeze({ col: 2, row: 2, name: 'orange trapezoid' }),
    Object.freeze({ col: 3, row: 2, name: 'green parallelogram' }),
    Object.freeze({ col: 4, row: 2, name: 'blue kite' }),
    Object.freeze({ col: 0, row: 3, name: 'pink cross' }),
    Object.freeze({ col: 1, row: 3, name: 'purple spiral' }),
  ]),
});

const faceKeys = new Set(SPRITE_ATLAS.playableFaces.map(({ col, row }) => `${col}:${row}`));

function percentForCell(index, count) {
  return count <= 1 ? 0 : (index / (count - 1)) * 100;
}

function closestCell(value, count) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  const index = Math.round((numeric / 100) * (count - 1));
  return Math.max(0, Math.min(count - 1, index));
}

function normalizeFront(front) {
  const col = closestCell(front.style.getPropertyValue('--sprite-x'), SPRITE_ATLAS.columns);
  const row = closestCell(front.style.getPropertyValue('--sprite-y'), SPRITE_ATLAS.rows);
  if (col === null || row === null || !faceKeys.has(`${col}:${row}`)) {
    console.warn('[DEJA VU] Invalid sprite face coordinate; falling back to first playable face.', { col, row });
    front.style.setProperty('--sprite-x', '0%');
    front.style.setProperty('--sprite-y', '0%');
    return;
  }
  front.style.setProperty('--sprite-x', `${percentForCell(col, SPRITE_ATLAS.columns)}%`);
  front.style.setProperty('--sprite-y', `${percentForCell(row, SPRITE_ATLAS.rows)}%`);
}

function validateCards(root = document) {
  root.querySelectorAll?.('.card-side-front').forEach(normalizeFront);
}

function installAtlasStyles() {
  if (document.querySelector('#deja-vu-sprite-atlas-contract')) return;
  const style = document.createElement('style');
  style.id = 'deja-vu-sprite-atlas-contract';
  const backX = percentForCell(SPRITE_ATLAS.back.col, SPRITE_ATLAS.columns);
  const backY = percentForCell(SPRITE_ATLAS.back.row, SPRITE_ATLAS.rows);
  style.textContent = `
    :root {
      --sprite-atlas-columns: ${SPRITE_ATLAS.columns};
      --sprite-atlas-rows: ${SPRITE_ATLAS.rows};
      --sprite-back-x: ${backX}%;
      --sprite-back-y: ${backY}%;
    }
    .card-side,
    .sprite-card,
    .menu-pattern span {
      background-size: ${SPRITE_ATLAS.columns * 100}% ${SPRITE_ATLAS.rows * 100}%;
      background-repeat: no-repeat;
    }
    .card-side-back,
    .sprite-back,
    .menu-pattern span {
      background-position: var(--sprite-back-x) var(--sprite-back-y);
    }
    .card-side {
      overflow: hidden;
      background-clip: padding-box;
    }
  `;
  document.head.append(style);
}

installAtlasStyles();
validateCards();

const grid = document.querySelector('#card-grid');
if (grid) {
  new MutationObserver(() => validateCards(grid)).observe(grid, { childList: true, subtree: true });
}

window.DEJA_VU_SPRITE_ATLAS = SPRITE_ATLAS;
