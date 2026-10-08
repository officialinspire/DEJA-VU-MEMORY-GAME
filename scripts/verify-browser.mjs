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
import vm from 'node:vm';
import { chromium } from 'playwright';

import { buildAchievementCatalog } from '../achievement-catalog.js';
import { recordCompletionAndAward } from '../achievement-evaluator.js';
import { createEmptyProgress } from '../progress-model.js';

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
const ALL_SUITES = ['desktop', 'intro', 'mobile', 'offline', 'sprites', 'loading', 'lifecycle', 'progress', 'achievements'];
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
    '.brand', '#btn-new-game', '#btn-continue', '#btn-statistics', '#btn-achievements',
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
  achievements: [
    '[data-back-menu]', '#achievements-title', '#achievements-unlocked', '.filter-chip',
    '.achievement-name', '.achievement-status', '#btn-reset-achievements',
  ],
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
  'reset-achievements-dialog': [
    '#reset-achievements-title', '#reset-achievements-message', '#reset-achievements-kept',
    '#btn-confirm-reset-achievements', '#btn-keep-achievements',
  ],
};
// The results of a game that unlocked achievements carry one more line.
const COMPLETE_WITH_UNLOCKS = [...DIALOG_ESSENTIALS['complete-dialog'], '#complete-achievements', '.completion-achievement-names'];

// Stand-ins for what the tracker announces, for checks that only need the
// presentation: ids, names and categories shaped like getAchievements().
function fakeAchievements(count, prefix = 'fake') {
  const categories = ['wins', 'perfect', 'speed', 'difficulty', 'score', 'pairs', 'challenge', 'daily-streak', 'perfect-streak'];
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix} achievement ${index + 1}`,
    requirement: 'A requirement.',
    category: categories[index % categories.length],
    unlocked: true,
  }));
}

function announceUnlocks(page, achievements, cause = 'test') {
  return page.evaluate(([list, why]) => window.dispatchEvent(new CustomEvent('deja-vu:achievements-unlocked', {
    detail: { cause: why, runId: null, achievements: list },
  })), [achievements, cause]);
}

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

async function isolatedContext(browser, options) {
  const context = await browser.newContext(options);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
  });
  return context;
}

async function newPage(browser, viewport, extra = {}) {
  const context = await isolatedContext(browser, {
    viewport: { width: viewport.width, height: viewport.height },
    ...extra,
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
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

      // Announced while the board is up, as a real completion is.
      await announceUnlocks(page, fakeAchievements(4), 'completion');
      await page.evaluate(() => window.__deja.openDialog('complete-dialog'));
      await auditView(runner, page, `${label} complete dialog with achievements`, COMPLETE_WITH_UNLOCKS, DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

      await page.evaluate(() => window.__deja.openDialog('art-dialog'));
      await auditView(runner, page, `${label} card-art dialog`, DIALOG_ESSENTIALS['art-dialog'], DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

      for (const screen of ['statistics', 'help', 'settings', 'achievements']) {
        await page.evaluate((name) => window.__deja.showScreen(name), screen);
        await auditView(runner, page, `${label} ${screen}`, SCREEN_ESSENTIALS[screen]);
      }

      await page.evaluate(() => window.__deja.openDialog('reset-achievements-dialog'));
      await auditView(runner, page, `${label} reset-achievements dialog`, DIALOG_ESSENTIALS['reset-achievements-dialog'], DESKTOP_MUST_FIT);
      await page.evaluate(() => window.__deja.closeDialogs());

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

  // The game just won offline is credited, and the Achievements screen and
  // its modules come from the cache.
  const offlineAchievements = await page.evaluate(() => ({
    highlight: !document.querySelector('#complete-achievements').hidden,
    rows: document.querySelectorAll('#achievement-list .achievement').length,
    unlocked: Object.keys(JSON.parse(localStorage.getItem('inspireDejaVu:v1:progress') || '{}').achievements?.unlocked || {}).length,
  }));
  await page.evaluate(() => window.__deja.showScreen('achievements'));
  const offlineScreen = await page.evaluate(() => ({
    rows: document.querySelectorAll('#achievement-list .achievement').length,
    count: document.querySelector('#achievements-unlocked').textContent,
  }));
  runner.check('offline win unlocks achievements, shown on an offline Achievements screen', () => {
    assert.ok(offlineAchievements.unlocked > 0, 'nothing unlocked offline');
    assert.ok(offlineAchievements.highlight, 'the results did not highlight the unlocks');
    assert.equal(offlineScreen.rows, 100);
    assert.equal(offlineScreen.count, String(offlineAchievements.unlocked));
  });

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
  const context = await isolatedContext(browser, {
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
    await page.evaluate(() => {
      window.__dprEvents = [];
      window.__dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      window.__dprQuery.addEventListener('change', event => window.__dprEvents.push({ matches: event.matches, ratio: devicePixelRatio }));
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 2, mobile: false });
    await spritesSettled(page);
    // CDP updates devicePixelRatio before the resolution-change repaint is delivered.
    // Wait for the actual bitmap dimensions, then keep the full pixel assertions.
    await page.waitForFunction(() => [...document.querySelectorAll('#card-grid .card-side')].every((side) => {
      const canvas = side.querySelector('canvas');
      const style = getComputedStyle(side);
      const ratio = Math.min(devicePixelRatio, 3);
      return canvas && Math.abs(canvas.width - Math.round(parseFloat(style.width) * ratio)) <= 1
        && Math.abs(canvas.height - Math.round(parseFloat(style.height) * ratio)) <= 1;
    }), null, { timeout: 5000 }).catch(async error => {
      console.error('DPR diagnostics', await page.evaluate(() => ({
        ratio: devicePixelRatio, one: matchMedia('(resolution: 1dppx)').matches,
        two: matchMedia('(resolution: 2dppx)').matches, events: window.__dprEvents,
        first: [...document.querySelectorAll('#card-grid .card-side')].slice(0, 2).map(side => ({
          cssWidth: getComputedStyle(side).width, cssHeight: getComputedStyle(side).height,
          width: side.querySelector('canvas')?.width, height: side.querySelector('canvas')?.height,
        })),
      })));
      throw error;
    });
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
  const context = await isolatedContext(browser, { ...profile, serviceWorkers: workers ? 'allow' : 'block' });
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
        const context = await isolatedContext(browser, { viewport: { width: 1280, height: 720 } });
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

// -------------------------------------------------------------- lifecycle ---

// Page visibility the test can flip, and a count of every timer callback the
// page runs, so "nothing runs in the background" can be measured.
function lifecycleProbes() {
  let hidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  const counted = (native) => function countedTimer(callback, ...rest) {
    if (typeof callback !== 'function') return native.call(window, callback, ...rest);
    return native.call(window, function countedCallback(...args) {
      window.__life.timerCallbacks += 1;
      return callback.apply(this, args);
    }, ...rest);
  };
  window.setTimeout = counted(window.setTimeout);
  window.setInterval = counted(window.setInterval);
  window.__life = {
    timerCallbacks: 0,
    setHidden(value) {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    pairs() {
      const groups = new Map();
      document.querySelectorAll('#card-grid .memory-card').forEach((card) => {
        const key = card.querySelector('.card-side-front').getAttribute('style');
        groups.set(key, [...(groups.get(key) || []), Number(card.dataset.index)]);
      });
      return [...groups.values()];
    },
    click(...indices) {
      indices.forEach((index) => document.querySelector(`#card-grid [data-index="${index}"]`).click());
    },
    state() {
      const cards = [...document.querySelectorAll('#card-grid .memory-card')];
      return {
        faceUp: cards.filter((card) => card.classList.contains('is-flipped') && !card.classList.contains('is-matched'))
          .map((card) => Number(card.dataset.index)),
        matched: cards.filter((card) => card.classList.contains('is-matched')).length,
        moves: Number(document.querySelector('#stat-moves').textContent),
        mistakes: Number(document.querySelector('#stat-mistakes').textContent),
        time: document.querySelector('#stat-time').textContent,
        message: document.querySelector('#game-message').textContent,
        previewing: document.querySelector('#card-grid').classList.contains('is-previewing'),
        paused: document.querySelector('#pause-dialog').open,
        completed: document.querySelector('#complete-dialog').open,
        scoreMs: window.__clock ? window.__clock.elapsedMs() : null,
        suspended: window.__clock ? window.__clock.isSuspended() : null,
        pending: window.__clock ? window.__clock.pendingTasks() : null,
      };
    },
  };
}

