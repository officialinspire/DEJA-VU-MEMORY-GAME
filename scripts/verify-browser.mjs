// Rendered-behavior regression suite.
//
// The other verifiers read source text and recompute board maths. This one
// drives the built app in a real browser and measures what a player would
// actually see: nothing overflowing sideways, every essential control reachable
// without horizontal scrolling, the short-viewport screens fitting without
// clipping, the intro keeping its aspect ratio, phone layout not drifting, a
// full game playable with the network switched off, and every card side
// painted with the right, complete sprite at its real pixel size.
import assert from 'node:assert/strict';
import {
  cp, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

import {
  createRunner,
  distDirectory,
  missingBrowserMessage,
  resolveChromium,
  rootDirectory,
  startServer,
} from './browser-harness.mjs';

const PROBES_PATH = path.join(rootDirectory, 'scripts', 'browser-probes.js');
const SPRITE_PROBES_PATH = path.join(rootDirectory, 'scripts', 'sprite-probes.js');
const BASELINE_PATH = path.join(rootDirectory, 'scripts', 'mobile-layout-baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
// --suite=desktop,offline narrows a run while iterating; the default is all.
const ALL_SUITES = ['desktop', 'intro', 'mobile', 'offline', 'sprites', 'loading'];
const SUITE_FILTER = (() => {
  const flag = process.argv.find((arg) => arg.startsWith('--suite='));
  if (!flag) return new Set(ALL_SUITES);
  const names = flag.slice('--suite='.length).split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !ALL_SUITES.includes(name));
  if (unknown.length) throw new Error(`unknown suite(s): ${unknown.join(', ')}; choose from ${ALL_SUITES.join(', ')}`);
  return new Set(names);
})();

// A 1080x720 (3:2) VP9 clip of solid black, ~1.1 KB. The intro tests only need
// a resource with the real clip's intrinsic size; using this keeps the suite
// runnable on Chromium builds without proprietary codecs, which is exactly
// where a contributor's browser is likely to land.
const INTRO_FIXTURE = 'data:video/webm;base64,GkXfowEAAAAAAAAfQoaBAUL3gQFC8oEEQvOBCEKChHdlYm1Ch4ECQoWBAhhTgGcBAAAAAAAEYxFNm3RAO027i1OrhBVJqWZTrIHlTbuMU6uEFlSua1OsggEjTbuMU6uEElTDZ1OsggFsTbuMU6uEHFO7a1OsggRG7AEAAAAAAACbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmAQAAAAAAADIq17GDD0JATYCNTGF2ZjU4LjI0LjEwMFdBjUxhdmY1OC4yNC4xMDBEiYhAaQAAAAAAABZUrmsBAAAAAAAAPa4BAAAAAAAANNeBAXPFgQGcgQAitZyDdW5khoVWX1ZQOYOBASPjg4QL68IA4AEAAAAAAAAIsIIEOLqCAtASVMNnAQAAAAAAAMNzcwEAAAAAAAAuY8ABAAAAAAAAAGfIAQAAAAAAABpFo4dFTkNPREVSRIeNTGF2ZjU4LjI0LjEwMHNzAQAAAAAAAD1jwAEAAAAAAAAEY8WBAWfIAQAAAAAAACVFo4dFTkNPREVSRIeYTGF2YzU4LjQyLjEwMCBsaWJ2cHgtdnA5c3MBAAAAAAAAOmPAAQAAAAAAAARjxYEBZ8gBAAAAAAAAIkWjiERVUkFUSU9ORIeUMDA6MDA6MDAuMjAwMDAwMDAwAAAfQ7Z1AQAAAAAAAf/ngQCjQfmBAACAgkmDQgBDcCz2fjgkHBnAGABYR9/v1H9H9HnHpHvBdmK1pICVo/0qAAAAAGFrHnQqs3iMAvtn32MbgDr8Fv1od8M0ym17AZOoWuhyzypdYZFSlxDomw5Zr1mJPepS3Ks6l1hkVKXEOibDlmvWYk96lLcqzqXWGRUpcQ6JsOWa9ZiT3qUtyrASPodtU7KAAAAAYWsedCqzeIwC+2ffYxuAOvwW/Wh3wzTKbXsBk6ha6HLPKl1hkVKXEOibDlmvWYk96lLcqzqXWGRUpcQ6JsOWa9ZiT3qUtyrOpdYZFSlxDomw5Zr1mJPepS3KsBI+h21TsoAAAABhax50KrN4jAL7Z99jG4A6/Bb9aHfDNMptewGTqFrocs8qXWGRUpcQ6JsOWa9ZiT3qUtyrOpdYZFSlxDomw5Zr1mJPepS3Ks6l1hkVKXEOibDlmvWYk96lLcqwEj6HbVOygGsedCqzeIwC+2ffYxuAOvwW/Wh3wzTKbXr4oKlPrnESsXc2IpbsFYG6Snxc5DphpFS79SPODmr3CccrbDX/XOSi0niT3qUtyq38HKz3+IlYu5sRS3YKwN0lPi5yHTDSKl36kecHNXuE45W2Gv+uclFpPEnvUpblVv4OVnv8RKxdzYiluwVgbpKfFzkOmGkVLv1I84OYSQ8o91yijrpgHFO7awEAAAAAAAARu4+zgQC3iveBAfGCAjvwgQM=';

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
// Browser zoom shrinks the CSS viewport; 150% of a 720p panel is the shortest
// desktop case a player realistically produces.
const ZOOM_LEVELS = [1, 1.25, 1.5];

const MOBILE_VIEWPORTS = [
  { name: 'iphone-se', width: 320, height: 568 },
  { name: 'iphone-8', width: 375, height: 667 },
  { name: 'iphone-12', width: 390, height: 844 },
  { name: 'iphone-14-pro-max', width: 430, height: 932 },
  { name: 'phone-landscape', width: 844, height: 390 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
];

const DIFFICULTIES = ['easy', 'intermediate', 'advanced', 'insane'];

// What a player must be able to read or press on each view. A regression that
// clips any of these fails the suite.
const SCREEN_ESSENTIALS = {
  start: ['.start-logo', '.brand-start', '.start-prompt'],
  intro: ['#intro-video', '#btn-skip-intro'],
  menu: [
    '.brand', '#btn-new-game', '#btn-continue', '#btn-statistics',
    '#btn-how-to-play', '#btn-settings', '.menu-footer a',
  ],
  game: [
    '#btn-game-menu', '#btn-pause', '.game-title-wrap h1', '#game-difficulty',
    '#stat-moves', '#stat-mistakes', '#stat-time', '#game-message',
    '#pairs-label', '.memory-card',
  ],
  statistics: [
    '[data-back-menu]', '#statistics-title', '#stats-played', '#stats-won',
    '#stats-perfect', '#stats-best-score', '#btn-reset-stats',
  ],
  help: ['[data-back-menu]', '#help-title', '.help-copy li', '#score-explainer'],
  settings: [
    '[data-back-menu]', '#settings-title',
    '#setting-music', '#setting-music-volume', '#setting-sfx',
    '#setting-sfx-volume', '#setting-haptics', '#setting-motion',
  ],
};

const DIALOG_ESSENTIALS = {
  'difficulty-dialog': [
    '[data-difficulty="easy"]', '[data-difficulty="intermediate"]',
    '[data-difficulty="advanced"]', '[data-difficulty="insane"]', '.dialog-cancel',
  ],
  'pause-dialog': ['h2', '#btn-resume', '#btn-pause-menu'],
  'art-dialog': ['#art-title', '#art-message', '.dialog-cancel'],
  'complete-dialog': [
    '#complete-grade', '#complete-performance', '#complete-difficulty',
    '#complete-moves', '#complete-mistakes', '#complete-time', '#complete-score',
    '#btn-play-again', '#btn-complete-menu',
  ],
};

// Screens with no scroll container of their own: content has to fit outright,
// because #app clips anything that does not.
const NON_SCROLLING_SCREENS = new Set(['start', 'intro']);

// Views that must fit a desktop window outright. Gameplay and modals are the
// ones where scrolling to reach a control is itself the bug; the long-form
// panels (statistics, help, settings) are ordinary scrollable documents.
const DESKTOP_MUST_FIT = { mustFitWithoutScrolling: true };

function formatElement(entry) {
  return `${entry.label} [top=${entry.top} bottom=${entry.bottom} left=${entry.left} right=${entry.right} `
    + `client=${entry.clientWidth}x${entry.clientHeight} maxScrollY=${entry.maxScrollY} scroller=${entry.scroller}]`;
}

/**
 * Asserts that everything a view needs is rendered, reachable by vertical
 * scrolling alone, and not covered by anything else.
 */
function assertEssentials(runner, label, report, { mustFitWithoutScrolling = false } = {}) {
  for (const [selector, result] of Object.entries(report)) {
    runner.check(`${label} — ${selector} exists`, () => {
      assert.ok(result.count > 0, `no element matched ${selector} on ${label}`);
    });
    for (const entry of result.elements) {
      runner.check(`${label} — ${selector} rendered`, () => {
        assert.ok(entry.rendered, `${formatElement(entry)} is not rendered on ${label}`);
      });
      if (!entry.rendered) continue;
      runner.check(`${label} — ${selector} fits horizontally`, () => {
        assert.ok(entry.withinWidth, `${formatElement(entry)} needs horizontal scrolling on ${label}`);
      });
      runner.check(`${label} — ${selector} reachable`, () => {
        assert.ok(entry.reachableVertically, `${formatElement(entry)} cannot be scrolled to on ${label}`);
      });
      runner.check(`${label} — ${selector} not covered`, () => {
        assert.ok(!entry.occluded, `${formatElement(entry)} is covered by ${entry.occludedBy} on ${label}`);
      });
      if (entry.insideViewport !== null) {
        runner.check(`${label} — ${selector} inside viewport once scrolled to`, () => {
          assert.ok(entry.insideViewport, `${formatElement(entry)} is outside the viewport on ${label}`);
        });
      }
      if (mustFitWithoutScrolling) {
        runner.check(`${label} — ${selector} fits without scrolling`, () => {
          assert.ok(!entry.neededScroll, `${formatElement(entry)} is off-screen on ${label}, which cannot scroll`);
        });
      }
    }
  }
}

function assertNoHorizontalOverflow(runner, label, overflow) {
  runner.check(`${label} — no horizontal overflow`, () => {
    assert.ok(
      overflow.horizontal <= 1,
      `${label} overflows horizontally by ${overflow.horizontal}px `
      + `(document ${overflow.documentX}, body ${overflow.bodyX}, #app ${overflow.appX}, ${overflow.container} ${overflow.containerX})`,
    );
  });
}

async function auditView(runner, page, label, selectors, options = {}) {
  const overflow = await page.evaluate(() => window.__deja.overflow());
  assertNoHorizontalOverflow(runner, label, overflow);
  if (options.mustFitWithoutScrolling) {
    runner.check(`${label} — content fits without scrolling`, () => {
      assert.ok(
        overflow.containerY <= 1,
        `${label} has ${overflow.containerY}px of content past the fold`
        + (overflow.containerScrollsY ? ' (scrollable, but this view must fit outright)' : ' and cannot scroll'),
      );
    });
  }
  const report = await page.evaluate((list) => window.__deja.inspect(list), selectors);
  assertEssentials(runner, label, report, options);
}

async function newPage(browser, viewport, extra = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ...extra,
  });
  const page = await context.newPage();
  // startNewGame() confirms before replacing an in-progress board.
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  await page.addInitScript({ path: PROBES_PATH });
  return { context, page };
}

