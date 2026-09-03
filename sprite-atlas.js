// DEJA VU measured sprite-sheet contract.
//
// IMPORTANT: card-flip-sprite-sheet.png is 1233 x 1275 px, but it is NOT a
// uniform 5 x 4 atlas. The upright cards have different row heights/gutters and
// the bottom-row flip frames extend much farther downward than an equal grid
// would predict. Dividing the sheet into equal cells cuts sprites and pulls in
// neighboring frames. Gameplay therefore renders only the measured source
// rectangle for each usable upright card/back.

const rect = (x, y, w, h) => Object.freeze({ x, y, w, h });

export const SPRITE_ATLAS = Object.freeze({
  image: './card-flip-sprite-sheet.png',
  sourceWidth: 1233,
  sourceHeight: 1275,
  columns: 5,
  rows: 4,
  sourcePadding: 4,
  renderWidth: 600,
  renderHeight: 775,
  renderInset: 8,
  back: Object.freeze({
    col: 2,
    row: 3,
    name: 'card back',
    // Measured non-transparent bounds: x 508..726, y 885..1178.
    rect: rect(508, 885, 218, 293),
  }),
  playableFaces: Object.freeze([
    Object.freeze({ col: 0, row: 0, name: 'red circle', rect: rect(18, 14, 222, 278) }),
    Object.freeze({ col: 1, row: 0, name: 'blue square', rect: rect(261, 14, 221, 276) }),
    Object.freeze({ col: 2, row: 0, name: 'green triangle', rect: rect(508, 14, 218, 277) }),
    Object.freeze({ col: 3, row: 0, name: 'purple rectangle', rect: rect(752, 14, 223, 276) }),
    Object.freeze({ col: 4, row: 0, name: 'orange oval', rect: rect(992, 14, 225, 276) }),

    Object.freeze({ col: 0, row: 1, name: 'cyan diamond', rect: rect(17, 309, 224, 269) }),
    Object.freeze({ col: 1, row: 1, name: 'pink pentagon', rect: rect(259, 309, 223, 264) }),
    Object.freeze({ col: 2, row: 1, name: 'yellow hexagon', rect: rect(507, 306, 219, 271) }),
    Object.freeze({ col: 3, row: 1, name: 'teal octagon', rect: rect(752, 306, 223, 271) }),
    Object.freeze({ col: 4, row: 1, name: 'gold star', rect: rect(995, 309, 222, 268) }),

    Object.freeze({ col: 0, row: 2, name: 'purple crescent', rect: rect(17, 590, 223, 272) }),
    Object.freeze({ col: 1, row: 2, name: 'red semicircle', rect: rect(262, 590, 219, 281) }),
    Object.freeze({ col: 2, row: 2, name: 'orange trapezoid', rect: rect(507, 590, 219, 272) }),
    Object.freeze({ col: 3, row: 2, name: 'green parallelogram', rect: rect(752, 590, 225, 272) }),
    Object.freeze({ col: 4, row: 2, name: 'blue kite', rect: rect(995, 590, 224, 272) }),

    Object.freeze({ col: 0, row: 3, name: 'pink cross', rect: rect(18, 885, 222, 294) }),
    Object.freeze({ col: 1, row: 3, name: 'purple spiral', rect: rect(260, 885, 219, 292) }),
  ]),
});

const faceByKey = new Map(
  SPRITE_ATLAS.playableFaces.map((sprite) => [`${sprite.col}:${sprite.row}`, sprite])
);

const atlasImage = new Image();
atlasImage.decoding = 'async';
atlasImage.src = SPRITE_ATLAS.image;
let atlasReady = atlasImage.complete && atlasImage.naturalWidth > 0;
const pendingSides = new Map();

function percentForCell(index, count) {
  return count <= 1 ? 0 : (index / (count - 1)) * 100;
}

function closestCell(value, count) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(count - 1, Math.round((numeric / 100) * (count - 1))));
}

function scaledSourceRect(sprite) {
  const padding = SPRITE_ATLAS.sourcePadding;
  const scaleX = atlasImage.naturalWidth / SPRITE_ATLAS.sourceWidth;
  const scaleY = atlasImage.naturalHeight / SPRITE_ATLAS.sourceHeight;
  const source = sprite.rect;

  const left = Math.max(0, source.x - padding);
  const top = Math.max(0, source.y - padding);
  const right = Math.min(SPRITE_ATLAS.sourceWidth, source.x + source.w + padding);
  const bottom = Math.min(SPRITE_ATLAS.sourceHeight, source.y + source.h + padding);

  const sx = Math.floor(left * scaleX);
  const sy = Math.floor(top * scaleY);
  const ex = Math.ceil(right * scaleX);
  const ey = Math.ceil(bottom * scaleY);

  return {
    sx,
    sy,
    sw: Math.max(1, ex - sx),
    sh: Math.max(1, ey - sy),
  };
}

function canvasForSide(side) {
  let canvas = side.querySelector('.sprite-cell-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'sprite-cell-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    side.append(canvas);
  }
  return canvas;
}