async function lifecyclePage(browser, baseUrl) {
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(lifecycleProbes);
  await context.addInitScript({ path: PROBES_PATH });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.evaluate(async () => {
    window.__clock = (await import('./gameplay-clock.js')).gameplayClock;
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__deja.showScreen('menu'));
  return { context, page };
}

const lifeState = (page) => page.evaluate(() => window.__life.state());
const timerCallbacks = (page) => page.evaluate(() => window.__life.timerCallbacks);

/** Starts a board and waits out its memorize preview. */
async function playableBoard(page, difficulty = 'easy') {
  await pickDifficulty(page, difficulty);
  await page.waitForFunction(() => !document.querySelector('#card-grid').classList.contains('is-previewing'), null, { timeout: 15000 });
  return page.evaluate(() => window.__life.pairs());
}

async function pauseByEscape(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#pause-dialog').open, null, { timeout: 2000 });
}

async function resumeFromPause(page) {
  await page.click('#btn-resume');
  await page.waitForFunction(() => !document.querySelector('#pause-dialog').open, null, { timeout: 2000 });
}

async function auditLifecycle(runner, browser, baseUrl) {
  const scenario = async (label, body) => {
    runner.group(`lifecycle/${label}`);
    const { context, page } = await lifecyclePage(browser, baseUrl);
    try {
      await body(page, (name, fn) => runner.check(`${label} — ${name}`, fn));
    } catch (error) {
      runner.check(`${label} — runs to completion`, () => {
        throw new Error(String(error?.message || error).split('\n')[0]);
      });
    } finally {
      await context.close();
    }
  };

  await scenario('pause during the memorize preview', async (page, check) => {
    await pickDifficulty(page, 'easy');
    const startedAt = Date.now();
    await page.waitForTimeout(1200);
    await pauseByEscape(page);
    const paused = await lifeState(page);
    const callbacks = await timerCallbacks(page);
    await page.waitForTimeout(2500);
    const later = await lifeState(page);
    check('the countdown freezes while paused', () => {
      assert.ok(paused.previewing && later.previewing, 'the preview ended while paused');
      assert.equal(later.message, paused.message, `countdown moved from "${paused.message}" to "${later.message}"`);
      assert.deepEqual(later.faceUp.length, 12, 'cards flipped down during the pause');
    });
    check('nothing runs in the background while paused', () => {
      assert.equal(later.suspended, true, 'gameplay is not suspended');
      return page;
    });
    const pausedCallbacks = (await timerCallbacks(page)) - callbacks;
    check('no timer fires while paused', () => assert.equal(pausedCallbacks, 0, `${pausedCallbacks} timer callbacks ran during the pause`));
    await resumeFromPause(page);
    await page.waitForFunction(() => !document.querySelector('#card-grid').classList.contains('is-previewing'), null, { timeout: 15000 });
    const total = Date.now() - startedAt;
    const done = await lifeState(page);
    check('the preview keeps its full memorize time', () => {
      assert.ok(total >= 4000 + 480 + 2500 - 250, `preview finished after ${total} ms, so the pause consumed memorize time`);
      assert.ok(total <= 4000 + 480 + 2500 + 1500, `preview took ${total} ms`);
    });
    check('memorize time is not scored', () => assert.ok(done.scoreMs < 150, `${Math.round(done.scoreMs)} ms scored by the end of the preview`));
  });

  await scenario('pause during a match', async (page, check) => {
    const pairs = await playableBoard(page);
    await page.evaluate((pair) => window.__life.click(...pair), pairs[0]);
    await pauseByEscape(page);
    const callbacks = await timerCallbacks(page);
    await page.waitForTimeout(1500);
    const paused = await lifeState(page);
    const pausedCallbacks = (await timerCallbacks(page)) - callbacks;
    check('the match waits for the player', () => {
      assert.equal(paused.matched, 0, 'the pair resolved while paused');
      assert.deepEqual(paused.faceUp.sort((a, b) => a - b), [...pairs[0]].sort((a, b) => a - b));
      assert.equal(paused.pending, 1, `${paused.pending} gameplay timers pending`);
    });
    check('no timer fires while paused', () => assert.equal(pausedCallbacks, 0, `${pausedCallbacks} timer callbacks ran during the pause`));
    await resumeFromPause(page);
    await page.waitForTimeout(800);
    const resolved = await lifeState(page);
    check('it resolves after resuming', () => {
      assert.equal(resolved.matched, 2, `${resolved.matched} cards matched`);
      assert.equal(resolved.pending, 0);
    });
  });

  await scenario('pause during a mismatch', async (page, check) => {
    const pairs = await playableBoard(page);
    await page.evaluate(([first, second]) => window.__life.click(first, second), [pairs[0][0], pairs[1][0]]);
    await page.waitForTimeout(250);
    await pauseByEscape(page);
    await page.waitForTimeout(2000);
    const paused = await lifeState(page);
    check('the mismatch stays up to study while paused', () => {
      assert.equal(paused.faceUp.length, 2, 'the cards flipped back during the pause');
      assert.equal(paused.mistakes, 1);
    });
    await resumeFromPause(page);
    await page.waitForTimeout(350);
    const soon = await lifeState(page);
    check('resuming continues the study time instead of skipping it', () => {
      assert.equal(soon.faceUp.length, 2, 'the cards flipped back the moment play resumed');
    });
    await page.waitForTimeout(1500);
    const later = await lifeState(page);
    check('then the cards flip back', () => {
      assert.equal(later.faceUp.length, 0, `${later.faceUp.length} cards still up`);
      assert.equal(later.message, 'Try again.');
      assert.equal(later.pending, 0);
    });
  });

  await scenario('background and resume', async (page, check) => {
    const pairs = await playableBoard(page);
    await page.waitForTimeout(1300);
    await page.evaluate(([first, second]) => window.__life.click(first, second), [pairs[0][0], pairs[1][0]]);
    const before = await lifeState(page);
    const callbacks = await timerCallbacks(page);
    await page.evaluate(() => window.__life.setHidden(true));
    await page.waitForTimeout(2000);
    const hidden = await lifeState(page);
    const hiddenCallbacks = (await timerCallbacks(page)) - callbacks;
    check('a hidden page freezes the turn and the score clock', () => {
      assert.equal(hidden.faceUp.length, 2, 'the mismatch resolved while hidden');
      assert.ok(Math.abs(hidden.scoreMs - before.scoreMs) < 100, `score clock moved ${Math.round(hidden.scoreMs - before.scoreMs)} ms while hidden`);
    });
    check('nothing runs while hidden', () => assert.equal(hiddenCallbacks, 0, `${hiddenCallbacks} timer callbacks ran while hidden`));
    await page.evaluate(() => window.__life.setHidden(false));
    const back = await lifeState(page);
    check('coming back opens the pause dialog and stays frozen', () => {
      assert.ok(back.paused, 'no pause dialog on return');
      assert.ok(back.suspended, 'gameplay resumed without the player');
    });
    await resumeFromPause(page);
    await page.waitForTimeout(1500);
    const resumed = await lifeState(page);
    check('play continues after resuming', () => {
      assert.equal(resumed.faceUp.length, 0, 'the mismatch never resolved');
      assert.ok(resumed.scoreMs > hidden.scoreMs + 1000, 'the score clock did not restart');
    });
  });

  await scenario('score time', async (page, check) => {
    await playableBoard(page);
    await page.waitForTimeout(3300);
    const played = await lifeState(page);
    check('counts play time to the second, from the end of the preview', () => {
      assert.ok(played.scoreMs >= 3200 && played.scoreMs <= 3700, `${Math.round(played.scoreMs)} ms scored for ~3.3 s of play`);
      assert.equal(played.time, '00:03');
    });
    await pauseByEscape(page);
    await page.waitForTimeout(1500);
    const paused = await lifeState(page);
    check('excludes paused time', () => assert.ok(Math.abs(paused.scoreMs - played.scoreMs) < 150, 'paused time was scored'));
    await resumeFromPause(page);
    const pairs = await page.evaluate(() => window.__life.pairs());
    for (const pair of pairs) {
      await page.evaluate((cards) => window.__life.click(...cards), pair);
      await page.waitForTimeout(650);
    }
    await page.waitForFunction(() => document.querySelector('#complete-dialog').open, null, { timeout: 5000 });
    const result = await page.evaluate(() => ({
      time: document.querySelector('#complete-time').textContent,
      score: Number(document.querySelector('#complete-score').textContent.replace(/[^\d]/g, '')),
      mistakes: Number(document.querySelector('#complete-mistakes').textContent),
      shown: document.querySelector('#stat-time').textContent,
    }));
    const [minutes, seconds] = result.time.split(':').map(Number);
    check('the completion time is the time scored', () => {
      assert.equal(result.score, 6000 - result.mistakes * 350 - (minutes * 60 + seconds) * 5, `score ${result.score} does not match ${result.time}`);
      assert.ok(minutes * 60 + seconds >= 6 && minutes * 60 + seconds <= 9, `completed in ${result.time} for about 7 s of play`);
    });
  });

  await scenario('rapid input', async (page, check) => {
    const pairs = await playableBoard(page);
    const [a, b] = [pairs[0][0], pairs[1][0]];
    await page.evaluate(([card]) => window.__life.click(card, card, card), [a]);
    const one = await lifeState(page);
    check('tapping one card repeatedly opens it once', () => {
      assert.deepEqual(one.faceUp, [a]);
      assert.equal(one.moves, 0);
    });
    await page.evaluate(([first, second, third, fourth]) => window.__life.click(first, second, third, fourth), [b, pairs[2][0], pairs[2][1], pairs[3][0]]);
    const locked = await lifeState(page);
    check('a third and fourth card are refused while a pair resolves', () => {
      assert.deepEqual(locked.faceUp.sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
      assert.equal(locked.moves, 1);
      assert.equal(locked.mistakes, 1);
    });
    for (let press = 0; press < 6; press += 1) await page.keyboard.press('Escape');
    // The dialog's close event lands a task after the last Escape.
    await page.waitForFunction(() => !window.__clock.isSuspended(), null, { timeout: 2000 }).catch(() => {});
    const toggled = await lifeState(page);
    check('pausing and resuming rapidly ends consistent', () => {
      assert.equal(toggled.paused, false, 'an even number of Escapes left the game paused');
      assert.equal(toggled.suspended, false, 'gameplay stayed frozen after the dialog closed');
    });
    await page.waitForTimeout(1600);
    const settled = await lifeState(page);
    check('the interrupted turn still resolves once', () => {
      assert.equal(settled.faceUp.length, 0);
      assert.equal(settled.mistakes, 1);
      assert.equal(settled.pending, 0);
    });
  });

  await scenario('restart', async (page, check) => {
    const pairs = await playableBoard(page);
    await page.evaluate(([first, second]) => window.__life.click(first, second), [pairs[0][0], pairs[1][0]]);
    // Leave mid-mismatch, then deal a new board.
    await page.click('#btn-game-menu');
    await page.evaluate(() => window.__deja.showScreen('menu'));
    await pickDifficulty(page, 'insane');
    const fresh = await lifeState(page);
    check('a new board starts clean', () => {
      assert.equal(fresh.moves, 0);
      assert.equal(fresh.mistakes, 0);
      assert.equal(fresh.message, 'Memorize the board — 8');
      assert.equal(fresh.pending, 2, `${fresh.pending} gameplay timers pending: the old board left work behind`);
    });
    await page.waitForTimeout(1500);
    const later = await lifeState(page);
    check('the old board\'s pending turn never touches it', () => {
      assert.equal(later.faceUp.length, 30, 'cards of the new board flipped down early');
      assert.equal(later.mistakes, 0);
    });
    // Restart again mid-preview: the first preview's timers must not end the second.
    await page.click('#btn-game-menu');
    await page.evaluate(() => window.__deja.showScreen('menu'));
    await pickDifficulty(page, 'insane');
    await page.waitForTimeout(6500);
    const second = await lifeState(page);
    check('restarting mid-preview gives the new board its full memorize time', () => {
      assert.ok(second.previewing, 'the new preview ended early, on the old one\'s schedule');
      assert.equal(second.faceUp.length, 30);
    });
  });
}

// ----------------------------------------------------------------- worker ---

const MENU_TRACK = 'Deja Vu - Main Menu (Vibe 1).mp3';

async function controlledPage(browser, baseUrl) {
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 20000 });
  return { context, page };
}