async function startBoard(page, difficulty) {
  await page.evaluate(() => window.__deja.openDialog('difficulty-dialog'));
  await page.evaluate((value) => document.querySelector(`[data-difficulty="${value}"]`).click(), difficulty);
  await page.waitForFunction(
    () => !document.querySelector('#difficulty-dialog').open
      && document.querySelector('#screen-game').classList.contains('is-active'),
    null,
    { timeout: 5000 },
  );
  await page.evaluate(() => window.__deja.settle());
}

// ---------------------------------------------------------------- desktop ---

async function auditDesktop(runner, browser, baseUrl) {
  for (const size of DESKTOP_VIEWPORTS) {
    for (const zoom of ZOOM_LEVELS) {
      // Browser zoom is a smaller CSS viewport at a higher device pixel ratio.
      const viewport = { width: Math.round(size.width / zoom), height: Math.round(size.height / zoom) };
      const label = `${size.width}x${size.height}@${Math.round(zoom * 100)}%`;
      runner.group(label);
      const { context, page } = await newPage(browser, viewport, { deviceScaleFactor: zoom });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.evaluate(() => window.__deja.settle());

      await auditView(runner, page, `${label} start`, SCREEN_ESSENTIALS.start, {
        // The start screen has no scroll container; it must simply fit.
        mustFitWithoutScrolling: NON_SCROLLING_SCREENS.has('start'),
      });

      await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);
      await page.evaluate(() => window.__deja.showScreen('intro'));
      await auditView(runner, page, `${label} intro`, SCREEN_ESSENTIALS.intro, {
        mustFitWithoutScrolling: NON_SCROLLING_SCREENS.has('intro'),
      });

      await page.evaluate(() => window.__deja.showScreen('menu'));
      await auditView(runner, page, `${label} menu`, SCREEN_ESSENTIALS.menu, DESKTOP_MUST_FIT);

      await page.evaluate(() => window.__deja.openDialog('difficulty-dialog'));
      await auditView(runner, page, `${label} difficulty dialog`, DIALOG_ESSENTIALS['difficulty-dialog'], DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

      for (const difficulty of DIFFICULTIES) {
        await startBoard(page, difficulty);
        // A memory game you have to scroll mid-hand is a regression, not a
        // styling preference: the whole board has to be on screen at once.
        await auditView(runner, page, `${label} game/${difficulty}`, SCREEN_ESSENTIALS.game, DESKTOP_MUST_FIT);
      }

      await page.evaluate(() => window.__deja.openDialog('pause-dialog'));
      await auditView(runner, page, `${label} pause dialog`, DIALOG_ESSENTIALS['pause-dialog'], DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

      await page.evaluate(() => window.__deja.openDialog('complete-dialog'));
      await auditView(runner, page, `${label} complete dialog`, DIALOG_ESSENTIALS['complete-dialog'], DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

      await page.evaluate(() => window.__deja.openDialog('art-dialog'));
      await auditView(runner, page, `${label} card-art dialog`, DIALOG_ESSENTIALS['art-dialog'], DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

      for (const screen of ['statistics', 'help', 'settings']) {
        await page.evaluate((name) => window.__deja.showScreen(name), screen);
        await auditView(runner, page, `${label} ${screen}`, SCREEN_ESSENTIALS[screen]);
      }

      await context.close();
    }
  }
}

// ------------------------------------------------------------------ intro ---

async function auditIntroAspectRatio(runner, browser, baseUrl) {
  // Short and wide windows are where a cropped frame loses artwork rather than
  // empty matte, so they carry the interesting cases.
  const viewports = [
    ...DESKTOP_VIEWPORTS,
    { width: 1920, height: 600 },
    { width: 1280, height: 480 },
    { width: 900, height: 1000 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ];
  for (const viewport of viewports) {
    const label = `intro ${viewport.width}x${viewport.height}`;
    runner.group(label);
    const { context, page } = await newPage(browser, viewport);
    await page.goto(baseUrl, { waitUntil: 'load' });
    const natural = await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);
    runner.check(`${label} — fixture decoded`, () => {
      assert.deepEqual([natural.width, natural.height], [1080, 720], 'intro fixture did not report its intrinsic size');
    });
    if (natural.width !== 1080) {
      await context.close();
      continue;
    }

    await page.evaluate(() => window.__deja.showScreen('intro'));
    const geometry = await page.evaluate(() => window.__deja.introGeometry());

    runner.check(`${label} — object-fit stays contain`, () => {
      assert.equal(geometry.objectFit, 'contain', 'the intro must never cover-crop or stretch');
    });
    // The element box growing past the screen is how the frame got clipped:
    // an auto grid row inflated to the clip's intrinsic height.
    runner.check(`${label} — element fits the screen`, () => {
      assert.ok(
        geometry.boxHeight <= geometry.screenHeight + 1 && geometry.boxWidth <= geometry.screenWidth + 1,
        `video box ${Math.round(geometry.boxWidth)}x${Math.round(geometry.boxHeight)} `
        + `exceeds the intro screen ${geometry.screenWidth}x${geometry.screenHeight} `
        + `(grid row ${geometry.gridTemplateRows}), so #app clips the frame`,
      );
    });
    runner.check(`${label} — nothing clipped off the intro screen`, () => {
      assert.ok(
        geometry.overflowY <= 1 && geometry.overflowX <= 1,
        `intro screen overflows by ${geometry.overflowX}x${geometry.overflowY}px and cannot scroll`,
      );
    });
    runner.check(`${label} — aspect ratio preserved`, () => {
      assert.ok(
        Math.abs(geometry.drawnRatio - geometry.naturalRatio) < 0.01,
        `painted frame ratio ${geometry.drawnRatio.toFixed(4)} differs from the encoded `
        + `${geometry.naturalRatio.toFixed(4)}: the frame is stretched or cropped`,
      );
    });
    runner.check(`${label} — whole frame visible`, () => {
      assert.ok(
        geometry.drawnWidth <= viewport.width + 1 && geometry.drawnHeight <= viewport.height + 1,
        `painted frame ${Math.round(geometry.drawnWidth)}x${Math.round(geometry.drawnHeight)} `
        + `does not fit the ${viewport.width}x${viewport.height} viewport`,
      );
    });

    await context.close();
  }
}

// ----------------------------------------------------------------- mobile ---

async function collectMobileFingerprints(browser, baseUrl) {
  const collected = {};
  for (const viewport of MOBILE_VIEWPORTS) {
    const { context, page } = await newPage(browser, viewport, {
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);

    const entry = {
      desktopQuery: await page.evaluate(() => window.__deja.desktopQueryMatches()),
      boards: {},
      dialogs: {},
      intro: null,
    };
    await page.evaluate(() => window.__deja.showScreen('intro'));
    const intro = await page.evaluate(() => window.__deja.introGeometry());
    entry.intro = {
      boxWidth: Math.round(intro.boxWidth),
      boxHeight: Math.round(intro.boxHeight),
      drawnWidth: Math.round(intro.drawnWidth),
      drawnHeight: Math.round(intro.drawnHeight),
    };

    await page.evaluate(() => window.__deja.showScreen('menu'));
    entry.menu = await page.evaluate(() => window.__deja.menuFingerprint());

    for (const difficulty of DIFFICULTIES) {
      await startBoard(page, difficulty);
      entry.boards[difficulty] = await page.evaluate(() => window.__deja.boardFingerprint());
    }

    for (const dialog of ['difficulty-dialog', 'pause-dialog', 'complete-dialog']) {
      await page.evaluate((id) => window.__deja.openDialog(id), dialog);
      entry.dialogs[dialog] = await page.evaluate((id) => window.__deja.dialogFingerprint(id), dialog);
      await page.evaluate(() => window.__deja.closeDialogs());
    }

    collected[viewport.name] = entry;
    await context.close();
  }
  return collected;
}

function compareFingerprints(runner, label, expected, actual, tolerance = 1) {
  for (const [key, value] of Object.entries(expected)) {
    const found = actual[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      compareFingerprints(runner, `${label}.${key}`, value, found || {}, tolerance);
      continue;
    }
    runner.check(`${label}.${key} unchanged`, () => {
      if (Array.isArray(value)) {
        assert.ok(Array.isArray(found), `${label}.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(found)}`);
        value.forEach((item, index) => {
          assert.ok(
            typeof item === 'number' && Math.abs(item - found[index]) <= tolerance,
            `${label}.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(found)}`,
          );
        });
        return;
      }
      if (typeof value === 'number') {
        assert.ok(
          typeof found === 'number' && Math.abs(value - found) <= tolerance,
          `${label}.${key}: expected ${value} (±${tolerance}), got ${found}`,
        );
        return;
      }
      assert.equal(found, value, `${label}.${key}: expected ${value}, got ${found}`);
    });
  }
}

async function auditMobile(runner, browser, baseUrl) {
  runner.group('mobile');
  const actual = await collectMobileFingerprints(browser, baseUrl);

  if (UPDATE_BASELINE) {
    await writeFile(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Wrote mobile layout baseline for ${Object.keys(actual).length} viewports.`);
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  } catch (_) {
    runner.check('mobile baseline exists', () => {
      assert.fail(`missing ${path.basename(BASELINE_PATH)}; regenerate with: npm run test:browser -- --update-baseline`);
    });
    return;
  }

  for (const viewport of MOBILE_VIEWPORTS) {
    runner.group(`mobile/${viewport.name}`);
    const expected = baseline[viewport.name];
    runner.check(`${viewport.name} present in baseline`, () => {
      assert.ok(expected, `no baseline recorded for ${viewport.name}`);
    });
    if (!expected) continue;
    // Desktop viewport-fit rules are gated on a precise pointer; if one ever
    // matches here, phone layout has silently moved.
    runner.check(`${viewport.name} — desktop-only rules do not apply`, () => {
      assert.equal(actual[viewport.name].desktopQuery, false, 'a desktop-only media query matched on a touch device');
    });
    compareFingerprints(runner, viewport.name, expected, actual[viewport.name]);
  }
}

// ---------------------------------------------------------------- offline ---

async function auditOffline(runner, browser, baseUrl) {
  runner.group('offline');
  const { context, page } = await newPage(browser, { width: 1280, height: 720 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  // One online load is the entire setup budget.
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(
    async () => {
      const names = await caches.keys();
      const shell = names.find((name) => name.startsWith('deja-vu-'));
      if (!shell) return false;
      return (await (await caches.open(shell)).keys()).length >= 25;
    },
    null,
    { timeout: 20000 },
  );

  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  runner.check('worker controls the first page', () => {
    assert.ok(controlled, 'the first online load must end up controlled, or offline play needs a second visit');
  });

  // Everything past this point must work with no network at all.
  await context.setOffline(true);

  const reload = await page.goto(baseUrl, { waitUntil: 'load' });
  runner.check('offline reload is served', () => {
    assert.equal(reload.status(), 200, 'offline reload did not return the cached shell');
    assert.ok(reload.fromServiceWorker(), 'offline reload was answered by the network, not the worker');
  });
  const booted = await page.evaluate(() => ({
    start: !!document.querySelector('#screen-start.is-active'),
    styled: getComputedStyle(document.body).backgroundImage !== 'none',
    newGame: !!document.querySelector('#btn-new-game'),
  }));
  runner.check('offline boot renders the app', () => {
    assert.ok(booted.start, 'offline boot did not land on the start screen');
    assert.ok(booted.styled, 'offline boot lost its stylesheet');
    assert.ok(booted.newGame, 'offline boot lost its menu controls');
  });

  // Subpath and query-string navigation must resolve to the shell too.
  for (const suffix of ['?utm_source=test', 'index.html?v=9', '#fragment']) {
    const response = await page.goto(`${baseUrl}${suffix}`, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    runner.check(`offline navigation to ${suffix || '(root)'}`, () => {
      assert.equal(response.status(), 200, `offline navigation to ${suffix} failed`);
      assert.equal(title, 'DEJA VU by INSPIRE', `offline navigation to ${suffix} did not return the app shell`);
    });
  }

  await page.goto(baseUrl, { waitUntil: 'load' });

  // Media has to be served from the cache, including the byte ranges mobile
  // browsers use; a 200 answer to a Range request is what Safari refuses.
  const assets = await page.evaluate(async () => {
    const media = [
      './inspiresoftwareintro.mp4',
      './Deja Vu - Main Menu (Vibe 1).mp3',
      './Minimalist Electronic Focus Theme.mp3',
    ];
    const out = { full: {}, ranges: {} };
    for (const url of [...media, './card-flip-sprite-sheet.png', './logo.png', './styles.css', './styles.css?v=9']) {
      try {
        const response = await fetch(url);
        out.full[url] = { status: response.status, bytes: (await response.blob()).size };
      } catch (error) {
        out.full[url] = { status: 0, error: String(error) };
      }
    }
    for (const url of media) {
      out.ranges[url] = {};
      for (const [name, header] of [['head', 'bytes=0-1'], ['open', 'bytes=0-'], ['mid', 'bytes=1024-2047'], ['suffix', 'bytes=-64']]) {
        try {
          const response = await fetch(url, { headers: { Range: header } });
          out.ranges[url][name] = {
            status: response.status,
            contentRange: response.headers.get('Content-Range'),
            acceptRanges: response.headers.get('Accept-Ranges'),
            bytes: (await response.arrayBuffer()).byteLength,
          };
        } catch (error) {
          out.ranges[url][name] = { status: 0, error: String(error) };
        }
      }
    }
    return out;
  });

  for (const [url, result] of Object.entries(assets.full)) {
    runner.check(`offline fetch ${url}`, () => {
      assert.equal(result.status, 200, `${url} was not served offline (${result.error || result.status})`);
      assert.ok(result.bytes > 0, `${url} came back empty offline`);
    });
  }
  for (const [url, cases] of Object.entries(assets.ranges)) {
    runner.check(`offline range ${url} — probe request`, () => {
      assert.equal(cases.head.status, 206, `${url} answered a Range request with ${cases.head.status}, not 206`);
      assert.equal(cases.head.bytes, 2, `${url} returned ${cases.head.bytes} bytes for bytes=0-1`);
      assert.match(cases.head.contentRange || '', /^bytes 0-1\/\d+$/, `${url} sent Content-Range "${cases.head.contentRange}"`);
      assert.equal(cases.head.acceptRanges, 'bytes', `${url} did not advertise Accept-Ranges`);
    });
    runner.check(`offline range ${url} — open range`, () => {
      assert.equal(cases.open.status, 206, `${url} answered bytes=0- with ${cases.open.status}`);
      assert.ok(cases.open.bytes > 1000, `${url} returned only ${cases.open.bytes} bytes for bytes=0-`);
    });
    runner.check(`offline range ${url} — mid-file seek`, () => {
      assert.equal(cases.mid.status, 206, `${url} answered a mid-file seek with ${cases.mid.status}`);
      assert.equal(cases.mid.bytes, 1024, `${url} returned ${cases.mid.bytes} bytes for bytes=1024-2047`);
    });
    runner.check(`offline range ${url} — suffix range`, () => {
      assert.equal(cases.suffix.status, 206, `${url} answered a suffix range with ${cases.suffix.status}`);
      assert.equal(cases.suffix.bytes, 64, `${url} returned ${cases.suffix.bytes} bytes for bytes=-64`);
    });
  }

  // Audio must decode from cache, not merely download.
  const audio = await page.evaluate(async () => {
    const element = new Audio(new URL('./Deja Vu - Main Menu (Vibe 1).mp3', location.href).href);
    element.muted = true;
    return new Promise((resolve) => {
      element.addEventListener('loadedmetadata', () => resolve({ ok: true, duration: element.duration }), { once: true });
      element.addEventListener('error', () => resolve({ ok: false, code: element.error && element.error.code }), { once: true });
      setTimeout(() => resolve({ ok: false, code: 'timeout', readyState: element.readyState }), 10000);
    });
  });
  runner.check('offline audio loads metadata', () => {
    assert.ok(audio.ok, `menu music did not load offline (${JSON.stringify(audio)})`);
    assert.ok(audio.duration > 1, `menu music reported a ${audio.duration}s duration offline`);
  });

  // Finally: a whole game, start to completion dialog, with no network.
  await page.evaluate(() => window.__deja.showScreen('menu'));
  await startBoard(page, 'easy');
  const offlineBoard = await page.evaluate(() => ({
    artDialog: document.querySelector('#art-dialog').open,
    sides: document.querySelectorAll('#card-grid .card-side').length,
    painted: [...document.querySelectorAll('#card-grid .card-side')]
      .filter((side) => side.dataset.spritePainted && side.querySelector('canvas')?.width > 0).length,
  }));
  runner.check('offline board shows its card art', () => {
    assert.equal(offlineBoard.artDialog, false, 'the card-art dialog opened offline');
    assert.equal(offlineBoard.painted, offlineBoard.sides, `${offlineBoard.painted} of ${offlineBoard.sides} sides painted offline`);
  });
  await page.waitForFunction(
    () => !document.querySelector('#card-grid').classList.contains('is-previewing'),
    null,
    { timeout: 20000 },
  );
  const pairs = await page.evaluate(() => {
    const groups = new Map();
    document.querySelectorAll('.memory-card').forEach((card, index) => {
      const key = card.querySelector('.card-side-front').getAttribute('style');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    return [...groups.values()];
  });
  runner.check('offline board dealt', () => {
    assert.equal(pairs.length, 6, `easy board dealt ${pairs.length} pairs offline`);
  });
  for (const pair of pairs) {
    for (const index of pair) {
      await page.evaluate((i) => document.querySelector(`.memory-card[data-index="${i}"]`)?.click(), index);
      await page.waitForTimeout(180);
    }
    await page.waitForTimeout(420);
  }
  await page.waitForFunction(() => document.querySelector('#complete-dialog').open, null, { timeout: 15000 })
    .catch(() => {});
  const completion = await page.evaluate(() => ({
    open: document.querySelector('#complete-dialog').open,
    grade: document.querySelector('#complete-grade').textContent.trim(),
    score: document.querySelector('#complete-score').textContent.trim(),
    matched: document.querySelectorAll('.memory-card.is-matched').length,
  }));
  runner.check('offline game completes', () => {
    assert.ok(completion.open, 'the completion dialog never opened after clearing the board offline');
    assert.equal(completion.matched, 12, `only ${completion.matched} of 12 cards matched offline`);
    assert.ok(completion.grade.length > 0, 'completion dialog rendered without a rating');
    assert.ok(Number(completion.score.replace(/,/g, '')) > 0, `completion score was "${completion.score}"`);
  });
  await auditView(runner, page, 'offline complete dialog', DIALOG_ESSENTIALS['complete-dialog']);

  const networkErrors = consoleErrors.filter((text) => /Failed to load|net::ERR|ERR_INTERNET/.test(text));
  runner.check('offline run made no failed network requests', () => {
    assert.deepEqual(
      networkErrors.filter((text) => !/ERR_ABORTED/.test(text)),
      [],
      `offline run logged network failures:\n${networkErrors.join('\n')}`,
    );
  });

  await context.close();
}

// ---------------------------------------------------------------- sprites ---

// Phones at 2x, 3x and past the 3x cap, desktop at 1x and 150% zoom: the
// bitmap has to follow the card's real pixel size on each.
const SPRITE_PROFILES = [
  { name: 'phone 390x844@3x', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'phone 320x568@2x', viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'phone 412x915@4x', viewport: { width: 412, height: 915 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true },
  { name: 'desktop 1440x900@1x', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'desktop 1280x720@150%', viewport: { width: 853, height: 480 }, deviceScaleFactor: 1.5 },
];
// Room for resampling to move a threshold edge by a pixel or so. A cut border
// or a neighbouring frame is several pixels on the larger bitmaps, and the
// atlas checks pin the rectangles themselves at full source resolution.
const SPRITE_EDGE_TOLERANCE = 2;
// Mean premultiplied difference from the old fixed 600x775 bitmap scaled down,
// out of 255. Measured at up to ~5.5 for one resample instead of two; a moved
// or missing inset, a different crop or the wrong sprite is far above it.
const SPRITE_LEGACY_TOLERANCE = 8;

async function spritePage(browser, baseUrl, profile, { atlasDelayMs = 0 } = {}) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: !!profile.isMobile,
    hasTouch: !!profile.hasTouch,
    // page.route() cannot see requests a service worker answers.
    serviceWorkers: 'block',
  });
  await context.addInitScript({ path: SPRITE_PROBES_PATH });
  await context.addInitScript({ path: PROBES_PATH });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  const errors = [];
  // Blocking the worker is this suite's choice, not an app error: Playwright
  // logs it and resolves register() without a registration.
  const blockedWorker = /Service Worker registration blocked|reading 'scope'/;
  page.on('pageerror', (error) => {
    if (!blockedWorker.test(String(error))) errors.push(String(error));
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !blockedWorker.test(message.text())) errors.push(message.text());
  });
  if (atlasDelayMs) {
    await page.route('**/card-flip-sprite-sheet.png', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, atlasDelayMs));
      await route.continue();
    });
  }
  await page.goto(baseUrl, { waitUntil: atlasDelayMs ? 'domcontentloaded' : 'load' });
  if (!atlasDelayMs) await page.waitForTimeout(300);
  await page.evaluate(() => window.__deja.showScreen('menu'));
  return { context, page, errors };
}

/** Waits past the resize settle delay so any repaint has happened. */
async function spritesSettled(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);
}

function sideLabel(side) {
  return `side ${side.index} (${side.side}, ${side.sprite})`;
}

function assertBoardSprites(runner, label, sides, cardCount) {
  runner.check(`${label} — every card has both sides`, () => {
    assert.equal(sides.length, cardCount * 2, `${sides.length} sides for ${cardCount} cards`);
  });
  // Pixel checks run on the sides that have pixels; the first and last
  // checks report the ones that do not.
  const inspected = sides.filter((side) => side.vsDirect);
  const none = (name, list, predicate, describe) => runner.check(`${label} — ${name}`, () => {
    const failed = list.filter(predicate).map((side) => `${sideLabel(side)}: ${describe(side)}`);
    assert.deepEqual(failed.slice(0, 6), [], `${failed.length} of ${list.length} sides failed`);
  });

  none('one canvas per side, painted with the dealt sprite', sides,
    (side) => side.canvasCount !== 1 || !side.width || side.paintedAs !== side.expectedKey,
    (side) => `${side.canvasCount} canvases, ${side.width}x${side.height}, painted "${side.paintedAs}", dealt "${side.expectedKey}"`);
  none('bitmap matches the card box at the capped pixel ratio', sides,
    (side) => Math.abs(side.width - side.expectedWidth) > 1 || Math.abs(side.height - side.expectedHeight) > 1
      || side.width > 600 || side.height > 775,
    (side) => `${side.width}x${side.height}, expected ${side.expectedWidth}x${side.expectedHeight} for ${side.cssWidth.toFixed(1)}x${side.cssHeight.toFixed(1)} CSS px`);
  none('nothing painted outside the padded crop or on the bitmap edge', inspected,
    (side) => side.outsideAlpha > 0 || side.edgeAlpha > 0,
    (side) => `alpha ${side.outsideAlpha} outside the crop, ${side.edgeAlpha} on the edge`);
  none('visible extent matches the sprite in the sheet (complete border, no neighbour)', inspected,
    (side) => !side.drawn || !side.expected || ['left', 'top', 'right', 'bottom'].some(
      (edge) => Math.abs(side.drawn[edge] - side.expected[edge]) > SPRITE_EDGE_TOLERANCE,
    ),
    (side) => `drawn ${JSON.stringify(side.drawn)}, expected ${JSON.stringify(side.expected && Object.fromEntries(
      Object.entries(side.expected).map(([key, value]) => [key, Number(value.toFixed(1))]),
    ))}`);
  none('pixels equal a direct render of the measured crop', inspected,
    (side) => side.vsDirect.mean > 0.5,
    (side) => `mean difference ${side.vsDirect.mean.toFixed(2)}, max ${side.vsDirect.max}`);
  none('pixels stay close to the old fixed-size render', inspected,
    (side) => side.vsLegacy.mean > SPRITE_LEGACY_TOLERANCE,
    (side) => `mean difference ${side.vsLegacy.mean.toFixed(2)} from the 600x775 render`);
  runner.check(`${label} — every side inspected`, () => {
    assert.equal(inspected.length, sides.length, `${sides.length - inspected.length} sides had no bitmap to inspect`);
  });
}

async function auditSprites(runner, browser, baseUrl) {
  // The measured rectangles themselves, against the PNG that ships.
  runner.group('sprites/atlas');
  {
    const { context, page } = await spritePage(browser, baseUrl, SPRITE_PROFILES[3]);
    const contract = await page.evaluate(() => window.__sprites.atlasContract());
    runner.check('atlas — 17 faces and the back are measured', () => {
      assert.equal(contract.length, 18, `${contract.length} measured sprites`);
    });
    for (const sprite of contract) {
      runner.check(`atlas — ${sprite.name} crop is complete and its own`, () => {
        assert.ok(sprite.insideSheet, `${sprite.name} rectangle leaves the sheet`);
        assert.ok(sprite.maxAlphaOutsideCrop <= 2, `${sprite.name} has alpha ${sprite.maxAlphaOutsideCrop} just outside its padded crop: the crop cuts the sprite`);
        assert.deepEqual(sprite.overlaps, [], `${sprite.name} crop overlaps ${sprite.overlaps.join(', ')}`);
        assert.ok(
          sprite.slack && Object.values(sprite.slack).every((gap) => gap <= 1),
          `${sprite.name} rectangle has empty space inside its edges ${JSON.stringify(sprite.slack)}: it no longer fits the art`,
        );
      });
    }
    await context.close();
  }

  // Crop accuracy on every board, at every pixel ratio.
  for (const profile of SPRITE_PROFILES) {
    runner.group(`sprites/${profile.name}`);
    const { context, page, errors } = await spritePage(browser, baseUrl, profile);
    for (const difficulty of DIFFICULTIES) {
      await startBoard(page, difficulty);
      await spritesSettled(page);
      const cardCount = await page.evaluate(() => document.querySelectorAll('#card-grid .memory-card').length);
      const sides = await page.evaluate(() => window.__sprites.inspectBoard());
      assertBoardSprites(runner, `${profile.name} ${difficulty}`, sides, cardCount);
    }
    await page.evaluate(() => window.__deja.showScreen('help'));
    await spritesSettled(page);
    const demo = await page.evaluate(() => [...document.querySelectorAll('.sprite-demo .sprite-card')].map((side) => ({
      painted: side.dataset.spritePainted || '',
      width: side.querySelector('canvas')?.width || 0,
      expected: Math.round(Number.parseFloat(getComputedStyle(side).width) * Math.min(devicePixelRatio, 3)),
    })));
    runner.check(`${profile.name} — help demo painted at its own size`, () => {
      assert.deepEqual(demo.map((side) => side.painted), ['2:3', '3:1'], 'help demo shows the wrong sprites');
      demo.forEach((side) => assert.ok(Math.abs(side.width - side.expected) <= 1, `demo bitmap ${side.width} px wide, expected ${side.expected}`));
    });
    const reported = [...errors, ...await page.evaluate(() => window.__sprites.errors())];
    runner.check(`${profile.name} — no errors`, () => assert.deepEqual(reported, []));
    await context.close();
  }

  // Repeated new games: each side painted once, crops reused, old boards
  // released straight away, nothing repainting on its own afterwards.
  for (const profile of [SPRITE_PROFILES[0], SPRITE_PROFILES[3]]) {
    const label = `${profile.name} repeated games`;
    runner.group(`sprites/${label}`);
    const { context, page, errors } = await spritePage(browser, baseUrl, profile);
    const cached = new Set();
    const sequence = ['insane', 'insane', 'insane', 'insane', 'insane', 'easy', 'intermediate', 'advanced', 'insane', 'easy', 'insane'];
    for (const [round, difficulty] of sequence.entries()) {
      await page.evaluate(() => {
        window.__previousBoard = [...document.querySelectorAll('#card-grid canvas')];
        window.__sprites.takeCounts();
      });
      await startBoard(page, difficulty);
      await spritesSettled(page);
      const sides = await page.evaluate(() => window.__sprites.inspectBoard());
      const counts = await page.evaluate(() => window.__sprites.takeCounts());
      const previous = await page.evaluate(() => window.__previousBoard
        .filter((canvas) => canvas.isConnected || canvas.width || canvas.height).length);
      const fresh = new Set(sides.map((side) => `${side.expectedKey}@${side.width}x${side.height}`).filter((key) => !cached.has(key)));
      fresh.forEach((key) => cached.add(key));
      const step = `${label} #${round + 1} ${difficulty}`;

      runner.check(`${step} — each side painted exactly once`, () => {
        assert.equal(counts.canvasDraws, sides.length, `${counts.canvasDraws} side paints for ${sides.length} sides`);
      });
      runner.check(`${step} — sheet resampled only for crops not cached yet`, () => {
        assert.equal(counts.atlasDraws, fresh.size, `${counts.atlasDraws} sheet draws, ${fresh.size} new sprite sizes`);
      });
      runner.check(`${step} — previous board's bitmaps released`, () => {
        assert.equal(previous, 0, `${previous} canvases from the replaced board still hold a bitmap or stay attached`);
      });
      runner.check(`${step} — board painted correctly`, () => {
        const wrong = sides.filter((side) => !side.width || side.paintedAs !== side.expectedKey);
        assert.equal(wrong.length, 0, `${wrong.length} sides unpainted or showing the wrong sprite`);
      });

      // Card state changes the way play makes them must not reach the sprite code.
      await page.evaluate(() => {
        document.querySelectorAll('#card-grid .memory-card').forEach((card, index) => {
          card.classList.toggle('is-flipped');
          card.setAttribute('aria-label', `probe ${index}`);
          card.setAttribute('aria-pressed', 'true');
        });
      });
      await spritesSettled(page);
      const idle = await page.evaluate(() => window.__sprites.takeCounts());
      runner.check(`${step} — no repaint afterwards (no observer feedback)`, () => {
        assert.deepEqual(idle, { atlasDraws: 0, canvasDraws: 0 }, 'sprites repainted with nothing changed');
      });
    }
    const memory = await page.evaluate(() => window.__sprites.canvases());
    runner.check(`${label} — off-page canvas memory stays within the crop cache bound`, () => {
      assert.ok(memory.detached <= 64, `${memory.detached} off-page canvases hold bitmaps`);
      assert.ok(memory.detachedBytes <= 16 * 1024 * 1024, `${(memory.detachedBytes / 1048576).toFixed(1)} MB off-page`);
    });
    runner.check(`${label} — only the board and nothing else on the page holds bitmaps`, () => {
      assert.ok(memory.attached <= 60, `${memory.attached} attached canvases hold bitmaps after ${sequence.length} boards`);
    });
    const reported = [...errors, ...await page.evaluate(() => window.__sprites.errors())];
    runner.check(`${label} — no errors`, () => assert.deepEqual(reported, []));
    await context.close();
  }

  // Resizes and pixel-ratio changes repaint at the new size once settled, and
  // the crop cache stays bounded however many sizes go through it.
  {
    const profile = SPRITE_PROFILES[3];
    const label = 'desktop resize';
    runner.group(`sprites/${label}`);
    const { context, page, errors } = await spritePage(browser, baseUrl, profile);
    await startBoard(page, 'insane');
    await spritesSettled(page);
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }, { width: 1366, height: 768 }]) {
      await page.evaluate(() => window.__sprites.takeCounts());
      await page.setViewportSize(viewport);
      await spritesSettled(page);
      const sides = await page.evaluate(() => window.__sprites.inspectBoard());
      assertBoardSprites(runner, `${label} to ${viewport.width}x${viewport.height}`, sides, 30);
      const counts = await page.evaluate(() => window.__sprites.takeCounts());
      runner.check(`${label} to ${viewport.width}x${viewport.height} — each side repainted at most once`, () => {
        assert.ok(counts.canvasDraws <= sides.length, `${counts.canvasDraws} side paints for ${sides.length} sides`);
      });
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 2, mobile: false });
    await spritesSettled(page);
    assertBoardSprites(runner, `${label} to 2x pixel ratio`, await page.evaluate(() => window.__sprites.inspectBoard()), 30);
    for (const difficulty of DIFFICULTIES) {
      for (const viewport of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }]) {
        await page.setViewportSize(viewport);
        await startBoard(page, difficulty);
      }
    }
    await spritesSettled(page);
    const memory = await page.evaluate(() => window.__sprites.canvases());
    runner.check(`${label} — crop cache bounded across many sizes`, () => {
      assert.ok(memory.detached <= 64, `${memory.detached} off-page canvases hold bitmaps`);
      assert.ok(memory.detachedBytes <= 16 * 1024 * 1024, `${(memory.detachedBytes / 1048576).toFixed(1)} MB off-page`);
    });
    const reported = [...errors, ...await page.evaluate(() => window.__sprites.errors())];
    runner.check(`${label} — no errors`, () => assert.deepEqual(reported, []));
    await context.close();
  }

  // Cards replaced while the sheet is still downloading leave nothing behind:
  // only the board on screen gets painted once it arrives. Play itself cannot
  // start a board before the art (the loading suite covers that), so these
  // stale boards are rendered straight into the grid the way index.js does.
  {
    const label = 'slow sheet';
    runner.group(`sprites/${label}`);
    const { context, page, errors } = await spritePage(browser, baseUrl, SPRITE_PROFILES[0], { atlasDelayMs: 2500 });
    await page.evaluate(() => window.__deja.showScreen('game'));
    for (let board = 0; board < 4; board += 1) {
      await page.evaluate((offset) => {
        const grid = document.querySelector('#card-grid');
        grid.style.setProperty('--cols', '5');
        grid.setAttribute('aria-rowcount', '6');
        grid.setAttribute('aria-colcount', '5');
        grid.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
          const face = (index + offset) % 15;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'memory-card';
          button.innerHTML = `
            <span class="memory-card-inner" aria-hidden="true">
              <span class="card-side card-side-back"></span>
              <span class="card-side card-side-front" style="--sprite-x:${(face % 5) * 25}%;--sprite-y:${Math.floor(face / 5) * 33.333333}%"></span>
            </span>`;
          return button;
        }));
      }, board);
      // Let each board be laid out and sized, as a real one would be.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const early = await page.evaluate(() => ({ counts: window.__sprites.takeCounts(), canvases: window.__sprites.canvases() }));
    runner.check(`${label} — nothing painted before the sheet arrives`, () => {
      assert.equal(early.counts.atlasDraws + early.counts.canvasDraws, 0, 'sides painted without the sheet');
      assert.equal(early.canvases.attached + early.canvases.detached, 0, 'bitmaps allocated before the sheet arrived');
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('#card-grid .card-side')].every((side) => side.dataset.spritePainted),
      null,
      { timeout: 15000 },
    );
    await spritesSettled(page);
    const counts = await page.evaluate(() => window.__sprites.takeCounts());
    const memory = await page.evaluate(() => window.__sprites.canvases());
    runner.check(`${label} — only the current board is painted`, () => {
      assert.equal(counts.canvasDraws, 60, `${counts.canvasDraws} side paints; replaced boards were still pending`);
      assert.equal(memory.attached, 60, `${memory.attached} attached bitmaps`);
    });
    assertBoardSprites(runner, label, await page.evaluate(() => window.__sprites.inspectBoard()), 30);
    const reported = [...errors, ...await page.evaluate(() => window.__sprites.errors())];
    runner.check(`${label} — no errors`, () => assert.deepEqual(reported, []));
    await context.close();
  }
}

