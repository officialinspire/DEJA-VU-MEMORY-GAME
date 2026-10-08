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
  // Reference card bitmap. The inset gutter and contain-fit are defined in this
  // 600 x 775 space and scaled to each card's real pixel size, so every size
  // keeps the same proportions. It is also the largest bitmap a side ever gets.
  renderWidth: 600,
  renderHeight: 775,
  renderInset: 8,
  // Sides render at CSS size x devicePixelRatio, capped here: beyond 3x the
  // bitmap outgrows the ~226 px source sprites without adding detail.
  maxPixelRatio: 3,
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

const CANVAS_CLASS = 'sprite-cell-canvas';
// A resized card keeps its current bitmap (the browser scales it) until the
// size stops changing, so dragging a window edge does not repaint every frame.
const RESIZE_SETTLE_MS = 150;
// Sized crops are shared by every side showing the same sprite at the same
// pixel size. One board needs at most 16 (15 faces + the back); the bounds
// leave room for all four board sizes and the help demo at 3x.
const CROP_CACHE_MAX_ENTRIES = 64;
const CROP_CACHE_MAX_BYTES = 16 * 1024 * 1024;

const faceByKey = new Map(
  SPRITE_ATLAS.playableFaces.map((sprite) => [`${sprite.col}:${sprite.row}`, sprite])
);

// The sheet is loaded and decoded once for the whole app. Gameplay waits on
// cardArt (see whenCardArtReady) rather than starting a board it cannot draw.
let atlasImage = null;
let atlasReady = false;
const cardArt = { state: 'loading', attempt: 0, promise: null, image: null };

// side -> { sprite, canvas, cssWidth, cssHeight, painted }. Holds every side
// that is waiting for the atlas, waiting for a size, or painted; entries leave
// as soon as their side is detached, so a replaced board is never retained.
const trackedSides = new Map();
const cropCache = new Map();
let cropCacheBytes = 0;
const resizedSides = new Set();
let resizeTimer = 0;

const grid = document.querySelector('#card-grid');
const gridObserver = grid ? new MutationObserver(onGridMutations) : null;
const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onSideResize) : null;

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

// Device pixels for a side of this CSS size: capped DPR, and never larger than
// the reference bitmap.
function outputSize(cssWidth, cssHeight) {
  const ratio = Math.min(window.devicePixelRatio || 1, SPRITE_ATLAS.maxPixelRatio);
  const scale = Math.min(ratio, SPRITE_ATLAS.renderWidth / cssWidth, SPRITE_ATLAS.renderHeight / cssHeight);
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}

function drawSprite(context, sprite, width, height) {
  const { sx, sy, sw, sh } = scaledSourceRect(sprite);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';

  // Contain the COMPLETE measured card rectangle in one card-aspect bitmap.
  // This preserves the source sprite's proportions, keeps its outer
  // shadow/border visible, and never samples the neighboring flip frames.
  // The layout is the one the fixed reference bitmap has always used, mapped
  // onto this bitmap without re-rounding, so the card sits exactly where the
  // browser used to show it.
  const inset = SPRITE_ATLAS.renderInset;
  const referenceWidth = SPRITE_ATLAS.renderWidth;
  const referenceHeight = SPRITE_ATLAS.renderHeight;
  const scale = Math.min((referenceWidth - inset * 2) / sw, (referenceHeight - inset * 2) / sh);
  const drawWidth = Math.max(1, Math.round(sw * scale));
  const drawHeight = Math.max(1, Math.round(sh * scale));
  const dx = Math.round((referenceWidth - drawWidth) / 2);
  const dy = Math.round((referenceHeight - drawHeight) / 2);
  const toX = width / referenceWidth;
  const toY = height / referenceHeight;

  context.drawImage(
    atlasImage,
    sx, sy, sw, sh,
    dx * toX, dy * toY, drawWidth * toX, drawHeight * toY
  );
}

function releaseCanvas(canvas) {
  // Zero-size frees the backing store now instead of whenever GC runs.
  canvas.width = 0;
  canvas.height = 0;
}

function cachedCrop(sprite, width, height) {
  const key = `${sprite.col}:${sprite.row}@${width}x${height}`;
  const cached = cropCache.get(key);
  if (cached) {
    cropCache.delete(key);
    cropCache.set(key, cached);
    return cached;
  }

  const crop = document.createElement('canvas');
  crop.width = width;
  crop.height = height;
  const context = crop.getContext('2d', { alpha: true });
  if (!context) return null;
  drawSprite(context, sprite, width, height);

  cropCache.set(key, crop);
  cropCacheBytes += width * height * 4;
  for (const [oldestKey, oldest] of cropCache) {
    if (cropCache.size <= CROP_CACHE_MAX_ENTRIES && cropCacheBytes <= CROP_CACHE_MAX_BYTES) break;
    if (oldestKey === key) break;
    cropCacheBytes -= oldest.width * oldest.height * 4;
    cropCache.delete(oldestKey);
    releaseCanvas(oldest);
  }
  return crop;
}