function paintSide(side, sprite) {
  if (!side || !sprite?.rect) return;

  side.dataset.spriteCol = String(sprite.col);
  side.dataset.spriteRow = String(sprite.row);
  side.dataset.spriteName = sprite.name;
  side.style.backgroundImage = 'none';
  side.style.backgroundPosition = '';

  if (!atlasReady) {
    pendingSides.set(side, sprite);
    return;
  }

  const { sx, sy, sw, sh } = scaledSourceRect(sprite);
  const canvas = canvasForSide(side);
  const outputWidth = SPRITE_ATLAS.renderWidth;
  const outputHeight = SPRITE_ATLAS.renderHeight;

  if (canvas.width !== outputWidth) canvas.width = outputWidth;
  if (canvas.height !== outputHeight) canvas.height = outputHeight;

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;

  context.clearRect(0, 0, outputWidth, outputHeight);
  context.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';

  // Contain the COMPLETE measured card rectangle in one fixed card-aspect
  // bitmap. This preserves the source sprite's proportions, keeps its outer
  // shadow/border visible, and never samples the neighboring flip frames.
  const inset = SPRITE_ATLAS.renderInset;
  const availableWidth = outputWidth - inset * 2;
  const availableHeight = outputHeight - inset * 2;
  const scale = Math.min(availableWidth / sw, availableHeight / sh);
  const drawWidth = Math.max(1, Math.round(sw * scale));
  const drawHeight = Math.max(1, Math.round(sh * scale));
  const dx = Math.round((outputWidth - drawWidth) / 2);
  const dy = Math.round((outputHeight - drawHeight) / 2);

  context.drawImage(
    atlasImage,
    sx, sy, sw, sh,
    dx, dy, drawWidth, drawHeight
  );

  side.dataset.spritePainted = `${sprite.col}:${sprite.row}`;
  pendingSides.delete(side);
}

function normalizeFront(front) {
  let col = Number.parseInt(front.dataset.spriteCol, 10);
  let row = Number.parseInt(front.dataset.spriteRow, 10);

  if (!Number.isInteger(col)) col = closestCell(front.style.getPropertyValue('--sprite-x'), SPRITE_ATLAS.columns);
  if (!Number.isInteger(row)) row = closestCell(front.style.getPropertyValue('--sprite-y'), SPRITE_ATLAS.rows);

  let sprite = faceByKey.get(`${col}:${row}`);
  if (!sprite) {
    console.warn('[DEJA VU] Invalid card face cell; falling back to first playable face.', { col, row });
    sprite = SPRITE_ATLAS.playableFaces[0];
  }

  // Preserve compatibility variables for the existing render/debug path. They
  // no longer control the actual crop; measured rectangles above do.
  front.style.setProperty('--sprite-x', `${percentForCell(sprite.col, SPRITE_ATLAS.columns)}%`);
  front.style.setProperty('--sprite-y', `${percentForCell(sprite.row, SPRITE_ATLAS.rows)}%`);
  paintSide(front, sprite);
}

function normalizeCard(card) {
  const front = card.querySelector('.card-side-front');
  const back = card.querySelector('.card-side-back');
  if (front) normalizeFront(front);
  if (back) paintSide(back, SPRITE_ATLAS.back);
}

function validateCards(root = document) {
  root.querySelectorAll?.('.memory-card').forEach(normalizeCard);
}

function paintStaticDemo() {
  const demoBack = document.querySelector('.sprite-demo .sprite-back');
  const demoFace = document.querySelector('.sprite-demo .sprite-symbol');
  if (demoBack) paintSide(demoBack, SPRITE_ATLAS.back);
  if (demoFace) paintSide(demoFace, SPRITE_ATLAS.playableFaces[8]);
}

function flushPendingSides() {
  [...pendingSides.entries()].forEach(([side, sprite]) => {
    if (!side.isConnected) {
      pendingSides.delete(side);
      return;
    }
    paintSide(side, sprite);
  });
}

function validateSourceSheet() {
  if (!atlasReady) return;
  if (
    atlasImage.naturalWidth !== SPRITE_ATLAS.sourceWidth ||
    atlasImage.naturalHeight !== SPRITE_ATLAS.sourceHeight
  ) {
    console.warn(
      `[DEJA VU] Sprite sheet dimensions changed from ${SPRITE_ATLAS.sourceWidth}x${SPRITE_ATLAS.sourceHeight} ` +
      `to ${atlasImage.naturalWidth}x${atlasImage.naturalHeight}. Measured rectangles will be scaled proportionally.`
    );
  }
}

atlasImage.addEventListener('load', () => {
  atlasReady = atlasImage.naturalWidth > 0;
  validateSourceSheet();
  flushPendingSides();
  validateCards();
  paintStaticDemo();
}, { once: true });

atlasImage.addEventListener('error', () => {
  console.error('[DEJA VU] Card sprite sheet failed to load.');
}, { once: true });

function installAtlasStyles() {
  if (document.querySelector('#deja-vu-sprite-atlas-contract')) return;
  const style = document.createElement('style');
  style.id = 'deja-vu-sprite-atlas-contract';
  style.textContent = `
    .memory-card .card-side,
    .sprite-demo .sprite-card {
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

    .sprite-demo .sprite-card {
      position: relative;
    }
  `;
  document.head.append(style);
}

installAtlasStyles();
validateSourceSheet();
validateCards();
paintStaticDemo();

const grid = document.querySelector('#card-grid');
if (grid) {
  new MutationObserver(() => validateCards(grid)).observe(grid, { childList: true, subtree: true });
}

window.DEJA_VU_SPRITE_ATLAS = SPRITE_ATLAS;