// ---------------------------------------------------------------- loading ---

const SHEET_FILE = 'card-flip-sprite-sheet.png';
// A valid PNG with no art in it: one transparent pixel.
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg==', 'base64');
const ART_ESSENTIALS = ['#art-title', '#art-message', '.dialog-cancel'];
const LOADING_PROFILES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  smallPhone: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  zoomedDesktop: { viewport: { width: 853, height: 480 }, deviceScaleFactor: 1.5 },
};

/**
 * A page whose sprite-sheet responses the test controls. `sheet.mode` is read
 * when each request arrives — 'pass', 'delay', 'fail' (404), 'abort' (network
 * error), 'truncated' or 'blank' — so a test can let a retry through.
 */
// Records, on the page's own clock, when media first starts loading and when
// the worker is registered, to compare with the sheet's Resource Timing.
function recordLoadOrder() {
  window.__loadOrder = { media: [], registered: 0, precache: null };
  const { load, play } = HTMLMediaElement.prototype;
  HTMLMediaElement.prototype.load = function recordedLoad(...args) {
    window.__loadOrder.media.push(performance.now());
    return load.apply(this, args);
  };
  HTMLMediaElement.prototype.play = function recordedPlay(...args) {
    window.__loadOrder.media.push(performance.now());
    return play.apply(this, args);
  };
  const container = navigator.serviceWorker;
  if (!container) return;
  const register = container.register.bind(container);
  container.register = (...args) => {
    window.__loadOrder.registered = performance.now();
    return register(...args);
  };
  container.addEventListener('message', (event) => {
    if (event.data?.type === 'DEJA_VU_PRECACHE') window.__loadOrder.precache = event.data;
  });
}

