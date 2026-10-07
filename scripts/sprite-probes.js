/* eslint-env browser */
/* Injected before any app code as window.__sprites, for the sprite suite of
   verify-browser.mjs and for measure-sprite-atlas.mjs. It watches canvases
   from outside the app (every canvas created, which got a 2D context, how
   many draws happened) and checks painted card sides against the sprite
   sheet itself, so neither depends on how sprite-atlas.js is written.
   Its own reference drawing uses OffscreenCanvas, which it does not count. */
(() => {
  const canvases = [];
  const withContext = new WeakSet();
  const counts = { atlasDraws: 0, canvasDraws: 0 };
  // Reported errors, e.g. "ResizeObserver loop completed with undelivered notifications".
  const errors = [];
  window.addEventListener('error', (event) => errors.push(event.message || String(event.error)));

  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function patchedCreateElement(name, options) {
    const element = createElement.call(this, name, options);
    if (String(name).toLowerCase() === 'canvas') canvases.push(new WeakRef(element));
    return element;
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patchedGetContext(...args) {
    const context = getContext.apply(this, args);
    if (context) withContext.add(this);
    return context;
  };
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function patchedDrawImage(source, ...rest) {
    if (source instanceof HTMLImageElement || source instanceof ImageBitmap) counts.atlasDraws += 1;
    else counts.canvasDraws += 1;
    return drawImage.call(this, source, ...rest);
  };

  // Sheet pixels decoded independently of the app's own Image.
  let sheetPromise = null;
  function sheet() {
    if (!sheetPromise) {
      sheetPromise = (async () => {
        const image = new Image();
        image.src = window.DEJA_VU_SPRITE_ATLAS.image;
        await image.decode();
        const surface = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
        const context = surface.getContext('2d');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.naturalWidth, image.naturalHeight);
        return { image, data, width: image.naturalWidth, height: image.naturalHeight };
      })();
    }
    return sheetPromise;
  }

  function sprites() {
    const atlas = window.DEJA_VU_SPRITE_ATLAS;
    return [atlas.back, ...atlas.playableFaces];
  }

  function paddedCrop(sprite) {
    const atlas = window.DEJA_VU_SPRITE_ATLAS;
    const pad = atlas.sourcePadding;
    const x0 = Math.max(0, sprite.rect.x - pad);
    const y0 = Math.max(0, sprite.rect.y - pad);
    const x1 = Math.min(atlas.sourceWidth, sprite.rect.x + sprite.rect.w + pad);
    const y1 = Math.min(atlas.sourceHeight, sprite.rect.y + sprite.rect.h + pad);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function alphaBounds(data, stride, box, threshold) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        if (data[(y * stride + x) * 4 + 3] > threshold) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    return Number.isFinite(left) ? { left, top, right: right + 1, bottom: bottom + 1 } : null;
  }

  // The documented layout: the padded crop, contain-fitted inside the 8 px
  // inset of the 600 x 775 reference card and centred (rounded there, as the
  // old fixed bitmap was), then mapped onto a width x height bitmap.
  function layout(crop, width, height) {
    const atlas = window.DEJA_VU_SPRITE_ATLAS;
    const inset = atlas.renderInset;
    const scale = Math.min((atlas.renderWidth - inset * 2) / crop.w, (atlas.renderHeight - inset * 2) / crop.h);
    const w = Math.max(1, Math.round(crop.w * scale));
    const h = Math.max(1, Math.round(crop.h * scale));
    const toX = width / atlas.renderWidth;
    const toY = height / atlas.renderHeight;
    return {
      x: Math.round((atlas.renderWidth - w) / 2) * toX,
      y: Math.round((atlas.renderHeight - h) / 2) * toY,
      w: w * toX,
      h: h * toY,
    };
  }

  function render(width, height, draw) {
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    draw(context);
    return { surface, data: context.getImageData(0, 0, width, height).data };
  }

  // Compared premultiplied, as composited: a near-transparent pixel's colour
  // is noise, not a visible difference.
  function difference(a, b) {
    let total = 0;
    let max = 0;
    for (let index = 0; index < a.length; index += 4) {
      const alphaA = a[index + 3];
      const alphaB = b[index + 3];
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = channel === 3
          ? Math.abs(alphaA - alphaB)
          : Math.abs(a[index + channel] * alphaA - b[index + channel] * alphaB) / 255;
        total += delta;
        if (delta > max) max = delta;
      }
    }
    return { mean: total / a.length, max: Math.round(max) };
  }

  // Which sprite index.js dealt to a card, read from its own markup.
  function dealtSprite(side) {
    const atlas = window.DEJA_VU_SPRITE_ATLAS;
    if (side.classList.contains('card-side-back')) return atlas.back;
    const style = side.getAttribute('style') || '';
    const x = Number.parseFloat(/--sprite-x:\s*([\d.]+)%/.exec(style)?.[1]);
    const y = Number.parseFloat(/--sprite-y:\s*([\d.]+)%/.exec(style)?.[1]);
    const col = Math.round((x / 100) * (atlas.columns - 1));
    const row = Math.round((y / 100) * (atlas.rows - 1));
    return atlas.playableFaces.find((sprite) => sprite.col === col && sprite.row === row) || null;
  }

  window.__sprites = {
    takeCounts() {
      const result = { ...counts };
      counts.atlasDraws = 0;
      counts.canvasDraws = 0;
      return result;
    },

    /** Canvases holding a backing store, on the page and off it. */
    canvases() {
      const out = { attached: 0, attachedBytes: 0, detached: 0, detachedBytes: 0, largest: '' };
      let largest = 0;
      for (const ref of canvases) {
        const canvas = ref.deref();
        if (!canvas || !withContext.has(canvas)) continue;
        const bytes = canvas.width * canvas.height * 4;
        if (!bytes) continue;
        if (canvas.isConnected) {
          out.attached += 1;
          out.attachedBytes += bytes;
        } else {
          out.detached += 1;
          out.detachedBytes += bytes;
        }
        if (bytes > largest) {
          largest = bytes;
          out.largest = `${canvas.width}x${canvas.height}`;
        }
      }
      return out;
    },

    errors() {
      return [...errors];
    },

    /**
     * The measured rectangles against the shipped sheet: each one is tight
     * around its sprite, and its padded crop holds every visible pixel of the
     * sprite and none of another's. The band
     * around a crop skips other sprites' crops, since some rows sit only 12 px
     * apart.
     */
    async atlasContract(band = 12) {
      const { data, width, height } = await sheet();
      const list = sprites();
      const crops = list.map(paddedCrop);
      const inside = (box, x, y) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      return list.map((sprite, spriteIndex) => {
        const crop = crops[spriteIndex];
        const others = crops.filter((_, index) => index !== spriteIndex);
        let outside = 0;
        for (let y = Math.max(0, crop.y - band); y < Math.min(height, crop.y + crop.h + band); y += 1) {
          for (let x = Math.max(0, crop.x - band); x < Math.min(width, crop.x + crop.w + band); x += 1) {
            if (inside(crop, x, y) || others.some((other) => inside(other, x, y))) continue;
            outside = Math.max(outside, data[(y * width + x) * 4 + 3]);
          }
        }
        const overlaps = list.filter((other, index) => {
          if (index === spriteIndex) return false;
          const o = crops[index];
          return crop.x < o.x + o.w && o.x < crop.x + crop.w && crop.y < o.y + o.h && o.y < crop.y + crop.h;
        }).map((other) => other.name);
        // Empty columns/rows just inside each measured edge: the rectangles
        // are tight, so a drifted one leaves a gap on one side.
        const visible = alphaBounds(data, width, crop, 0);
        const { x, y, w, h } = sprite.rect;
        return {
          name: sprite.name,
          insideSheet: x >= 0 && y >= 0 && x + w <= width && y + h <= height,
          maxAlphaOutsideCrop: outside,
          overlaps,
          slack: visible && {
            left: visible.left - x,
            top: visible.top - y,
            right: x + w - visible.right,
            bottom: y + h - visible.bottom,
          },
        };
      });
    },

    /**
     * Every painted side on the board: bitmap size against its CSS box, the
     * transparent gutter, the visible extent against the sprite's own extent
     * in the sheet, and pixels against an independent render of the sprite
     * and against the old fixed 600 x 775 render scaled down to the same size.
     */
    async inspectBoard({ threshold = 8 } = {}) {
      const atlas = window.DEJA_VU_SPRITE_ATLAS;
      const { image, data: sheetData, width: sheetWidth } = await sheet();
      const references = new Map();
      const ratio = Math.min(window.devicePixelRatio || 1, atlas.maxPixelRatio || 3);
      return [...document.querySelectorAll('#card-grid .card-side')].map((side, index) => {
        const sprite = dealtSprite(side);
        const canvas = side.querySelector('canvas.sprite-cell-canvas');
        const style = getComputedStyle(side);
        const cssWidth = Number.parseFloat(style.width);
        const cssHeight = Number.parseFloat(style.height);
        const base = {
          index,
          side: side.classList.contains('card-side-back') ? 'back' : 'front',
          sprite: sprite?.name || null,
          paintedAs: side.dataset.spritePainted || '',
          expectedKey: sprite ? `${sprite.col}:${sprite.row}` : '',
          cssWidth,
          cssHeight,
          width: canvas?.width || 0,
          height: canvas?.height || 0,
          canvasCount: side.querySelectorAll('canvas').length,
        };
        const capScale = Math.min(ratio, atlas.renderWidth / cssWidth, atlas.renderHeight / cssHeight);
        base.expectedWidth = Math.round(cssWidth * capScale);
        base.expectedHeight = Math.round(cssHeight * capScale);
        if (!sprite || !canvas || !canvas.width || !canvas.height) return base;

        const { width, height } = canvas;
        const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        const crop = paddedCrop(sprite);
        const box = layout(crop, width, height);

        // Nothing may be painted outside the pixels the padded crop touches.
        const left = Math.floor(box.x);
        const top = Math.floor(box.y);
        const right = Math.ceil(box.x + box.w);
        const bottom = Math.ceil(box.y + box.h);
        // And the art never reaches the bitmap's edge, where it would be cut.
        let outsideAlpha = 0;
        let edgeAlpha = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const alpha = pixels[(y * width + x) * 4 + 3];
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgeAlpha = Math.max(edgeAlpha, alpha);
            if (x >= left && x < right && y >= top && y < bottom) continue;
            outsideAlpha = Math.max(outsideAlpha, alpha);
          }
        }
        const drawn = alphaBounds(pixels, width, { x: 0, y: 0, w: width, h: height }, threshold);
        const source = alphaBounds(sheetData, sheetWidth, crop, threshold);
        const scaleX = box.w / crop.w;
        const scaleY = box.h / crop.h;
        const expected = source && {
          left: box.x + (source.left - crop.x) * scaleX,
          top: box.y + (source.top - crop.y) * scaleY,
          right: box.x + (source.right - crop.x) * scaleX,
          bottom: box.y + (source.bottom - crop.y) * scaleY,
        };

        const key = `${base.expectedKey}@${width}x${height}`;
        if (!references.has(key)) {
          const direct = render(width, height, (context) => context.drawImage(
            image, crop.x, crop.y, crop.w, crop.h, box.x, box.y, box.w, box.h,
          ));
          // The pre-optimisation path: a fixed 600 x 775 bitmap with an 8 px
          // inset, which the browser then scaled down to the card.
          const legacyBox = layout(crop, atlas.renderWidth, atlas.renderHeight);
          const legacy = render(atlas.renderWidth, atlas.renderHeight, (context) => context.drawImage(
            image, crop.x, crop.y, crop.w, crop.h, legacyBox.x, legacyBox.y, legacyBox.w, legacyBox.h,
          ));
          const legacyShown = render(width, height, (context) => context.drawImage(legacy.surface, 0, 0, width, height));
          references.set(key, { direct: direct.data, legacy: legacyShown.data });
        }
        const reference = references.get(key);
        return {
          ...base,
          scale: scaleX,
          outsideAlpha,
          edgeAlpha,
          drawn,
          expected,
          vsDirect: difference(pixels, reference.direct),
          vsLegacy: difference(pixels, reference.legacy),
        };
      });
    },
  };
})();