function paintSide(side, state) {
  if (!atlasReady || !state.canvas || !state.cssWidth || !state.cssHeight) return;
  const { width, height } = outputSize(state.cssWidth, state.cssHeight);
  const painted = `${state.sprite.col}:${state.sprite.row}@${width}x${height}`;
  if (state.painted === painted) return;

  const crop = cachedCrop(state.sprite, width, height);
  const canvas = state.canvas;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!crop || !context) return;

  context.clearRect(0, 0, width, height);
  context.drawImage(crop, 0, 0);
  state.painted = painted;
  side.dataset.spritePainted = `${state.sprite.col}:${state.sprite.row}`;
}

function setDataIfChanged(element, name, value) {
  if (element.dataset[name] !== value) element.dataset[name] = value;
}

// Registers a side and paints it once its size is known. A side already
// showing this sprite in its canvas is left alone.
function trackSide(side, sprite) {
  if (!side || !sprite?.rect) return;

  let state = trackedSides.get(side);
  if (state && state.sprite === sprite && state.canvas?.parentNode === side) return;
  if (!state) {
    state = { sprite, canvas: null, cssWidth: 0, cssHeight: 0, painted: '' };
    trackedSides.set(side, state);
    side.style.backgroundImage = 'none';
    side.style.backgroundPosition = '';
    if (resizeObserver) {
      resizeObserver.observe(side);
    } else {
      state.cssWidth = SPRITE_ATLAS.renderWidth;
      state.cssHeight = SPRITE_ATLAS.renderHeight;
    }
  }

  state.sprite = sprite;
  state.painted = '';
  setDataIfChanged(side, 'spriteCol', String(sprite.col));
  setDataIfChanged(side, 'spriteRow', String(sprite.row));
  setDataIfChanged(side, 'spriteName', sprite.name);

  if (state.canvas?.parentNode !== side) {
    // Inserted here rather than at paint time, so painting never mutates the
    // DOM and wakes the grid's other observers. No backing store until sized.
    state.canvas = side.querySelector(`.${CANVAS_CLASS}`);
    if (!state.canvas) {
      state.canvas = document.createElement('canvas');
      state.canvas.className = CANVAS_CLASS;
      state.canvas.setAttribute('aria-hidden', 'true');
      side.append(state.canvas);
    }
  }
  paintSide(side, state);
}

function onSideResize(entries) {
  for (const entry of entries) {
    const state = trackedSides.get(entry.target);
    if (!state) continue;
    // contentRect ignores transforms, so a mid-flip card reports its real size.
    state.cssWidth = entry.contentRect.width;
    state.cssHeight = entry.contentRect.height;
    if (state.painted) scheduleRepaint(entry.target);
    else paintSide(entry.target, state);
  }
}

function scheduleRepaint(side) {
  resizedSides.add(side);
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = 0;
    resizedSides.forEach((resized) => {
      const state = trackedSides.get(resized);
      if (state) paintSide(resized, state);
    });
    resizedSides.clear();
  }, RESIZE_SETTLE_MS);
}

// A DPR change without a CSS size change (moving a window to another display)
// never reaches the ResizeObserver, so it repaints everything itself.
function watchPixelRatio() {
  const query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  if (!query?.addEventListener) return;
  query.addEventListener('change', () => {
    trackedSides.forEach((state, side) => {
      if (state.painted) scheduleRepaint(side);
    });
    watchPixelRatio();
  }, { once: true });
}

function releaseDetachedSides() {
  trackedSides.forEach((state, side) => {
    if (side.isConnected) return;
    resizeObserver?.unobserve(side);
    if (state.canvas) releaseCanvas(state.canvas);
    resizedSides.delete(side);
    trackedSides.delete(side);
  });
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
  const spriteX = `${percentForCell(sprite.col, SPRITE_ATLAS.columns)}%`;
  const spriteY = `${percentForCell(sprite.row, SPRITE_ATLAS.rows)}%`;
  if (front.style.getPropertyValue('--sprite-x') !== spriteX) front.style.setProperty('--sprite-x', spriteX);
  if (front.style.getPropertyValue('--sprite-y') !== spriteY) front.style.setProperty('--sprite-y', spriteY);
  trackSide(front, sprite);
}

function normalizeCard(card) {
  const front = card.querySelector('.card-side-front');
  const back = card.querySelector('.card-side-back');
  if (front) normalizeFront(front);
  if (back) trackSide(back, SPRITE_ATLAS.back);
}