async function cacheNames(page) {
  return page.evaluate(() => caches.keys());
}

async function auditWorker(runner, browser) {
  // Encoded names, out-of-scope requests and deduplicated media warming, on a
  // server that counts what actually reaches it.
  {
    runner.group('worker/requests');
    const seen = [];
    const server = await startServer({ onRequest: (request) => seen.push(request) });
    const { context, page } = await controlledPage(browser, server.baseUrl);
    try {
      const names = await cacheNames(page);
      runner.check('cache is named for this scope', () => {
        assert.ok(names.some((name) => /^deja-vu-v[\d.]+@\/DEJA-VU-MEMORY-GAME\/$/.test(name)), `caches: ${names.join(', ')}`);
      });

      const outside = page.waitForResponse((response) => response.url().endsWith('/outside-scope/probe.txt'));
      await page.evaluate(() => fetch('/outside-scope/probe.txt').catch(() => null));
      const outsideResponse = await outside;
      runner.check('requests outside the scope go straight to the network', () => {
        assert.equal(outsideResponse.fromServiceWorker(), false, 'the worker answered a request outside its scope');
      });

      // Drop the precached track, then let several range requests race for it.
      const track = new URL(MENU_TRACK, server.baseUrl).href;
      await page.evaluate(async (url) => {
        const name = (await caches.keys()).find((key) => key.startsWith('deja-vu-'));
        await (await caches.open(name)).delete(url);
      }, track);
      seen.length = 0;
      const ranges = await page.evaluate(async (url) => Promise.all(
        ['bytes=0-1', 'bytes=1024-2047', 'bytes=4096-8191', 'bytes=-64'].map(async (range) => {
          const response = await fetch(url, { headers: { Range: range } });
          await response.arrayBuffer();
          return response.status;
        }),
      ), track);
      const deadline = Date.now() + 15000;
      let warmed = false;
      while (!warmed && Date.now() < deadline) {
        warmed = await page.evaluate(async (url) => {
          const name = (await caches.keys()).find((key) => key.startsWith('deja-vu-'));
          return Boolean(await (await caches.open(name)).match(url));
        }, track);
        if (!warmed) await page.waitForTimeout(200);
      }
      const forTrack = seen.filter((request) => request.pathname.endsWith(MENU_TRACK));
      runner.check('uncached media is range-served online and warmed into the cache', () => {
        assert.deepEqual(ranges, [206, 206, 206, 206]);
        assert.ok(warmed, 'the full track never reached the cache');
      });
      runner.check('warming downloads the track once, however many range requests ask', () => {
        const full = forTrack.filter((request) => !request.range).length;
        assert.equal(full, 1, `${full} full downloads for ${forTrack.length - full} range requests`);
      });

      // Offline, under every spelling of the name.
      await context.setOffline(true);
      const offline = await page.evaluate(async () => {
        const spellings = [
          './Deja Vu - Main Menu (Vibe 1).mp3',
          './Deja%20Vu%20-%20Main%20Menu%20(Vibe%201).mp3',
          './Deja%20Vu%20-%20Main%20Menu%20%28Vibe%201%29.mp3',
        ];
        const out = {};
        for (const spelling of spellings) {
          const response = await fetch(spelling, { headers: { Range: 'bytes=10-19' } });
          out[spelling] = { status: response.status, range: response.headers.get('Content-Range'), bytes: (await response.arrayBuffer()).byteLength };
        }
        const beyond = await fetch(spellings[0], { headers: { Range: 'bytes=999999999-' } });
        out.unsatisfiable = { status: beyond.status, range: beyond.headers.get('Content-Range') };
        return out;
      });
      for (const [spelling, result] of Object.entries(offline)) {
        if (spelling === 'unsatisfiable') continue;
        runner.check(`offline track as "${spelling}"`, () => {
          assert.equal(result.status, 206, `answered ${result.status}`);
          assert.equal(result.bytes, 10);
          assert.match(result.range || '', /^bytes 10-19\/\d+$/);
        });
      }
      runner.check('offline unsatisfiable range answers 416', () => {
        assert.equal(offline.unsatisfiable.status, 416);
        assert.match(offline.unsatisfiable.range || '', /^bytes \*\/\d+$/);
      });
    } finally {
      await context.close();
      await server.close();
    }
  }

  // Update lifecycle: a new version installs and waits, a reload does not hand
  // over, a cold start does; activation clears this app's older and legacy
  // caches and leaves another scope's alone.
  {
    runner.group('worker/update');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deja-vu-update-'));
    await cp(distDirectory, directory, { recursive: true });
    const server = await startServer({ directory });
    const context = await isolatedContext(browser, { viewport: { width: 1280, height: 720 } });
    try {
      let page = await context.newPage();
      await page.goto(server.baseUrl, { waitUntil: 'load' });
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 20000 });
      const [current] = (await cacheNames(page)).filter((name) => name.startsWith('deja-vu-'));
      await page.evaluate(async () => {
        for (const name of ['deja-vu-v0.1.0@/other-app/', 'deja-vu-v1.4.0', 'deja-vu-v1.0.0@/DEJA-VU-MEMORY-GAME/']) {
          await (await caches.open(name)).put('/probe', new Response('probe'));
        }
      });

      const source = await readFile(path.join(directory, 'sw.js'), 'utf8');
      await writeFile(path.join(directory, 'sw.js'), source.replace(/const CACHE_VERSION = '([^']+)';/, "const CACHE_VERSION = '$1-next';"));
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      const waitingDeadline = Date.now() + 20000;
      let state = {};
      while (Date.now() < waitingDeadline) {
        state = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return { waiting: Boolean(registration?.waiting), names: await caches.keys() };
        });
        if (state.waiting) break;
        await page.waitForTimeout(200);
      }
      runner.check('a new version installs and waits while the old one serves', () => {
        assert.ok(state.waiting, 'no waiting worker after update()');
        assert.ok(state.names.includes(current), 'the serving generation\'s cache was removed early');
        assert.ok(state.names.some((name) => name.includes('-next@')), 'the new generation did not precache');
      });

      await page.reload({ waitUntil: 'load' });
      const afterReload = await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
      runner.check('a reload does not hand over', () => assert.ok(afterReload, 'the new version took over on reload'));

      // A cold start: every app page closed. Watch from a same-origin page the
      // worker does not control, so nothing keeps the old version in use.
      await page.close();
      page = await context.newPage();
      await page.goto(`${server.origin}/outside-scope/`, { waitUntil: 'load' });
      const scope = new URL(server.baseUrl).pathname;
      const activeDeadline = Date.now() + 20000;
      let names = [];
      let waiting = true;
      while (Date.now() < activeDeadline) {
        ({ names, waiting } = await page.evaluate(async (path) => ({
          names: await caches.keys(),
          waiting: Boolean((await navigator.serviceWorker.getRegistration(path))?.waiting),
        }), scope));
        if (!waiting && !names.includes(current)) break;
        await page.waitForTimeout(200);
      }
      runner.check('a cold start activates the new version', () => {
        assert.equal(waiting, false, 'still waiting after every page closed');
        assert.ok(names.some((name) => name.includes('-next@')), `caches: ${names.join(', ')}`);
      });
      runner.check('activation clears this app\'s older and legacy caches only', () => {
        assert.ok(!names.includes(current), 'the previous generation survived');
        assert.ok(!names.includes('deja-vu-v1.0.0@/DEJA-VU-MEMORY-GAME/'), 'an older same-scope generation survived');
        assert.ok(!names.includes('deja-vu-v1.4.0'), 'a pre-scope legacy cache survived');
        assert.ok(names.includes('deja-vu-v0.1.0@/other-app/'), 'another scope\'s cache was deleted');
      });
      await page.goto(server.baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 20000 });
      const served = await page.evaluate(async () => {
        const response = await fetch('./sw.js', { cache: 'no-store' }).catch(() => null);
        return { controlled: Boolean(navigator.serviceWorker.controller), title: document.title, ok: Boolean(response?.ok) };
      });
      runner.check('the reopened app is served by the new version', () => {
        assert.ok(served.controlled, 'the reopened app is not controlled');
        assert.equal(served.title, 'DEJA VU by INSPIRE');
      });
    } finally {
      await context.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

// --------------------------------------------------------------- progress ---

const PROGRESS_STORE = 'inspireDejaVu:v1:progress';
const GAME_STORE = 'inspireDejaVu:v1:activeGame';
const STATS_STORE = 'inspireDejaVu:v1:statistics';

// Records every gameplay event, and seeds storage once per tab (not again on
// reload), with reduced motion so turns resolve quickly.
function progressProbes({ seed, denyStorage }) {
  window.__events = [];
  for (const type of ['deja-vu:completion', 'deja-vu:match', 'deja-vu:mismatch', 'deja-vu:run-abandoned', 'deja-vu:progress-updated', 'deja-vu:achievements-unlocked']) {
    window.addEventListener(type, (event) => window.__events.push({ type, detail: JSON.parse(JSON.stringify(event.detail ?? null)) }));
  }
  if (denyStorage) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
    return;
  }
  if (sessionStorage.getItem('__seeded')) return;
  sessionStorage.setItem('__seeded', '1');
  localStorage.setItem('inspireDejaVu:v1:settings', JSON.stringify({ reducedMotion: true, music: false, sfx: false }));
  for (const [key, value] of Object.entries(seed || {})) localStorage.setItem(key, value);
}