async function sheetPage(browser, baseUrl, profile, { mode = 'pass', delayMs = 0, workers = false, seed = null } = {}) {
  const context = await browser.newContext({ ...profile, serviceWorkers: workers ? 'allow' : 'block' });
  await context.addInitScript(recordLoadOrder);
  await context.addInitScript({ path: PROBES_PATH });
  if (seed) await context.addInitScript(seed);
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  const sheet = { mode, delayMs, requests: 0, finishedAt: 0 };
  const truncated = (await readFile(path.join(distDirectory, SHEET_FILE))).subarray(0, 4096);
  await page.route(`**/${SHEET_FILE}*`, async (route) => {
    sheet.requests += 1;
    const current = sheet.mode;
    if (current === 'delay') await new Promise((resolve) => setTimeout(resolve, sheet.delayMs).unref());
    try {
      if (current === 'fail') await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
      else if (current === 'abort') await route.abort('internetdisconnected');
      else if (current === 'truncated') await route.fulfill({ status: 200, contentType: 'image/png', body: truncated });
      else if (current === 'blank') await route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG });
      else await route.continue();
    } catch (_) {
      // The page abandoned this request, e.g. a retry replaced it.
    }
  });
  const log = { music: 0, console: [] };
  page.on('requestfinished', (request) => {
    if (request.url().includes(SHEET_FILE)) sheet.finishedAt = Date.now();
  });
  page.on('request', (request) => {
    if (/\.mp3$/i.test(decodeURIComponent(new URL(request.url()).pathname))) log.music += 1;
  });
  page.on('console', (message) => log.console.push(`${message.type()}: ${message.text()}`));
  return { context, page, sheet, log };
}

