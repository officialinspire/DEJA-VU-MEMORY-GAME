// DEJA VU sprite atlas contract.
// The source sheet is a 5-column x 4-row atlas. Gameplay cards are painted
// from exact source-pixel rectangles into canvases so neighboring sprites can
// never bleed into one another through CSS percentage/sub-pixel rounding.

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
const atlasImage = new Image();
atlasImage.decoding = 'async';
atlasImage.src = SPRITE_ATLAS.image;
let atlasReady = atlasImage.complete && atlasImage.naturalWidth > 0;
const pendingSides = new Set();

function percentForCell(index, count) {
  return count <= 1 ? 0 : (index / (count - 1)) * 100;
}

function closestCell(value, count) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(count - 1, Math.round((numeric / 100) * (count - 1))));
}

function sourceRect(col, row) {
  const x0 = Math.round((col * atlasImage.naturalWidth) / SPRITE_ATLAS.columns);
  const x1 = Math.round(((col + 1) * atlasImage.naturalWidth) / SPRITE_ATLAS.columns);
  const y0 = Math.round((row * atlasImage.naturalHeight) / SPRITE_ATLAS.rows);
  const y1 = Math.round(((row + 1) * atlasImage.naturalHeight) / SPRITE_ATLAS.rows);
  return { sx: x0, sy: y0, sw: Math.max(1, x1 - x0), sh: Math.max(1, y1 - y0) };
}

function canvasForSide(side) {
  let canvas = side.querySelector(':scope > .sprite-cell-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'sprite-cell-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    side.append(canvas);
  }
  return canvas;
}

function paintSide(side, col, row) {
  if (!side) return;
  side.dataset.spriteCol = String(col);
  side.dataset.spriteRow = String(row);
  side.style.backgroundImage = 'none';
  side.style.backgroundPosition = '';

  if (!atlasReady) {
    pendingSides.add(side);
    return;
  }

  const { sx, sy, sw, sh } = sourceRect(col, row);
  const canvas = canvasForSide(side);
  if (canvas.width !== sw) canvas.width = sw;
  if (canvas.height !== sh) canvas.height = sh;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;
  context.clearRect(0, 0, sw, sh);
  context.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';
  context.drawImage(atlasImage, sx, sy, sw, sh, 0, 0, sw, sh);
  side.dataset.spritePainted = `${col}:${row}`;
  pendingSides.delete(side);
}

function normalizeFront(front) {
  let col = Number.parseInt(front.dataset.spriteCol, 10);
  let row = Number.parseInt(front.dataset.spriteRow, 10);

  if (!Number.isInteger(col)) col = closestCell(front.style.getPropertyValue('--sprite-x'), SPRITE_ATLAS.columns);
  if (!Number.isInteger(row)) row = closestCell(front.style.getPropertyValue('--sprite-y'), SPRITE_ATLAS.rows);

  if (col === null || row === null || !faceKeys.has(`${col}:${row}`)) {
    console.warn('[DEJA VU] Invalid card sprite cell; falling back to first playable face.', { col, row });
    col = 0;
    row = 0;
  }

  // Preserve compatibility variables for debugging/legacy helpers, but actual
  // gameplay rendering comes from the exact source-pixel canvas crop above.
  front.style.setProperty('--sprite-x', `${percentForCell(col, SPRITE_ATLAS.columns)}%`);
  front.style.setProperty('--sprite-y', `${percentForCell(row, SPRITE_ATLAS.rows)}%`);
  paintSide(front, col, row);
}

function normalizeCard(card) {
  const front = card.querySelector('.card-side-front');
  const back = card.querySelector('.card-side-back');
  if (front) normalizeFront(front);
  if (back) paintSide(back, SPRITE_ATLAS.back.col, SPRITE_ATLAS.back.row);
}

function validateCards(root = document) {
  root.querySelectorAll?.('.memory-card').forEach(normalizeCard);
}

function flushPendingSides() {
  [...pendingSides].forEach((side) => {
    if (!side.isConnected) {
      pendingSides.delete(side);
      return;
    }
    const col = Number.parseInt(side.dataset.spriteCol, 10);
    const row = Number.parseInt(side.dataset.spriteRow, 10);
    if (Number.isInteger(col) && Number.isInteger(row)) paintSide(side, col, row);
  });
}

atlasImage.addEventListener('load', () => {
  atlasReady = atlasImage.naturalWidth > 0;
  flushPendingSides();
  validateCards();
}, { once: true });

atlasImage.addEventListener('error', () => {
  console.error('[DEJA VU] Card sprite sheet failed to load.');
}, { once: true });

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

    .memory-card .card-side {
      overflow: hidden;
      background-image: none !important;
      background-color: transparent;
    }

    .sprite-cell-canvas {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      max-width: none;
      border-radius: inherit;
      pointer-events: none;
    }

    /* Static help/demo sprites can continue using the atlas as CSS because
       they never animate or scale through the gameplay card compositor. */
    .sprite-card,
    .menu-pattern span {
      background-image: url('${SPRITE_ATLAS.image}');
      background-size: ${SPRITE_ATLAS.columns * 100}% ${SPRITE_ATLAS.rows * 100}%;
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