async function progressPage(browser, baseUrl, { seed = null, denyStorage = false, timezoneId, fixedTime } = {}) {
  const context = await isolatedContext(browser, {
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    ...(timezoneId ? { timezoneId } : {}),
  });
  await context.addInitScript(progressProbes, { seed, denyStorage });
  await context.addInitScript({ path: PROBES_PATH });
  const page = await context.newPage();
  if (fixedTime) await page.clock.setFixedTime(new Date(fixedTime));
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  const errors = [];
  page.on('pageerror', (error) => {
    if (!/reading 'scope'/.test(String(error))) errors.push(String(error));
  });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  return { context, page, errors };
}

const storedJson = (page, key) => page.evaluate((name) => JSON.parse(localStorage.getItem(name) || 'null'), key);
const SETTINGS_STORE = 'inspireDejaVu:v1:settings';
// Animations on: the slower of the two motion settings, as most players have it.
const FULL_MOTION = { [SETTINGS_STORE]: JSON.stringify({ reducedMotion: false, music: false, sfx: false }) };
const unlockedBy = (progress, runId) => Object.entries(progress.achievements.unlocked)
  .filter(([, award]) => award.runId === runId).map(([id]) => id).sort();
const trackedAchievements = (page) => page.evaluate(async () => (await import('./progress-tracker.js')).getAchievements());
const progressEvents = (page, type) => page.evaluate((name) => window.__events.filter((event) => event.type === name).map((event) => event.detail), type);

async function cardPairs(page) {
  return page.evaluate(() => {
    const groups = new Map();
    document.querySelectorAll('#card-grid .memory-card').forEach((card) => {
      if (card.disabled) return;
      const key = card.querySelector('.card-side-front').getAttribute('style');
      groups.set(key, [...(groups.get(key) || []), Number(card.dataset.index)]);
    });
    return [...groups.values()].filter((group) => group.length === 2);
  });
}

/** Turns two cards and waits until the core has resolved the turn. */
async function turnPair(page, first, second) {
  const turns = () => window.__events.filter((event) => event.type === 'deja-vu:match' || event.type === 'deja-vu:mismatch');
  const before = await page.evaluate(`(${turns})().length`);
  await page.evaluate(([a, b]) => {
    document.querySelector(`#card-grid [data-index="${a}"]`).click();
    document.querySelector(`#card-grid [data-index="${b}"]`).click();
  }, [first, second]);
  await page.waitForFunction(`(${turns})().length > ${before}`, null, { timeout: 5000 });
  const outcome = await page.evaluate(`(${turns})().at(-1).type`);
  if (outcome === 'deja-vu:mismatch') {
    // A mismatch is reported when it is made; the turn unlocks once both
    // cards are back down, a beat after they stop showing.
    await page.waitForFunction(() => !document.querySelector('#card-grid .memory-card.is-flipped:not(.is-matched)'), null, { timeout: 5000 });
    await page.waitForTimeout(600);
  }
}

async function freshBoard(page, difficulty = 'easy') {
  await page.evaluate(() => window.__deja.showScreen('menu'));
  await pickDifficulty(page, difficulty);
  await page.waitForFunction(() => !document.querySelector('#card-grid').classList.contains('is-previewing'), null, { timeout: 15000 });
}

async function finishBoard(page) {
  for (const [first, second] of await cardPairs(page)) await turnPair(page, first, second);
  await page.waitForFunction(() => document.querySelector('#complete-dialog').open, null, { timeout: 5000 });
}

async function continueAfterReload(page) {
  await page.reload({ waitUntil: 'load' });
  await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);
  await page.click('#screen-start');
  await page.waitForFunction(() => document.querySelector('#screen-menu').classList.contains('is-active'), null, { timeout: 10000 });
  await page.click('#btn-continue');
  await page.waitForFunction(() => document.querySelector('#screen-game').classList.contains('is-active'), null, { timeout: 10000 });
}

