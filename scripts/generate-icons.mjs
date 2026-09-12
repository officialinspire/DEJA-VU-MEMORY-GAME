// Regenerates the PWA icons from the card-flip sprite sheet.
//
// The icon is the back of a DEJA VU card on the app's purple field, so the
// installed app looks like the thing the player taps. Run after changing the
// sprite sheet or the icon design, then `npm run build`:
//
//   node scripts/generate-icons.mjs
//
// Rendering happens in the Chromium that already ships for the browser test
// suite, so this adds no dependency.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

import {
  missingBrowserMessage,
  resolveChromium,
  rootDirectory,
  startServer,
  SUBPATH,
} from './browser-harness.mjs';

// Where the card back sits in card-flip-sprite-sheet.png (1233x1275).
//
// Note this is NOT the same rectangle the game shows. `.card-side-back` uses
// background-size: 500% 400% with background-position: 50% 100%, which crops to
// a uniform 5x4 grid cell (x 493..740, y 956..1275). The artwork does not sit
// flush in that cell: the cell clips 71px off the top of the card and leaves
// 97px of empty space below it. These bounds are the whole card, measured from
// the sheet's alpha channel, so the icon shows a complete card.
const CARD = { x: 510, y: 885, width: 213, height: 290 };
const CARD_ASPECT = CARD.width / CARD.height;

const ICONS = [
  // Card height as a fraction of the canvas.
  { file: 'icons/icon-192.png', size: 192, scale: 0.84, maskable: false },
  { file: 'icons/icon-512.png', size: 512, scale: 0.84, maskable: false },
  // Maskable icons may be cropped to a circle of 80% diameter, so the whole
  // card has to fit inside that circle: height * sqrt(1 + aspect^2) <= 0.8 * size.
  // The 0.96 leaves a little headroom rather than landing exactly on the edge.
  { file: 'icons/icon-maskable-512.png', size: 512, scale: 0.96 * 0.8 / Math.sqrt(1 + CARD_ASPECT ** 2), maskable: true },
];

async function render(page, spriteUrl, icon) {
  const dataUrl = await page.evaluate(async ({ spriteUrl: url, card, size, scale }) => {
    const sprite = new Image();
    sprite.src = url;
    await sprite.decode();

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // The app's own backdrop colour, matching the manifest's background_color
    // and theme_color, so the icon reads as DEJA VU rather than as a loose
    // playing card. Kept flat on purpose: gradients and glows more than doubled
    // the encoded size of an icon whose artwork is already highly detailed.
    ctx.fillStyle = '#18082d';
    ctx.fillRect(0, 0, size, size);

    const drawHeight = Math.round(size * scale);
    const drawWidth = Math.round(drawHeight * (card.width / card.height));
    const dx = Math.round((size - drawWidth) / 2);
    const dy = Math.round((size - drawHeight) / 2);

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite, card.x, card.y, card.width, card.height, dx, dy, drawWidth, drawHeight);

    return canvas.toDataURL('image/png');
  }, { spriteUrl, card: CARD, size: icon.size, scale: icon.scale });

  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  const target = path.join(rootDirectory, icon.file);
  await writeFile(target, buffer);
  return { file: icon.file, bytes: buffer.length };
}

async function main() {
  const executablePath = resolveChromium(chromium);
  if (!executablePath) {
    console.error(missingBrowserMessage());
    process.exitCode = 1;
    return;
  }

  // Served over http so the canvas is not tainted by a file:// image.
  const server = await startServer();
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.origin}${SUBPATH}index.html`);
    const spriteUrl = `${server.origin}${SUBPATH}card-flip-sprite-sheet.png`;
    for (const icon of ICONS) {
      const result = await render(page, spriteUrl, icon);
      console.log(`  ${result.file.padEnd(30)} ${icon.size}x${icon.size}  ${result.bytes} bytes`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log('Icons regenerated from the sprite sheet. Run `npm run build` to update dist/.');
}

await main();
