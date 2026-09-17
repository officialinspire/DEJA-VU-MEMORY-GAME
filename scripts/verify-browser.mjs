// Rendered-behavior regression suite.
//
// The other verifiers read source text and recompute board maths. This one
// drives the built app in a real browser and measures what a player would
// actually see: nothing overflowing sideways, every essential control reachable
// without horizontal scrolling, the short-viewport screens fitting without
// clipping, the intro keeping its aspect ratio, phone layout not drifting, and
// a full game playable with the network switched off.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

import {
  createRunner,
  missingBrowserMessage,
  resolveChromium,
  rootDirectory,
  startServer,
} from './browser-harness.mjs';

const PROBES_PATH = path.join(rootDirectory, 'scripts', 'browser-probes.js');
const BASELINE_PATH = path.join(rootDirectory, 'scripts', 'mobile-layout-baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
// --suite=desktop,offline narrows a run while iterating; the default is all.
const ALL_SUITES = ['desktop', 'intro', 'mobile', 'offline'];
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