async function auditProgress(runner, browser, baseUrl) {
  const scenario = async (label, options, body) => {
    runner.group(`progress/${label}`);
    const { context, page, errors } = await progressPage(browser, baseUrl, options);
    const check = (name, fn) => runner.check(`${label} — ${name}`, fn);
    try {
      await body(page, check);
      check('no page errors', () => assert.deepEqual(errors, []));
    } catch (error) {
      check('runs to completion', () => {
        throw new Error(String(error?.message || error).split('\n')[0]);
      });
    } finally {
      await context.close();
    }
  };

  await scenario('completion, reload and duplicates', {}, async (page, check) => {
    await freshBoard(page);
    await finishBoard(page);
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    const expectedDay = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    });
    const score = await page.evaluate((detail) => window.DEJA_VU_RUNTIME.calculateScore('easy', detail.mistakes, detail.elapsed), completion);
    check('completion reports the run in full', () => {
      assert.match(completion.runId, /^[A-Za-z0-9-]{8,64}$/);
      assert.deepEqual(
        [completion.pairs, completion.moves, completion.mistakes, completion.perfect, completion.bestMatchChain, completion.finalMatchChain],
        [6, 6, 0, true, 6, 6],
      );
      assert.equal(completion.elapsed, Math.floor(completion.elapsedMs / 1000));
      assert.equal(completion.score, score, 'scored by runtime-config.js');
      assert.equal(completion.day, expectedDay, 'dated by the local calendar');
    });
    const matches = await progressEvents(page, 'deja-vu:match');
    check('each match is reported once, with its chain', () => {
      assert.deepEqual(matches.map((match) => match.chain), [1, 2, 3, 4, 5, 6]);
      assert.ok(matches.every((match) => match.runId === completion.runId));
    });
    const progress = await storedJson(page, PROGRESS_STORE);
    check('the win is credited lifetime and to its difficulty', () => {
      for (const totals of [progress.totals, progress.byDifficulty.easy]) {
        assert.deepEqual(
          [totals.wins, totals.perfectWins, totals.matchedPairs, totals.earnedScore, totals.activeTimeMs, totals.bestMatchChain, totals.perfectStreak],
          [1, 1, 6, completion.score, completion.elapsedMs, 6, 1],
        );
      }
      assert.deepEqual(progress.daily, { current: 1, best: 1, lastWinDay: expectedDay });
      assert.deepEqual(progress.recordedRuns, [completion.runId]);
    });
    const stats = await storedJson(page, STATS_STORE);
    check('legacy statistics are still kept as before', () => {
      assert.deepEqual([stats.played, stats.won, stats.perfect], [1, 1, 1]);
      assert.equal(stats.bests.easy.score, completion.score);
    });
    const firstUnlocks = ['easy-wins-1', 'excellent-easy', 'performance-95', 'perfect-1', 'score-1', 'speed-easy-1', 'speed-easy-2', 'wins-1'].sort();
    check('the win unlocks its achievements, stamped with the run and its time', () => {
      assert.ok(completion.elapsed <= 21, `played in ${completion.elapsed} s`);
      assert.deepEqual(Object.keys(progress.achievements.unlocked).sort(), firstUnlocks);
      assert.deepEqual(unlockedBy(progress, completion.runId), firstUnlocks);
      assert.ok(Object.values(progress.achievements.unlocked).every((award) => award.at === completion.completedAt));
    });
    const announced = await progressEvents(page, 'deja-vu:achievements-unlocked');
    check('and announces them once', () => {
      assert.equal(announced.length, 1);
      assert.equal(announced[0].runId, completion.runId);
      assert.deepEqual(announced[0].achievements.map((item) => item.id).sort(), firstUnlocks);
      assert.ok(announced[0].achievements.every((item) => item.name && item.requirement && item.unlockedAt === completion.completedAt));
    });
    const listed = await trackedAchievements(page);
    check('all 100 are listed with progress and unlock times', () => {
      assert.equal(listed.length, 100);
      assert.deepEqual(listed.filter((item) => item.unlocked).map((item) => item.id).sort(), firstUnlocks);
      assert.deepEqual(listed.find((item) => item.id === 'wins-3').progress, 1 / 3);
      assert.equal(listed.find((item) => item.id === 'flawless-insanity').value, null);
    });
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('deja-vu:completion', { detail })), completion);
    const afterDuplicate = await storedJson(page, PROGRESS_STORE);
    check('a duplicate completion is not counted', () => {
      assert.equal(afterDuplicate.totals.wins, 1);
      assert.deepEqual(afterDuplicate.achievements, progress.achievements, 'or awarded');
    });
    const announcedAgain = await progressEvents(page, 'deja-vu:achievements-unlocked');
    check('nor announced', () => assert.equal(announcedAgain.length, 1));
    await page.reload({ waitUntil: 'load' });
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('deja-vu:completion', { detail })), completion);
    const afterReload = await storedJson(page, PROGRESS_STORE);
    const reannounced = await progressEvents(page, 'deja-vu:achievements-unlocked');
    check('after a reload the record holds, and the replay is still refused', () => {
      assert.equal(afterReload.totals.wins, 1);
      assert.deepEqual(afterReload.recordedRuns, [completion.runId]);
      assert.deepEqual(afterReload.achievements, progress.achievements);
      assert.deepEqual(reannounced, []);
    });
  });

  await scenario('achievements with animations on', { seed: FULL_MOTION }, async (page, check) => {
    await freshBoard(page, 'insane');
    await finishBoard(page);
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    const progress = await storedJson(page, PROGRESS_STORE);
    const expected = [
      'excellent-insane', 'flawless-insanity', 'insane-wins-1', 'perfect-1', 'performance-95', 'score-1', 'score-2', 'score-3',
      'speed-insane-1', 'speed-insane-2', 'speed-insane-3', 'unbroken-thread', 'wins-1',
    ].sort();
    check('a perfect Insane board at full animation timing reaches the top speed and score goals', () => {
      // Every turn waits out the real match resolution; the 8 s preview is not counted.
      assert.ok(completion.elapsedMs >= 15 * 460, `${completion.elapsedMs} ms is faster than the turn timings allow`);
      assert.ok(completion.elapsed <= 37, `played in ${completion.elapsed} s`);
      assert.deepEqual([completion.mistakes, completion.bestMatchChain], [0, 15]);
      assert.deepEqual(unlockedBy(progress, completion.runId), expected);
      assert.deepEqual(progress.achievements.bests.insane, {
        fewestMistakes: 0, fastestSharpWin: completion.elapsed, fastestPerfectWin: completion.elapsed, topScore: completion.score,
      });
    });
  });

  await scenario('a reload cannot erase a mistake', { seed: FULL_MOTION }, async (page, check) => {
    await freshBoard(page);
    const pairs = await cardPairs(page);
    await page.evaluate(([a, b]) => {
      document.querySelector(`#card-grid [data-index="${a}"]`).click();
      document.querySelector(`#card-grid [data-index="${b}"]`).click();
    }, [pairs[0][0], pairs[1][0]]);
    await page.waitForFunction(() => window.__events.some((event) => event.type === 'deja-vu:mismatch'), null, { timeout: 5000 });
    // Reload while both cards are still face up for study, before the turn
    // has finished and autosaved.
    await continueAfterReload(page);
    const resumed = await storedJson(page, GAME_STORE);
    const shown = await page.textContent('#stat-mistakes');
    check('the mistake survives the reload', () => assert.deepEqual([resumed.mistakes, shown], [1, '1']));
    await finishBoard(page);
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    const progress = await storedJson(page, PROGRESS_STORE);
    check('so the win is not perfect, and earns no perfect achievement', () => {
      assert.deepEqual([completion.mistakes, completion.perfect], [1, false]);
      assert.ok(Object.hasOwn(progress.achievements.unlocked, 'wins-1'));
      assert.ok(!Object.keys(progress.achievements.unlocked).some((id) => /^perfect|flawless|lightning/.test(id)));
      assert.equal(progress.achievements.bests.easy.fewestMistakes, 1);
    });
  });

  await scenario('Continue keeps the run', {}, async (page, check) => {
    await freshBoard(page);
    const pairs = await cardPairs(page);
    await turnPair(page, ...pairs[0]);
    await turnPair(page, ...pairs[1]);
    await turnPair(page, pairs[2][0], pairs[3][0]);
    await turnPair(page, ...pairs[2]);
    await page.click('#btn-game-menu');
    const saved = await storedJson(page, GAME_STORE);
    check('the save carries the run, not the session', () => {
      assert.match(saved.runId, /^[A-Za-z0-9-]{8,64}$/);
      assert.equal(saved.sessionId, '');
      assert.deepEqual([saved.chain, saved.bestChain, saved.mistakes, saved.matchedPairs], [1, 2, 1, 3]);
    });
    await continueAfterReload(page);
    const resumed = await storedJson(page, GAME_STORE);
    check('Continue resumes the same run', () => assert.equal(resumed.runId, saved.runId));
    await finishBoard(page);
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    check('the completion belongs to the original run, chains included', () => {
      assert.equal(completion.runId, saved.runId);
      assert.deepEqual([completion.moves, completion.mistakes, completion.bestMatchChain, completion.finalMatchChain], [7, 1, 4, 4]);
    });
    const progress = await storedJson(page, PROGRESS_STORE);
    check('recorded once, as an imperfect win', () => {
      assert.deepEqual([progress.totals.wins, progress.totals.perfectWins, progress.totals.bestMatchChain], [1, 0, 4]);
      assert.deepEqual(progress.recordedRuns, [saved.runId]);
    });
    const abandoned = await progressEvents(page, 'deja-vu:run-abandoned');
    check('no abandonment was reported', () => assert.deepEqual(abandoned, []));
  });

  {
    // A player upgrading mid-game: an old save with no run id or chain, and
    // old statistics with no progress record yet.
    const deck = [];
    for (let pattern = 0; pattern < 6; pattern += 1) {
      deck.push({ uid: `a${pattern}`, pattern, matched: pattern < 2 }, { uid: `b${pattern}`, pattern, matched: pattern < 2 });
    }
    const legacySave = {
      version: 1, active: true, difficulty: 'easy', deck, open: [], matchedPairs: 2, moves: 3, mistakes: 1,
      elapsed: 20, paused: false, locked: false, turn: 'idle', completed: false, sessionId: '', turnId: 0,
    };
    const legacyStats = { played: 3, won: 2, perfect: 1, bestScore: 5200, bests: { easy: { time: 40, mistakes: 0, score: 5200 } } };
    await scenario('migration from an old save', {
      seed: { [GAME_STORE]: JSON.stringify(legacySave), [STATS_STORE]: JSON.stringify(legacyStats) },
    }, async (page, check) => {
      const seeded = await storedJson(page, PROGRESS_STORE);
      const backfilled = ['easy-wins-1', 'excellent-easy', 'perfect-1', 'score-1', 'wins-1'].sort();
      check('old statistics seed the record on first load', () => {
        assert.deepEqual([seeded.totals.wins, seeded.totals.perfectWins], [2, 1]);
        assert.deepEqual(seeded.legacy, { wins: 2, perfectWins: 1 });
      });
      check('and backfill exactly the achievements they prove', () => {
        assert.deepEqual(unlockedBy(seeded, null), backfilled);
        assert.deepEqual(Object.keys(seeded.achievements.unlocked).sort(), backfilled);
        assert.equal(seeded.byDifficulty.easy.wins, 0, 'without inventing per-difficulty wins');
        assert.deepEqual(seeded.achievements.bests.easy, { fewestMistakes: 0, fastestSharpWin: 160, fastestPerfectWin: null, topScore: 5200 });
      });
      await continueAfterReload(page);
      const migrated = await storedJson(page, GAME_STORE);
      check('the old save gets a run id when continued', () => {
        assert.match(migrated.runId || '', /^[A-Za-z0-9-]{8,64}$/);
        assert.deepEqual([migrated.chain, migrated.bestChain, migrated.elapsed], [0, 0, 20]);
      });
      await finishBoard(page);
      const [completion] = await progressEvents(page, 'deja-vu:completion');
      const progress = await storedJson(page, PROGRESS_STORE);
      const stats = await storedJson(page, STATS_STORE);
      check('the migrated run completes and counts once on top of the legacy wins', () => {
        assert.equal(completion.runId, migrated.runId);
        assert.deepEqual([completion.moves, completion.mistakes, completion.bestMatchChain], [7, 1, 4]);
        assert.deepEqual([progress.totals.wins, progress.byDifficulty.easy.wins, progress.totals.perfectWins], [3, 1, 1]);
        assert.equal(stats.won, 3, 'legacy statistics agree');
      });
      check('the run earns what it adds; the backfilled ones keep their stamps', () => {
        assert.ok(unlockedBy(progress, completion.runId).includes('wins-3'));
        assert.deepEqual(unlockedBy(progress, null), backfilled);
        for (const id of backfilled) assert.deepEqual(progress.achievements.unlocked[id], seeded.achievements.unlocked[id]);
      });
    });
  }

  {
    const streak = (() => {
      const totals = { wins: 2, perfectWins: 2, matchedPairs: 12, earnedScore: 11000, activeTimeMs: 60000, bestMatchChain: 6, perfectStreak: 2, bestPerfectStreak: 2 };
      const empty = { wins: 0, perfectWins: 0, matchedPairs: 0, earnedScore: 0, activeTimeMs: 0, bestMatchChain: 0, perfectStreak: 0, bestPerfectStreak: 0 };
      return {
        version: 1, totals, byDifficulty: { easy: { ...totals }, intermediate: { ...empty }, advanced: { ...empty }, insane: { ...empty } },
        daily: { current: 1, best: 1, lastWinDay: '2026-03-01' }, recordedRuns: [], legacy: null, resetAt: null,
      };
    })();
    await scenario('abandonment', { seed: { [PROGRESS_STORE]: JSON.stringify(streak) } }, async (page, check) => {
      await freshBoard(page);
      await page.click('#btn-game-menu');
      await freshBoard(page);
      let progress = await storedJson(page, PROGRESS_STORE);
      let abandoned = await progressEvents(page, 'deja-vu:run-abandoned');
      check('replacing a clean run abandons it without ending the streak', () => {
        assert.equal(abandoned.length, 1);
        assert.equal(abandoned[0].mistakes, 0);
        assert.equal(progress.totals.perfectStreak, 2);
        assert.ok(progress.recordedRuns.includes(abandoned[0].runId));
        assert.equal(progress.totals.wins, 2, 'an abandoned run earns nothing');
      });
      const pairs = await cardPairs(page);
      await turnPair(page, pairs[0][0], pairs[1][0]);
      await page.click('#btn-game-menu');
      await freshBoard(page);
      progress = await storedJson(page, PROGRESS_STORE);
      abandoned = await progressEvents(page, 'deja-vu:run-abandoned');
      check('replacing a run that has a mistake ends the perfect streak', () => {
        assert.equal(abandoned.length, 2);
        assert.equal(abandoned[1].mistakes, 1);
        assert.deepEqual(
          [progress.totals.perfectStreak, progress.totals.bestPerfectStreak, progress.byDifficulty.easy.perfectStreak],
          [0, 2, 0],
        );
      });
    });
  }

  await scenario('local calendar days', {
    timezoneId: 'America/Los_Angeles',
    fixedTime: '2026-03-01T05:00:00Z',
  }, async (page, check) => {
    await freshBoard(page);
    await finishBoard(page);
    let progress = await storedJson(page, PROGRESS_STORE);
    const [first] = await progressEvents(page, 'deja-vu:completion');
    check('the day is the device\'s local date, not UTC', () => {
      assert.equal(first.day, '2026-02-28');
      assert.deepEqual(progress.daily, { current: 1, best: 1, lastWinDay: '2026-02-28' });
    });
    await page.clock.setFixedTime(new Date('2026-03-01T06:30:00Z'));
    await page.click('#btn-complete-menu');
    await freshBoard(page);
    await finishBoard(page);
    progress = await storedJson(page, PROGRESS_STORE);
    check('a second win the same local day counts once toward the streak', () => {
      assert.deepEqual(progress.daily, { current: 1, best: 1, lastWinDay: '2026-02-28' });
      assert.equal(progress.totals.wins, 2);
    });
    await page.clock.setFixedTime(new Date('2026-03-01T20:00:00Z'));
    await page.click('#btn-complete-menu');
    await freshBoard(page);
    await finishBoard(page);
    progress = await storedJson(page, PROGRESS_STORE);
    check('the next local day extends it', () => assert.deepEqual(progress.daily, { current: 2, best: 2, lastWinDay: '2026-03-01' }));
    await page.clock.setFixedTime(new Date('2026-03-03T20:00:00Z'));
    await page.click('#btn-complete-menu');
    await freshBoard(page);
    await finishBoard(page);
    progress = await storedJson(page, PROGRESS_STORE);
    check('a missed day breaks it', () => assert.deepEqual(progress.daily, { current: 1, best: 2, lastWinDay: '2026-03-03' }));
  });

  await scenario('corrupt progress', { seed: { [PROGRESS_STORE]: '{"version":1,"totals":{' } }, async (page, check) => {
    const backup = await page.evaluate((key) => localStorage.getItem(`${key}:corrupt`), PROGRESS_STORE);
    const repaired = await storedJson(page, PROGRESS_STORE);
    check('the damaged record is kept aside and replaced on load', () => {
      assert.equal(backup, '{"version":1,"totals":{');
      assert.equal(repaired.version, 2);
    });
    await freshBoard(page);
    await finishBoard(page);
    const progress = await storedJson(page, PROGRESS_STORE);
    check('and tracking carries on', () => assert.equal(progress.totals.wins, 1));
  });

  await scenario('denied storage', { denyStorage: true }, async (page, check) => {
    await freshBoard(page);
    await finishBoard(page);
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    const tracked = await page.evaluate(async () => {
      const tracker = await import('./progress-tracker.js');
      return { progress: tracker.getProgress(), status: tracker.getProgressStatus() };
    });
    check('a game still completes and is tracked for the session', () => {
      assert.ok(completion, 'no completion');
      assert.equal(tracked.progress.totals.wins, 1);
      assert.deepEqual(tracked.progress.recordedRuns, [completion.runId]);
      assert.equal(tracked.status.persistent, false, 'claims to have saved progress');
    });
    const listed = await trackedAchievements(page);
    check('achievements are tracked for the session too', () => {
      const first = listed.find((item) => item.id === 'wins-1');
      assert.deepEqual([first.unlocked, first.runId, first.unlockedAt], [true, completion.runId, completion.completedAt]);
    });
  });
}