function loadingState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('#art-dialog');
    const sides = [...document.querySelectorAll('#card-grid .card-side')];
    return {
      dialog: dialog.open ? dialog.dataset.state : null,
      retryVisible: !document.querySelector('#btn-art-retry').hidden,
      focused: document.activeElement?.id || document.activeElement?.className || '',
      message: document.querySelector('#art-message').textContent,
      screen: document.querySelector('.screen.is-active')?.id || '',
      difficultyOpen: document.querySelector('#difficulty-dialog').open,
      cards: document.querySelectorAll('#card-grid .memory-card').length,
      sides: sides.length,
      painted: sides.filter((side) => side.dataset.spritePainted && side.querySelector('canvas')?.width > 0).length,
      gameMessage: document.querySelector('#game-message').textContent,
      previewing: Boolean(window.DEJA_VU_PREVIEW_ACTIVE),
      clock: document.querySelector('#stat-time').textContent,
      played: JSON.parse(localStorage.getItem('inspireDejaVu:v1:statistics') || '{}').played || 0,
    };
  });
}

/** Waits until the app's own card-art loader reports `state`. */
async function waitForArtState(page, state, timeout = 10000) {
  // waitForFunction would take an async predicate's promise as truthy, so the
  // module is fetched once (the app's own instance) and then polled directly.
  await page.evaluate(async () => {
    window.__cardArt = await import('./sprite-atlas.js');
  });
  await page.waitForFunction((expected) => window.__cardArt.cardArtState() === expected, state, { timeout });
}

