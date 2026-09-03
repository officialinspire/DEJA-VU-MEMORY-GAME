// DEJA VU sprite atlas contract.
// card-flip-sprite-sheet.png is a 5-column x 4-row atlas. Gameplay uses 17
// face cells and the shared card back is cell (2, 3).
//
// Card surfaces intentionally overscan the atlas by a few CSS pixels. Exact
// 500% x 400% scaling can expose sub-pixel seams from an adjacent row/column
// when the card lands on fractional device pixels (especially on mobile/high
// DPI screens). The tiny overscan crops less than one source pixel from the
// selected cell edge and prevents neighboring sprites from bleeding through.

export const SPRITE_ATLAS = Object.freeze({
  image: './card-flip-sprite-sheet.png',
  columns: 5,
  rows: 4,
  bleedGuardPx: 4,
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

function percentString(index, count) {
  const value = percentForCell(index, count);
  if (value === 0 || value === 100) return `${value}%`;
  return `${Number(value.toFixed(8))}%`;
}

function closestCell(value, count) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  const index = Math.round((numeric / 100) * (count - 1));
  return Math.max(0, Math.min(count - 1, index));
}

function setFrontCell(front, col, row) {
  const x = percentString(col, SPRITE_ATLAS.columns);
  const y = percentString(row, SPRITE_ATLAS.rows);
  front.dataset.spriteCol = String(col);
  front.dataset.spriteRow = String(row);
  front.style.setProperty('--sprite-x', x);
  front.style.setProperty('--sprite-y', y);
  // Inline background-position is authoritative for the selected atlas cell and
  // avoids later theme/card styles accidentally changing the crop.
  front.style.backgroundPosition = `${x} ${y}`;
}

function normalizeFront(front) {
  const storedCol = Number.parseInt(front.dataset.spriteCol, 10);
  const storedRow = Number.parseInt(front.dataset.spriteRow, 10);
  let col = Number.isInteger(storedCol) ? storedCol : closestCell(front.style.getPropertyValue('--sprite-x'), SPRITE_ATLAS.columns);
  let row = Number.isInteger(storedRow) ? storedRow : closestCell(front.style.getPropertyValue('--sprite-y'), SPRITE_ATLAS.rows);

  if (col === null || row === null || !faceKeys.has(`${col}:${row}`)) {
    console.warn('[DEJA VU] Invalid sprite face coordinate; falling back to first playable face.', { col, row });
    col = 0;
    row = 0;
  }
  setFrontCell(front, col, row);
}

function validateCards(root = document) {
  root.querySelectorAll?.('.card-side-front').forEach(normalizeFront);
}

function installAtlasStyles() {
  if (document.querySelector('#deja-vu-sprite-atlas-contract')) return;
  const style = document.createElement('style');
  style.id = 'deja-vu-sprite-atlas-contract';
  const backX = percentString(SPRITE_ATLAS.back.col, SPRITE_ATLAS.columns);
  const backY = percentString(SPRITE_ATLAS.back.row, SPRITE_ATLAS.rows);
  const width = SPRITE_ATLAS.columns * 100;
  const height = SPRITE_ATLAS.rows * 100;
  const guard = SPRITE_ATLAS.bleedGuardPx;

  style.textContent = `
    :root {
      --sprite-atlas-columns: ${SPRITE_ATLAS.columns};
      --sprite-atlas-rows: ${SPRITE_ATLAS.rows};
      --sprite-back-x: ${backX};
      --sprite-back-y: ${backY};
      --sprite-bleed-guard: ${guard}px;
    }

    .card-side {
      overflow: hidden;
      background-image: url('${SPRITE_ATLAS.image}');
      background-repeat: no-repeat !important;
      background-size: calc(${width}% + var(--sprite-bleed-guard)) calc(${height}% + var(--sprite-bleed-guard)) !important;
      background-origin: border-box;
      background-clip: border-box;
    }

    .card-side-back {
      background-position: var(--sprite-back-x) var(--sprite-back-y) !important;
    }

    /* Non-gameplay sprite previews can keep exact atlas sizing because they are
       larger/static and do not exhibit the fractional-card seam problem. */
    .sprite-card,
    .menu-pattern span {
      background-size: ${width}% ${height}%;
      background-repeat: no-repeat;
    }

    .sprite-back,
    .menu-pattern span {
      background-position: var(--sprite-back-x) var(--sprite-back-y);
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