// ----------------------------------------------------------- achievements ---

// A record with a handful of real unlocks, earned through the evaluator from
// valid completions, for the views that need some of each state.
async function seededAchievementRecord() {
  const runtimeWindow = {};
  vm.runInNewContext(await readFile(path.join(rootDirectory, 'runtime-config.js'), 'utf8'), {
    window: runtimeWindow, document: { querySelector: () => null }, Number, Object, Math,
  });
  const runtime = runtimeWindow.DEJA_VU_RUNTIME;
  const catalog = buildAchievementCatalog(runtime);
  const games = [['easy', 0, 14, '2026-10-01'], ['easy', 1, 25, '2026-10-02'], ['intermediate', 0, 30, '2026-10-03'], ['insane', 3, 70, '2026-10-04']];
  let progress = createEmptyProgress();
  games.forEach(([difficultyKey, mistakes, seconds, day], index) => {
    const { pairs } = runtime.difficulties[difficultyKey];
    progress = recordCompletionAndAward(progress, {
      runId: `run-seeded-${index + 1}000`, difficultyKey, pairs, moves: pairs + mistakes, mistakes, perfect: !mistakes,
      elapsed: seconds, elapsedMs: seconds * 1000, score: runtime.calculateScore(difficultyKey, mistakes, seconds),
      bestMatchChain: mistakes ? Math.ceil(pairs / (mistakes + 1)) : pairs, finalMatchChain: mistakes ? 1 : pairs,
      day, completedAt: Date.parse(`${day}T12:00:00Z`),
    }, catalog, runtime, 0).progress;
  });
  return JSON.stringify(progress);
}

async function enterMenu(page) {
  await page.evaluate((url) => window.__deja.useIntroFixture(url), INTRO_FIXTURE);
  await page.click('#screen-start');
  await page.waitForFunction(() => document.querySelector('#screen-menu').classList.contains('is-active'), null, { timeout: 10000 });
  await page.evaluate(() => window.__deja.settle());
}

async function openAchievements(page) {
  await page.click('#btn-achievements');
  await page.waitForFunction(() => document.querySelector('#screen-achievements').classList.contains('is-active'), null, { timeout: 5000 });
  await page.evaluate(() => window.__deja.settle());
}

/** The notice on screen, once it has finished arriving, or null. */
async function shownNotice(page, timeout = 4000) {
  try {
    await page.waitForFunction(() => document.querySelector('.achievement-toast.is-shown'), null, { timeout });
  } catch (_) {
    return null;
  }
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const toast = document.querySelector('.achievement-toast.is-shown');
    if (!toast) return null;
    const rect = toast.getBoundingClientRect();
    const style = getComputedStyle(toast);
    return {
      eyebrow: toast.querySelector('.achievement-toast-eyebrow').textContent,
      title: toast.querySelector('.achievement-toast-title').textContent,
      count: Number(toast.dataset.count),
      source: toast.dataset.source,
      placement: document.querySelector('#achievement-toasts').dataset.placement,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      viewport: { width: innerWidth, height: innerHeight },
      transition: style.transitionDuration,
      transform: style.transform,
      focusInside: toast.contains(document.activeElement),
      live: document.querySelector('#achievement-live').textContent,
    };
  });
}

const noticeCount = (page) => page.evaluate(() => document.querySelectorAll('.achievement-toast').length);

function rectsOverlap(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const elementRects = (page, selector) => page.evaluate((query) => [...document.querySelectorAll(query)]
  .filter((node) => node.offsetParent !== null)
  .map((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  }), selector);

const screenRows = (page) => page.evaluate(() => [...document.querySelectorAll('#achievement-list .achievement')].map((row) => ({
  id: row.dataset.id,
  category: row.dataset.category,
  state: row.dataset.state,
  shown: !row.hidden && !row.closest('section').hidden,
  detail: row.querySelector('.achievement-detail').textContent,
  datetime: row.querySelector('time')?.dateTime || null,
})));

const pressedFilters = (page) => page.evaluate(() => [...document.querySelectorAll('#screen-achievements .filter-chip[aria-pressed="true"]')]
  .map((chip) => chip.dataset.category ?? `state:${chip.dataset.state}`));

const focusedId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);