async function pickDifficulty(page, difficulty) {
  await page.evaluate(() => window.__deja.openDialog('difficulty-dialog'));
  await page.evaluate((value) => document.querySelector(`[data-difficulty="${value}"]`).click(), difficulty);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Waits for a board to be on screen, then reads it before anything else runs. */
async function boardWhenStarted(page, timeout = 15000) {
  await page.waitForFunction(
    () => document.querySelector('#screen-game').classList.contains('is-active')
      && document.querySelectorAll('#card-grid .memory-card').length > 0,
    null,
    { timeout, polling: 'raf' },
  );
  return loadingState(page);
}

function assertNothingStarted(runner, label, state, playedBefore) {
  runner.check(`${label} — no board, clock or preview while the art is missing`, () => {
    assert.equal(state.screen, 'screen-menu', `moved to ${state.screen}`);
    assert.equal(state.cards, 0, `${state.cards} cards dealt`);
    assert.equal(state.previewing, false, 'the memorize preview started');
    assert.equal(state.played, playedBefore, 'the game was counted as played');
  });
}

function assertStartedWithArt(runner, label, state, { cards, memorizeSeconds = null }) {
  runner.check(`${label} — board starts with every side painted`, () => {
    assert.equal(state.dialog, null, `the card-art dialog is still open (${state.dialog})`);
    assert.equal(state.cards, cards, `${state.cards} cards`);
    assert.equal(state.painted, state.sides, `${state.painted} of ${state.sides} sides painted when the board appeared`);
  });
  if (memorizeSeconds !== null) {
    runner.check(`${label} — memorize preview starts only once the art is shown`, () => {
      assert.ok(state.previewing, 'no preview');
      assert.equal(state.gameMessage, `Memorize the board — ${memorizeSeconds}`, 'the preview ran while the art was loading');
    });
  }
}

// A scenario whose behaviour regressed usually fails as a wait that times
// out. That is recorded as the scenario's failure, its pages are closed, and
// the run carries on, so one regression does not hide the rest.
async function loadingScenario(runner, label, body) {
  runner.group(`loading/${label}`);
  const contexts = [];
  try {
    await body(contexts);
  } catch (error) {
    runner.check(`${label} — runs to completion`, () => {
      throw new Error(String(error?.message || error).split('\n')[0]);
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  }
}

async function auditLoading(runner, browser, baseUrl) {
  // Cold cache: a first visit with nothing stored. The sheet is fetched once
  // (the preload and the drawing code share it), first; music and the worker
  // follow it; the worker's precache then holds it for offline play.
  for (const name of ['phone', 'desktop']) {
    const label = `cold cache ${name}`;
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page, sheet } = await sheetPage(browser, baseUrl, LOADING_PROFILES[name], { workers: true });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'load' });
      await waitForArtState(page, 'ready');
      await page.evaluate(() => window.__deja.showScreen('menu'));
      await pickDifficulty(page, 'insane');
      const state = await boardWhenStarted(page);
      assertStartedWithArt(runner, label, state, { cards: 30, memorizeSeconds: 8 });
      runner.check(`${label} — sheet requested once`, () => {
        assert.equal(sheet.requests, 1, `${sheet.requests} page requests for the sheet: the preload was not reused`);
      });
      await page.waitForFunction(() => window.__loadOrder.registered > 0, null, { timeout: 15000 });
      const order = await page.evaluate(() => ({
        ...window.__loadOrder,
        sheetEnd: performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('card-flip-sprite-sheet.png'))
          .reduce((latest, entry) => Math.max(latest, entry.responseEnd), 0),
      }));
      runner.check(`${label} — music and the worker wait for the sheet`, () => {
        assert.ok(order.sheetEnd > 0, 'no Resource Timing entry for the sheet');
        assert.ok(order.media.length > 0, 'music never started loading');
        assert.ok(order.media.every((at) => at >= order.sheetEnd), 'music started loading before the sheet arrived');
        assert.ok(order.registered >= order.sheetEnd, 'the worker registered before the sheet arrived');
      });
      const cached = await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        const names = await caches.keys();
        const shell = names.find((key) => key.startsWith('deja-vu-'));
        return Boolean(shell && await (await caches.open(shell)).match('./card-flip-sprite-sheet.png'));
      });
      runner.check(`${label} — the installed worker holds the sheet`, () => assert.ok(cached, 'sheet missing from the precache'));
    });
  }

  // The first gesture still unlocks music and starts the intro while the
  // sheet is held back: deferral never costs the unlock.
  {
    const label = 'first gesture during a slow sheet';
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page, sheet, log } = await sheetPage(browser, baseUrl, LOADING_PROFILES.phone, { mode: 'delay', delayMs: 4000 });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);
      const musicBefore = log.music;
      await page.click('#screen-start');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        screen: document.querySelector('.screen.is-active')?.id,
        introPlaying: !document.querySelector('#intro-video').paused,
      }));
      runner.check(`${label} — intro starts`, () => {
        assert.ok(['screen-intro', 'screen-menu'].includes(after.screen), `landed on ${after.screen}`);
      });
      runner.check(`${label} — music unlock requests both loops`, () => {
        assert.equal(musicBefore, 0, 'music was requested before the gesture and before the sheet');
        assert.ok(log.music >= 2, `${log.music} music requests after the gesture`);
        assert.equal(sheet.finishedAt, 0, 'the sheet had already arrived, so this proved nothing');
      });
    });
  }

  // Slow network: the start waits behind the loading dialog, then the board
  // arrives painted with its full memorize time.
  for (const name of ['smallPhone', 'zoomedDesktop']) {
    const label = `slow sheet ${name}`;
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page } = await sheetPage(browser, baseUrl, LOADING_PROFILES[name], { mode: 'delay', delayMs: 3000 });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => window.__deja.showScreen('menu'));
      await pickDifficulty(page, 'insane');
      const waiting = await loadingState(page);
      runner.check(`${label} — loading dialog shown`, () => {
        assert.equal(waiting.dialog, 'loading');
        assert.equal(waiting.retryVisible, false, 'retry offered before anything failed');
      });
      assertNothingStarted(runner, label, waiting, 0);
      await auditView(runner, page, `${label} loading dialog`, ART_ESSENTIALS,
        name === 'zoomedDesktop' ? DESKTOP_MUST_FIT : {});
      const state = await boardWhenStarted(page);
      assertStartedWithArt(runner, label, state, { cards: 30, memorizeSeconds: 8 });
      runner.check(`${label} — counted once`, () => assert.equal(state.played, 1));
    });
  }

  // A sheet that hangs: after a while the dialog offers a retry, and the
  // retry, not the stalled request, starts the board.
  {
    const label = 'stalled sheet';
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page, sheet } = await sheetPage(browser, baseUrl, LOADING_PROFILES.desktop, { mode: 'delay', delayMs: 30000 });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => window.__deja.showScreen('menu'));
      await pickDifficulty(page, 'easy');
      await page.waitForFunction(() => document.querySelector('#art-dialog').dataset.state === 'slow', null, { timeout: 20000 });
      const slow = await loadingState(page);
      runner.check(`${label} — offers a retry while still waiting`, () => {
        assert.equal(slow.dialog, 'slow');
        assert.ok(slow.retryVisible, 'no retry button');
        assert.equal(slow.focused, 'btn-art-retry', `focus on ${slow.focused}`);
      });
      sheet.mode = 'pass';
      await page.click('#btn-art-retry');
      const state = await boardWhenStarted(page);
      assertStartedWithArt(runner, label, state, { cards: 12, memorizeSeconds: 4 });
      runner.check(`${label} — one board, counted once`, () => assert.equal(state.played, 1));
    });
  }

  // Navigation during loading: Escape and Cancel back out to the picker, and
  // a sheet arriving afterwards starts nothing.
  {
    const label = 'cancelled while loading';
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page } = await sheetPage(browser, baseUrl, LOADING_PROFILES.phone, { mode: 'delay', delayMs: 4000 });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      // The real way in, so key handling sees the menu as the current screen.
      await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);
      await page.click('#screen-start');
      // The fixture intro lasts 0.2 s and hands over to the menu by itself.
      await page.waitForFunction(() => document.querySelector('#screen-menu').classList.contains('is-active'), null, { timeout: 10000 });
      await page.click('#btn-new-game');
      await page.click('[data-difficulty="easy"]');
      await page.keyboard.press('Escape');
      const escaped = await loadingState(page);
      runner.check(`${label} — Escape closes only the loading dialog`, () => {
        assert.equal(escaped.dialog, null);
        assert.ok(escaped.difficultyOpen, 'the difficulty picker closed too');
      });
      await page.click('[data-difficulty="insane"]');
      await page.click('#art-dialog .dialog-cancel');
      const cancelled = await loadingState(page);
      runner.check(`${label} — Cancel returns to the picker`, () => {
        assert.equal(cancelled.dialog, null);
        assert.ok(cancelled.difficultyOpen, 'the difficulty picker closed too');
      });
      await page.click('#difficulty-dialog .dialog-cancel');
      await waitForArtState(page, 'ready');
      await page.waitForTimeout(300);
      const later = await loadingState(page);
      assertNothingStarted(runner, `${label}, after the sheet arrived`, later, 0);
      await pickDifficulty(page, 'easy');
      const state = await loadingState(page);
      runner.check(`${label} — a later start needs no dialog`, () => {
        assert.equal(state.screen, 'screen-game', JSON.stringify(state));
        assert.equal(state.dialog, null);
        assert.equal(state.painted, 24, `${state.painted} of 24 sides painted`);
      });
    });
  }

  // Continue waits the same way, and resumes without a preview.
  {
    const label = 'continue while loading';
    await loadingScenario(runner, label, async (contexts) => {
      const seed = () => {
        const deck = [];
        for (let pattern = 0; pattern < 6; pattern += 1) {
          deck.push({ uid: `a${pattern}`, pattern, matched: false }, { uid: `b${pattern}`, pattern, matched: false });
        }
        localStorage.setItem('inspireDejaVu:v1:activeGame', JSON.stringify({
          version: 1, active: true, difficulty: 'easy', deck, open: [], matchedPairs: 0, moves: 3,
          mistakes: 1, elapsed: 42, paused: false, locked: false, turn: 'idle', completed: false, sessionId: '', turnId: 0,
        }));
      };
      const { context, page } = await sheetPage(browser, baseUrl, LOADING_PROFILES.phone, { mode: 'delay', delayMs: 2500, seed });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => window.__deja.showScreen('menu'));
      await page.evaluate(() => document.querySelector('#btn-continue').click());
      const waiting = await loadingState(page);
      runner.check(`${label} — waits behind the loading dialog`, () => {
        assert.equal(waiting.dialog, 'loading');
        assert.equal(waiting.screen, 'screen-menu');
      });
      const state = await boardWhenStarted(page);
      assertStartedWithArt(runner, label, state, { cards: 12 });
      runner.check(`${label} — resumes the saved clock without a preview`, () => {
        assert.equal(state.previewing, false, 'a resumed board replayed the memorize preview');
        assert.match(state.clock, /^00:4[23]$/, `clock shows ${state.clock}`);
      });
    });
  }

  // Missing, unreachable and undecodable sheets: a retry state, never an
  // invisible board, and a retry that works once the sheet is back.
  for (const [mode, name] of [['fail', 'smallPhone'], ['abort', 'phone'], ['truncated', 'desktop'], ['blank', 'zoomedDesktop']]) {
    const label = `sheet ${mode}`;
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page, sheet, log } = await sheetPage(browser, baseUrl, LOADING_PROFILES[name], { mode });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'load' });
      await waitForArtState(page, 'failed');
      await page.evaluate(() => window.__deja.showScreen('menu'));
      await pickDifficulty(page, 'insane');
      const failed = await loadingState(page);
      runner.check(`${label} — failure dialog with retry focused`, () => {
        assert.equal(failed.dialog, 'failed');
        assert.ok(failed.retryVisible, 'no retry button');
        assert.equal(failed.focused, 'btn-art-retry', `focus on ${failed.focused}`);
      });
      assertNothingStarted(runner, label, failed, 0);
      await auditView(runner, page, `${label} failure dialog`, [...ART_ESSENTIALS, '#btn-art-retry'],
        name.endsWith('esktop') ? DESKTOP_MUST_FIT : {});
      runner.check(`${label} — reported in the console`, () => {
        assert.ok(log.console.some((line) => /\[DEJA VU\] the card sprite sheet (failed to load|did not decode)/.test(line)),
          'no console report of the failure');
      });
      sheet.mode = 'pass';
      await page.click('#btn-art-retry');
      const state = await boardWhenStarted(page);
      assertStartedWithArt(runner, `${label} then retry`, state, { cards: 30, memorizeSeconds: 8 });
    });
  }

  // Offline with nothing saved: the failure says so.
  {
    const label = 'offline first visit';
    await loadingScenario(runner, label, async (contexts) => {
      const { context, page } = await sheetPage(browser, baseUrl, LOADING_PROFILES.phone, { mode: 'abort' });
      contexts.push(context);
      await page.goto(baseUrl, { waitUntil: 'load' });
      await context.setOffline(true);
      await page.evaluate(() => window.__deja.showScreen('menu'));
      await pickDifficulty(page, 'easy');
      const state = await loadingState(page);
      runner.check(`${label} — failure explains being offline`, () => {
        assert.equal(state.dialog, 'failed');
        assert.match(state.message, /offline/i);
      });
    });
  }

  // Honest offline readiness: a deploy missing the sheet never installs a
  // worker, so it never claims to work offline without its cards.
  {
    const label = 'deploy missing the sheet';
    await loadingScenario(runner, label, async (contexts) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'deja-vu-no-sheet-'));
      await cp(distDirectory, directory, { recursive: true });
      await rm(path.join(directory, SHEET_FILE));
      const broken = await startServer({ directory });
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        contexts.push(context);
        await context.addInitScript(recordLoadOrder);
        const page = await context.newPage();
        await page.goto(broken.baseUrl, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__loadOrder.precache, null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(500);
        const worker = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return {
            report: window.__loadOrder.precache,
            active: Boolean(registration?.active),
            controlled: Boolean(navigator.serviceWorker.controller),
          };
        });
        runner.check(`${label} — install fails loudly, naming the sheet`, () => {
          assert.equal(worker.report?.reason, 'install-failed', `worker reported ${JSON.stringify(worker.report)}`);
          assert.ok(worker.report.failures.some((failure) => failure.path === `./${SHEET_FILE}`), 'the sheet is not among the failures');
        });
        runner.check(`${label} — no worker is activated`, () => {
          assert.equal(worker.active, false, 'a worker activated without the card art');
          assert.equal(worker.controlled, false, 'the page is controlled by a worker without the card art');
        });
      } finally {
        await broken.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

// ------------------------------------------------------------------- main ---

async function main() {
  if (process.env.DEJA_VU_SKIP_BROWSER_TESTS === '1') {
    console.log('Browser regression suite: SKIPPED (DEJA_VU_SKIP_BROWSER_TESTS=1)');
    console.log('  Rendered layout and offline behavior were NOT verified.');
    return;
  }

  const executablePath = resolveChromium(chromium);
  if (!executablePath) {
    console.error(missingBrowserMessage());
    process.exitCode = 1;
    return;
  }

  const runner = createRunner();
  const server = await startServer();
  const browser = await chromium.launch({ executablePath });
  try {
    if (SUITE_FILTER.has('desktop')) await auditDesktop(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('intro')) await auditIntroAspectRatio(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('mobile')) await auditMobile(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('offline')) await auditOffline(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('sprites')) await auditSprites(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('loading')) await auditLoading(runner, browser, server.baseUrl);
  } finally {
    await browser.close();
    await server.close();
  }

  if (UPDATE_BASELINE) return;
  const scope = SUITE_FILTER.size === ALL_SUITES.length ? '' : ` [${[...SUITE_FILTER].join(', ')}]`;
  const passed = runner.report(`Rendered behavior${scope}`);
  if (!passed) process.exitCode = 1;
}

await main();