// Only cards that were added, or whose contents or face attributes changed,
// are revisited; flips and other card state never reach the sprite code.
function onGridMutations(records) {
  const cards = new Set();
  let removed = false;
  for (const record of records) {
    if (record.type === 'attributes') {
      const card = record.target.closest?.('.memory-card');
      if (card) cards.add(card);
      continue;
    }
    if (record.removedNodes.length) removed = true;
    record.addedNodes.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE || node.classList.contains(CANVAS_CLASS)) return;
      const card = node.closest('.memory-card');
      if (card) cards.add(card);
      else node.querySelectorAll('.memory-card').forEach((inner) => cards.add(inner));
    });
  }

  if (removed) releaseDetachedSides();
  cards.forEach((card) => {
    if (card.isConnected) normalizeCard(card);
  });
  // Drop the records this callback just caused (canvas insertion, face data
  // attributes) so it never re-runs on its own output.
  gridObserver.takeRecords();
}

function trackStaticDemo() {
  const demoBack = document.querySelector('.sprite-demo .sprite-back');
  const demoFace = document.querySelector('.sprite-demo .sprite-symbol');
  if (demoBack) trackSide(demoBack, SPRITE_ATLAS.back);
  if (demoFace) trackSide(demoFace, SPRITE_ATLAS.playableFaces[8]);
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

// A decoded sheet must actually hold the art: the middle of the card back is
// solid, so a transparent pixel there means a truncated or wrong file.
function sheetHasPixels(image) {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  try {
    const context = probe.getContext('2d');
    const { x, y, w, h } = SPRITE_ATLAS.back.rect;
    const sx = Math.floor((x + w / 2) * (image.naturalWidth / SPRITE_ATLAS.sourceWidth));
    const sy = Math.floor((y + h / 2) * (image.naturalHeight / SPRITE_ATLAS.sourceHeight));
    context.drawImage(image, sx, sy, 1, 1, 0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] > 0;
  } catch (_) {
    return false;
  } finally {
    releaseCanvas(probe);
  }
}

function loadSheet(image, attempt) {
  return new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', () => reject(new Error('the card sprite sheet failed to load')), { once: true });
    // A retry asks again under a new URL, so a failed response the browser
    // still holds is not handed back. The worker ignores the query string.
    image.src = attempt > 1 ? `${SPRITE_ATLAS.image}?attempt=${attempt}` : SPRITE_ATLAS.image;
    // An already-cached sheet can be complete before any event fires; the
    // promise settles once either way.
    if (image.complete && image.naturalWidth > 0) resolve();
  })
    // Decode off the main thread up front, so the first board's crops do not
    // stall on decoding the whole sheet. Some engines reject decode() for an
    // image that is in fact usable, so the pixel check below is the judge.
    .then(() => (image.decode ? image.decode().catch(() => {}) : undefined))
    .then(() => {
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0) || !sheetHasPixels(image)) {
        throw new Error('the card sprite sheet did not decode');
      }
      return image;
    });
}

function requestCardArt() {
  cardArt.attempt += 1;
  const attempt = cardArt.attempt;
  cardArt.state = 'loading';
  // Abandon a slower earlier attempt rather than download the sheet twice.
  if (cardArt.image) cardArt.image.src = '';
  const image = new Image();
  image.decoding = 'async';
  cardArt.image = image;
  cardArt.promise = loadSheet(image, attempt).then(
    (image) => {
      if (attempt !== cardArt.attempt) return cardArt.promise;
      cardArt.state = 'ready';
      onAtlasReady(image);
      return image;
    },
    (error) => {
      if (attempt !== cardArt.attempt) return cardArt.promise;
      cardArt.state = 'failed';
      console.error(`[DEJA VU] ${error.message}.`);
      throw error;
    },
  );
  // Callers that only watch state must not surface an unhandled rejection.
  cardArt.promise.catch(() => {});
  return cardArt.promise;
}

function onAtlasReady(image) {
  if (atlasReady) return;
  atlasImage = image;
  atlasReady = true;
  validateSourceSheet();
  trackedSides.forEach((state, side) => paintSide(side, state));
}

/** 'loading', 'ready' or 'failed'. */
export function cardArtState() {
  return cardArt.state;
}

/** Settles with the current attempt to load and decode the card art. */
export function whenCardArtReady() {
  return cardArt.promise;
}

/** Starts a fresh attempt unless the art is already ready. */
export function retryCardArt() {
  return cardArt.state === 'ready' ? cardArt.promise : requestCardArt();
}

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

requestCardArt();
installAtlasStyles();
grid?.querySelectorAll('.memory-card').forEach(normalizeCard);
trackStaticDemo();
watchPixelRatio();
gridObserver?.observe(grid, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-sprite-col', 'data-sprite-row'],
});

window.DEJA_VU_SPRITE_ATLAS = SPRITE_ATLAS;