async function auditAchievements(runner, browser, baseUrl) {
  const seeded = await seededAchievementRecord();
  const scenario = async (label, options, body) => {
    runner.group(`achievements/${label}`);
    const { context, page, errors } = await progressPage(browser, baseUrl, options);
    const check = (name, fn) => runner.check(`${label} — ${name}`, fn);
    try {
      await body(page, check, context);
      check('no page errors', () => assert.deepEqual(errors, []));
    } catch (error) {
      check('runs to completion', () => {
        throw new Error(String(error?.message || error).split('\n')[0]);
      });
    } finally {
      await context.close();
    }
  };

  // Phones and tablets: every view reachable, notices clear of the menu and
  // inside the safe area, the results highlight within its dialog.
  for (const viewport of MOBILE_VIEWPORTS) {
    const label = `layout ${viewport.name}`;
    runner.group(`achievements/${label}`);
    const context = await isolatedContext(browser, {
      viewport: { width: viewport.width, height: viewport.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block',
    });
    await context.addInitScript(progressProbes, { seed: { [PROGRESS_STORE]: seeded } });
    await context.addInitScript({ path: PROBES_PATH });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => {
      if (!/reading 'scope'/.test(String(error))) errors.push(String(error));
    });
    const check = (name, fn) => runner.check(`${label} — ${name}`, fn);
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await enterMenu(page);
      await auditView(runner, page, `${label} menu`, SCREEN_ESSENTIALS.menu);
      await openAchievements(page);
      await auditView(runner, page, `${label} achievements`, SCREEN_ESSENTIALS.achievements);

      await page.click('#btn-reset-achievements');
      await page.waitForFunction(() => document.querySelector('#reset-achievements-dialog').open);
      const resetFocus = await focusedId(page);
      check('the reset confirmation opens on its safe choice', () => assert.equal(resetFocus, 'btn-keep-achievements'));
      await auditView(runner, page, `${label} reset dialog`, DIALOG_ESSENTIALS['reset-achievements-dialog']);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#reset-achievements-dialog').open);
      await page.waitForTimeout(100);
      const afterEscape = await focusedId(page);
      const stillSeeded = await page.evaluate((key) => localStorage.getItem(key), PROGRESS_STORE);
      check('Escape cancels it, back on the reset button, nothing reset', () => {
        assert.equal(afterEscape, 'btn-reset-achievements');
        assert.deepEqual(JSON.parse(stillSeeded).achievements.unlocked, JSON.parse(seeded).achievements.unlocked);
      });

      await page.click('#screen-achievements [data-back-menu]');
      await page.waitForFunction(() => document.querySelector('#screen-menu').classList.contains('is-active'));
      await page.evaluate(() => window.__deja.settle());
      // As a player arrives at it (the audit above scrolled it to the end).
      await page.evaluate(() => document.querySelector('#screen-menu').scrollTo(0, 0));
      const before = await focusedId(page);
      await announceUnlocks(page, fakeAchievements(3));
      const notice = await shownNotice(page);
      const buttons = await elementRects(page, '.menu-nav button');
      check('a notice over the menu takes no focus and covers no menu button', () => {
        assert.ok(notice, 'no notice appeared');
        assert.equal(notice.placement, 'top');
        assert.equal(notice.focusInside, false);
        assert.ok(notice.rect.left >= 0 && notice.rect.right <= notice.viewport.width && notice.rect.top >= 0, 'outside the viewport');
        assert.ok(buttons.every((button) => !rectsOverlap(button, notice.rect)), 'covers a menu button');
        assert.match(notice.live, /3 achievements unlocked/);
      });
      const after = await focusedId(page);
      check('focus stays where it was', () => assert.equal(after, before));
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-top', '47px');
        document.documentElement.style.setProperty('--safe-left', '30px');
        document.documentElement.style.setProperty('--safe-right', '30px');
      });
      const inset = await page.evaluate(() => {
        const rect = document.querySelector('.achievement-toast').getBoundingClientRect();
        return { top: rect.top, left: rect.left, right: innerWidth - rect.right };
      });
      check('and stays inside the safe area', () => {
        assert.ok(inset.top >= 47, `top ${inset.top}`);
        assert.ok(inset.left >= 30 && inset.right >= 30, `sides ${inset.left}/${inset.right}`);
      });
      await page.evaluate(() => ['--safe-top', '--safe-left', '--safe-right'].forEach((name) => document.documentElement.style.removeProperty(name)));
      await page.click('.achievement-toast-close');
      await page.waitForFunction(() => !document.querySelector('.achievement-toast'), null, { timeout: 2000 });

      // A completion's unlocks, announced while the board is up.
      await page.evaluate(() => window.__deja.showScreen('game'));
      await announceUnlocks(page, fakeAchievements(5, 'run'), 'completion');
      await page.evaluate(() => window.__deja.openDialog('complete-dialog'));
      await auditView(runner, page, `${label} results with achievements`, COMPLETE_WITH_UNLOCKS);
      const noticesUnderResults = await noticeCount(page);
      check('no notice is shown with the results', () => assert.equal(noticesUnderResults, 0));
      await page.evaluate(() => window.__deja.closeDialogs());
      check('no page errors', () => assert.deepEqual(errors, []));
    } catch (error) {
      check('runs to completion', () => {
        throw new Error(String(error?.message || error).split('\n')[0]);
      });
    } finally {
      await context.close();
    }
  }

  await scenario('awards in play', {}, async (page, check) => {
    await enterMenu(page);
    await freshBoard(page);
    await finishBoard(page);
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    const progress = await storedJson(page, PROGRESS_STORE);
    const earned = unlockedBy(progress, completion.runId);
    const listed = await trackedAchievements(page);
    const names = listed.filter((item) => earned.includes(item.id)).map((item) => item.name);
    const results = await page.evaluate(() => ({
      shown: !document.querySelector('#complete-achievements').hidden,
      heading: document.querySelector('#complete-achievements strong')?.textContent,
      names: document.querySelector('.completion-achievement-names')?.textContent,
      describedBy: document.querySelector('#complete-dialog').getAttribute('aria-describedby'),
      focus: document.activeElement?.id,
      notices: document.querySelectorAll('.achievement-toast').length,
    }));
    check('the results highlight exactly what this game unlocked', () => {
      assert.ok(earned.length >= 5, `only ${earned.length} unlocked`);
      assert.equal(results.shown, true);
      assert.equal(results.heading, `${earned.length} achievements unlocked:`);
      for (const name of names) assert.ok(results.names.includes(name), `${name} is missing`);
      assert.match(results.describedBy, /complete-achievements/, 'not part of the dialog description');
    });
    check('without taking focus from Play Again or showing a notice', () => {
      assert.equal(results.focus, 'btn-play-again');
      assert.equal(results.notices, 0);
    });
    await page.click('#btn-complete-menu');
    await page.waitForTimeout(800);
    const repeated = await noticeCount(page);
    check('unlocks shown in the results are not repeated as a notice', () => assert.equal(repeated, 0));

    await openAchievements(page);
    const scene = await page.evaluate(async () => (await import('./audio-manager.js')).getMusicState().scene);
    const rows = await screenRows(page);
    const count = await page.textContent('#achievements-unlocked');
    const day = new Date(completion.completedAt).toISOString().slice(0, 10);
    check('the screen plays the menu music and shows the unlocks with their dates', () => {
      assert.equal(scene, 'menu');
      assert.equal(count, String(earned.length));
      assert.equal(rows.length, 100);
      const unlockedRows = rows.filter((row) => row.state === 'unlocked');
      assert.deepEqual(unlockedRows.map((row) => row.id).sort(), earned);
      assert.ok(unlockedRows.every((row) => row.datetime?.startsWith(day)), 'an unlock date is missing or wrong');
      assert.ok(rows.filter((row) => row.state === 'locked').every((row) => row.detail.length > 0), 'a locked row shows no progress');
    });

    await page.click('.achievement-state-filters [data-state="unlocked"]');
    let shown = (await screenRows(page)).filter((row) => row.shown);
    check('the Unlocked filter shows only unlocked ones', () => {
      assert.equal(shown.length, earned.length);
      assert.ok(shown.every((row) => row.state === 'unlocked'));
    });
    await page.click('.achievement-filters [data-category="speed"]');
    shown = (await screenRows(page)).filter((row) => row.shown);
    const status = await page.textContent('#achievements-filter-status');
    check('a category narrows it further, and the change is announced', () => {
      assert.ok(shown.length > 0 && shown.every((row) => row.category === 'speed' && row.state === 'unlocked'));
      assert.match(status, new RegExp(`Showing ${shown.length} unlocked Speed achievement`));
    });
    await page.focus('.achievement-filters [data-category="all"]');
    await page.keyboard.press('ArrowRight');
    const moved = await page.evaluate(() => document.activeElement.dataset.category);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const pressed = await pressedFilters(page);
    shown = (await screenRows(page)).filter((row) => row.shown);
    check('filters work from the keyboard', () => {
      assert.equal(moved, 'wins');
      assert.deepEqual(pressed, ['difficulty', 'state:unlocked']);
      assert.ok(shown.every((row) => row.category === 'difficulty'));
    });
  });

  await scenario('Continue earns at completion', {}, async (page, check) => {
    await enterMenu(page);
    await freshBoard(page);
    const pairs = await cardPairs(page);
    await turnPair(page, ...pairs[0]);
    await turnPair(page, ...pairs[1]);
    await page.click('#btn-game-menu');
    const saved = await storedJson(page, GAME_STORE);
    const before = await storedJson(page, PROGRESS_STORE);
    check('nothing is unlocked mid-game', () => assert.deepEqual(before.achievements.unlocked, {}));
    await continueAfterReload(page);
    await finishBoard(page);
    const progress = await storedJson(page, PROGRESS_STORE);
    const [announced] = await progressEvents(page, 'deja-vu:achievements-unlocked');
    const highlighted = await page.evaluate(() => !document.querySelector('#complete-achievements').hidden);
    check('the continued run earns its achievements once, under its own id', () => {
      assert.equal(announced.runId, saved.runId);
      assert.ok(unlockedBy(progress, saved.runId).includes('perfect-1'));
      assert.equal(highlighted, true);
    });
  });

  await scenario('a notice when the results were never shown', { seed: FULL_MOTION }, async (page, check) => {
    await enterMenu(page);
    await freshBoard(page);
    const pairs = await cardPairs(page);
    for (const pair of pairs.slice(0, -1)) await turnPair(page, ...pair);
    await turnPair(page, ...pairs.at(-1));
    // Straight to the menu, before the results dialog opens.
    await page.click('#btn-game-menu');
    const [completion] = await progressEvents(page, 'deja-vu:completion');
    const progress = await storedJson(page, PROGRESS_STORE);
    const earned = unlockedBy(progress, completion.runId);
    const notice = await shownNotice(page);
    const resultsOpened = await page.evaluate(() => document.querySelector('#complete-dialog').open);
    check('the run\'s unlocks arrive as one notice on the menu instead', () => {
      assert.equal(resultsOpened, false);
      assert.ok(notice, 'no notice');
      assert.equal(notice.count, earned.length);
      assert.equal(notice.eyebrow, `${earned.length} achievements unlocked`);
      assert.equal(notice.focusInside, false);
    });
    await page.click('.achievement-toast-view');
    await page.waitForFunction(() => document.querySelector('#screen-achievements').classList.contains('is-active'), null, { timeout: 3000 });
    await page.waitForTimeout(400);
    const remaining = await noticeCount(page);
    check('View opens the Achievements screen', () => assert.equal(remaining, 0));

    // A notice is taken down when a dialog comes up, and shown again later.
    await page.click('#screen-achievements [data-back-menu]');
    await announceUnlocks(page, fakeAchievements(1, 'held'));
    assert.ok(await shownNotice(page), 'no notice');
    await page.click('#btn-new-game');
    await page.waitForFunction(() => document.querySelector('#difficulty-dialog').open);
    const underDialog = await noticeCount(page);
    await page.click('#difficulty-dialog .dialog-cancel');
    const again = await shownNotice(page);
    check('a dialog withdraws a notice, which returns in full afterwards', () => {
      assert.equal(underDialog, 0);
      assert.equal(again?.title, 'held achievement 1');
    });
    await page.click('.achievement-toast-close');

    // A burst while the board is up: held, merged, bounded.
    await freshBoard(page);
    for (let index = 0; index < 8; index += 1) await announceUnlocks(page, fakeAchievements(2, `burst${index}`));
    const duringPlay = await noticeCount(page);
    await page.click('#btn-game-menu');
    const seen = [];
    for (let index = 0; index < 6; index += 1) {
      const shownNow = await shownNotice(page, 2500);
      if (!shownNow) break;
      seen.push(shownNow.count);
      await page.click('.achievement-toast-close');
    }
    check('notices wait while the board is up, then arrive merged and bounded', () => {
      assert.equal(duringPlay, 0);
      assert.ok(seen.length <= 3, `${seen.length} notices`);
      assert.equal(seen.reduce((sum, value) => sum + value, 0), 16, 'an unlock was lost');
    });
  });

  await scenario('repeated restarts and rapid input', {}, async (page, check) => {
    await enterMenu(page);
    for (let index = 0; index < 5; index += 1) await pickDifficulty(page, 'easy');
    await freshBoard(page);
    const abandoned = await progressEvents(page, 'deja-vu:run-abandoned');
    let unlocks = await progressEvents(page, 'deja-vu:achievements-unlocked');
    check('restarting earns and shows nothing', () => {
      assert.ok(abandoned.length >= 5, `${abandoned.length} abandoned`);
      assert.deepEqual(unlocks, []);
    });

    await finishBoard(page);
    const first = (await progressEvents(page, 'deja-vu:completion')).at(-1);
    await page.click('#btn-play-again');
    await page.waitForFunction(() => !document.querySelector('#complete-dialog').open
      && !document.querySelector('#card-grid').classList.contains('is-previewing'), null, { timeout: 15000 });
    const cleared = await page.evaluate(() => document.querySelector('#complete-achievements').hidden);
    // The last pair of the second game with the board mashed as it resolves.
    const pairs = await cardPairs(page);
    for (const pair of pairs.slice(0, -1)) await turnPair(page, ...pair);
    await page.evaluate((last) => {
      const cards = [...document.querySelectorAll('#card-grid .memory-card')];
      cards[last[0]].click();
      cards[last[1]].click();
      for (let round = 0; round < 20; round += 1) cards.forEach((card) => card.click());
    }, pairs.at(-1));
    await page.waitForFunction(() => document.querySelector('#complete-dialog').open, null, { timeout: 5000 });
    const completions = await progressEvents(page, 'deja-vu:completion');
    const second = completions.at(-1);
    unlocks = await progressEvents(page, 'deja-vu:achievements-unlocked');
    const progress = await storedJson(page, PROGRESS_STORE);
    const listed = await trackedAchievements(page);
    const nameOf = (id) => listed.find((item) => item.id === id).name;
    const highlightNames = await page.textContent('.completion-achievement-names');
    check('Play Again clears the last highlight; each game shows only its own', () => {
      assert.equal(cleared, true);
      assert.equal(completions.length, 2, 'mashing the board completed it twice');
      assert.deepEqual(unlocks.map((event) => event.runId), [first.runId, second.runId]);
      for (const id of unlockedBy(progress, second.runId)) assert.ok(highlightNames.includes(nameOf(id)));
      for (const id of unlockedBy(progress, first.runId)) assert.ok(!highlightNames.includes(nameOf(id)), `${id} carried over`);
    });

    await page.click('#btn-complete-menu');
    await openAchievements(page);
    await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#screen-achievements .filter-chip')];
      for (let index = 0; index < 60; index += 1) chips[(index * 7) % chips.length].click();
    });
    const pressed = await pressedFilters(page);
    const rows = await screenRows(page);
    check('rapid filter changes settle consistently', () => {
      assert.equal(pressed.length, 2, `${pressed.join(', ')} pressed`);
      const [category, state] = [pressed[0], pressed[1].slice('state:'.length)];
      for (const row of rows) {
        const expected = (category === 'all' || row.category === category) && (state === 'all' || row.state === state);
        assert.equal(row.shown, expected, `${row.id} shown=${row.shown}`);
      }
    });
  });

  await scenario('reset', { seed: { [PROGRESS_STORE]: seeded, [STATS_STORE]: JSON.stringify({ played: 4, won: 4, perfect: 2, bestScore: 13000, bests: {} }) } }, async (page, check) => {
    await enterMenu(page);
    await openAchievements(page);
    const statsBefore = await page.evaluate((key) => localStorage.getItem(key), STATS_STORE);
    const before = await storedJson(page, PROGRESS_STORE);
    await page.click('#btn-reset-achievements');
    const message = await page.textContent('#reset-achievements-message');
    await page.click('#btn-keep-achievements');
    const kept = await storedJson(page, PROGRESS_STORE);
    check('the confirmation says what is lost and what is kept; Keep changes nothing', () => {
      assert.match(message, new RegExp(`all ${Object.keys(before.achievements.unlocked).length} unlocked achievements`));
      assert.deepEqual(kept, before);
    });
    await page.click('#btn-reset-achievements');
    await page.click('#btn-confirm-reset-achievements');
    await page.waitForFunction(() => document.querySelector('#achievements-unlocked').textContent === '0');
    const after = await storedJson(page, PROGRESS_STORE);
    const statsAfter = await page.evaluate((key) => localStorage.getItem(key), STATS_STORE);
    await page.waitForTimeout(150);
    const ui = await page.evaluate(() => ({
      note: document.querySelector('#achievements-note').textContent,
      live: document.querySelector('#achievement-live').textContent,
      focus: document.activeElement?.id,
    }));
    check('Reset achievements clears unlocks and their progress, and nothing else', () => {
      assert.deepEqual(after.achievements.unlocked, {});
      assert.equal(after.totals.wins, 0);
      assert.ok(Number.isSafeInteger(after.achievements.resetAt));
      assert.deepEqual(after.recordedRuns, before.recordedRuns, 'the ledger is kept');
      assert.equal(statsAfter, statsBefore, 'statistics changed');
      assert.match(ui.note, /Counting since/);
      assert.match(ui.live, /Achievements reset/);
      assert.equal(ui.focus, 'btn-reset-achievements');
    });

    // Statistics reset keeps its own meaning: unlocks stay.
    await page.click('#screen-achievements [data-back-menu]');
    await freshBoard(page);
    await finishBoard(page);
    await page.click('#btn-complete-menu');
    await page.click('#btn-statistics');
    await page.click('#btn-reset-stats');
    await page.waitForTimeout(150);
    const statsReset = await storedJson(page, PROGRESS_STORE);
    check('a statistics reset still keeps unlocked achievements', () => {
      assert.ok(Object.hasOwn(statsReset.achievements.unlocked, 'wins-1'));
      assert.equal(statsReset.totals.wins, 0);
    });
  });

  {
    const legacyStats = { played: 6, won: 5, perfect: 2, bestScore: 5900, bests: { easy: { time: 15, mistakes: 0, score: 5900 } } };
    await scenario('migration notice', { seed: { [STATS_STORE]: JSON.stringify(legacyStats) } }, async (page, check) => {
      const progress = await storedJson(page, PROGRESS_STORE);
      const backfilled = unlockedBy(progress, null);
      await enterMenu(page);
      const notice = await shownNotice(page);
      check('an upgrade says once what earlier games unlocked', () => {
        assert.ok(backfilled.length >= 5, `${backfilled.length} backfilled`);
        assert.equal(notice?.source, 'history');
        assert.equal(notice?.count, backfilled.length);
        assert.equal(notice?.eyebrow, 'From your earlier games');
      });
      await page.reload({ waitUntil: 'load' });
      await enterMenu(page);
      const again = await shownNotice(page, 1500);
      check('and not again after a reload', () => assert.equal(again, null));
      await openAchievements(page);
      const rows = (await screenRows(page)).filter((row) => row.state === 'unlocked');
      check('the screen marks them as from earlier games', () => {
        assert.deepEqual(rows.map((row) => row.id).sort(), backfilled);
        assert.ok(rows.every((row) => row.detail.startsWith('From earlier games')));
      });
    });
  }

  await scenario('missing achievements module', {}, async (page, check, context) => {
    await context.route('**/achievements-ui.js', (route) => route.abort());
    await page.reload({ waitUntil: 'load' });
    await enterMenu(page);
    await freshBoard(page);
    await finishBoard(page);
    const progress = await storedJson(page, PROGRESS_STORE);
    await page.click('#btn-complete-menu');
    await openAchievements(page);
    const fallback = await page.textContent('#achievement-list');
    check('the game still plays and records achievements; the screen says why it is empty', () => {
      assert.ok(Object.keys(progress.achievements.unlocked).length > 0);
      assert.match(fallback, /could not be shown/);
    });
  });

  await scenario('missing card art', {}, async (page, check, context) => {
    await context.route('**/card-flip-sprite-sheet.png', (route) => route.abort());
    await page.reload({ waitUntil: 'load' });
    await enterMenu(page);
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await openAchievements(page);
    const badges = await page.evaluate(() => document.querySelectorAll('#achievement-list svg.achievement-badge use[href^="#ach-glyph-"]').length);
    // Music may still be buffering; nothing else may be fetched.
    const fetched = requests.filter((url) => !/\.(mp3|mp4)(\?|$)/.test(decodeURIComponent(url)));
    check('badges are inline: the screen draws without any download', () => {
      assert.equal(badges, 100);
      assert.deepEqual(fetched, []);
    });
  });

  for (const reduced of [true, false]) {
    await scenario(`notices with ${reduced ? 'reduced motion' : 'animations'}`, reduced ? {} : { seed: FULL_MOTION }, async (page, check) => {
      await enterMenu(page);
      await announceUnlocks(page, fakeAchievements(1));
      const notice = await shownNotice(page);
      const seconds = Math.max(...notice.transition.split(',').map((value) => parseFloat(value)));
      check(reduced ? 'arrive without moving' : 'slide in briefly', () => {
        if (reduced) {
          assert.ok(seconds < 0.01, `transition ${notice.transition}`);
          assert.equal(notice.transform, 'none');
        } else {
          assert.ok(seconds >= 0.1, `transition ${notice.transition}`);
        }
      });
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
    if (SUITE_FILTER.has('offline')) {
      await auditOffline(runner, browser, server.baseUrl);
      await auditWorker(runner, browser);
    }
    if (SUITE_FILTER.has('sprites')) await auditSprites(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('loading')) await auditLoading(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('lifecycle')) await auditLifecycle(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('progress')) await auditProgress(runner, browser, server.baseUrl);
    if (SUITE_FILTER.has('achievements')) await auditAchievements(runner, browser, server.baseUrl);
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
