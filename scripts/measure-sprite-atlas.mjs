// Card-sprite cost meter: how long a board takes to create and how much canvas
// memory the card art holds.
//
//   node scripts/measure-sprite-atlas.mjs [--dist=path/to/dist] [--runs=7] [--cpu=4] [--json=out.json]
//
// --dist points at another build (an older checkout's dist/) so before/after
// numbers come from the same harness. Canvases are instrumented from outside
// the app, so the meter does not depend on how sprite-atlas.js is written.
//
// Main-thread time is Chromium's own TaskDuration for the page, from the
// difficulty click until two frames after it, so it covers the click handler,
// observers, style, layout, ResizeObserver and canvas painting. Canvas bytes
// are width x height x 4 for every canvas that has a 2D context. Headless
// desktop Chromium is not a phone: the phone profile reproduces a phone's
// viewport and pixel ratio, not its CPU, GPU or memory limits.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

import { distDirectory, missingBrowserMessage, resolveChromium, rootDirectory, startServer } from './browser-harness.mjs';

const PROBES_PATH = path.join(rootDirectory, 'scripts', 'browser-probes.js');
const SPRITE_PROBES_PATH = path.join(rootDirectory, 'scripts', 'sprite-probes.js');
const option = (name, fallback) => {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : fallback;
};
const DIST = path.resolve(option('dist', distDirectory));
const RUNS = Math.max(1, Number(option('runs', 7)));
const CPU_SLOWDOWN = Math.max(1, Number(option('cpu', 1)));
const JSON_OUT = option('json', '');
const WARM_BOARDS = 6;

const PROFILES = [
  { name: 'phone 390x844 @3x', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'desktop 1440x900 @1x', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'desktop 1440x900 @2x', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
];

// Same deal on every run and every build, so old and new paint the same cards.
function seedRandom() {
  let seed = 0x2f6b9a1d;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function frames(page, count = 2) {
  await page.evaluate((n) => new Promise((resolve) => {
    const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  }), count);
}

async function taskSeconds(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

async function measureBoard(page, cdp, difficulty) {
  await page.evaluate(() => window.__deja.openDialog('difficulty-dialog'));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__sprites.takeCounts());
  const before = await taskSeconds(cdp);
  const painted = await page.evaluate(async (value) => {
    document.querySelector(`[data-difficulty="${value}"]`).click();
    // Whatever the first frame shows is what a player sees first.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const sides = [...document.querySelectorAll('#card-grid .card-side')];
    return {
      sides: sides.length,
      painted: sides.filter((side) => side.querySelector('canvas')?.width > 0 && side.dataset.spritePainted).length,
    };
  }, difficulty);
  await frames(page, 2);
  const after = await taskSeconds(cdp);
  const draws = await page.evaluate(() => window.__sprites.takeCounts());
  const ms = (key) => (after[key] - before[key]) * 1000;
  return {
    taskMs: ms('TaskDuration'),
    scriptMs: ms('ScriptDuration'),
    styleLayoutMs: ms('RecalcStyleDuration') + ms('LayoutDuration'),
    ...draws,
    ...painted,
  };
}

async function rendererMemory(browserSession) {
  // Linux only: resident memory of the renderer, which owns software canvases.
  try {
    const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
    const { readFile } = await import('node:fs/promises');
    let total = 0;
    for (const info of processInfo.filter((entry) => entry.type === 'renderer')) {
      const status = await readFile(`/proc/${info.id}/status`, 'utf8');
      total += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0) * 1024;
    }
    return total || null;
  } catch (_) {
    return null;
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mb = (bytes) => (bytes == null ? 'n/a' : `${(bytes / 1048576).toFixed(1)} MB`);

async function runProfile(browser, baseUrl, profile) {
  const cold = [];
  const warm = [];
  const memory = [];
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: !!profile.isMobile,
      hasTouch: !!profile.hasTouch,
      // The worker's 8 MB precache would compete with what is being measured.
      serviceWorkers: 'block',
    });
    await context.addInitScript(seedRandom);
    await context.addInitScript({ path: SPRITE_PROBES_PATH });
    await context.addInitScript({ path: PROBES_PATH });
    const page = await context.newPage();
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (CPU_SLOWDOWN > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    const browserSession = await browser.newBrowserCDPSession();

    await page.goto(baseUrl, { waitUntil: 'load' });
    // Let the sheet load and decode as it would behind the start screen.
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__deja.showScreen('menu'));

    cold.push(await measureBoard(page, cdp, 'insane'));
    const afterOne = await page.evaluate(() => window.__sprites.canvases());
    for (let board = 0; board < WARM_BOARDS; board += 1) {
      warm.push(await measureBoard(page, cdp, 'insane'));
    }
    await page.waitForTimeout(300);
    const beforeGc = await page.evaluate(() => window.__sprites.canvases());
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(300);
    const afterGc = await page.evaluate(() => window.__sprites.canvases());
    memory.push({ afterOne, beforeGc, afterGc, rendererRss: await rendererMemory(browserSession) });

    await browserSession.detach().catch(() => {});
    await context.close();
  }
  return { cold, warm, memory };
}

function summarize(profile, result) {
  const pick = (list, key) => median(list.map((entry) => entry[key]));
  const last = result.memory[result.memory.length - 1];
  return {
    profile: profile.name,
    coldTaskMs: pick(result.cold, 'taskMs'),
    coldScriptMs: pick(result.cold, 'scriptMs'),
    warmTaskMs: pick(result.warm, 'taskMs'),
    warmScriptMs: pick(result.warm, 'scriptMs'),
    coldAtlasDraws: pick(result.cold, 'atlasDraws'),
    coldCanvasDraws: pick(result.cold, 'canvasDraws'),
    warmAtlasDraws: pick(result.warm, 'atlasDraws'),
    warmCanvasDraws: pick(result.warm, 'canvasDraws'),
    paintedInFirstFrame: `${Math.min(...result.cold.concat(result.warm).map((entry) => entry.painted))}/${result.cold[0].sides}`,
    boardCanvases: last.afterOne.attached,
    boardCanvasBytes: last.afterOne.attachedBytes,
    largestCanvas: last.afterOne.largest,
    cacheOrDetachedBytesAfterOne: last.afterOne.detachedBytes,
    detachedBytesAfter7Boards: last.beforeGc.detachedBytes,
    detachedBytesAfterGc: last.afterGc.detachedBytes,
    liveBytesAfterGc: last.afterGc.attachedBytes + last.afterGc.detachedBytes,
    rendererRss: median(result.memory.map((entry) => entry.rendererRss || 0)) || null,
  };
}

async function main() {
  const executablePath = resolveChromium(chromium);
  if (!executablePath) {
    console.error(missingBrowserMessage());
    process.exitCode = 1;
    return;
  }
  const server = await startServer({ directory: DIST });
  const browser = await chromium.launch({ executablePath });
  const summaries = [];
  try {
    for (const profile of PROFILES) {
      summaries.push(summarize(profile, await runProfile(browser, server.baseUrl, profile)));
    }
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(`Sprite meter — ${path.relative(rootDirectory, DIST) || DIST} — ${RUNS} runs, median`
    + `${CPU_SLOWDOWN > 1 ? `, CPU throttled ${CPU_SLOWDOWN}x` : ''}`);
  for (const s of summaries) {
    console.log(`\n${s.profile}`);
    console.log(`  Insane board, cold: ${s.coldTaskMs.toFixed(1)} ms main thread (${s.coldScriptMs.toFixed(1)} ms script), `
      + `${s.coldAtlasDraws} sheet draws + ${s.coldCanvasDraws} canvas copies`);
    console.log(`  Insane board, warm: ${s.warmTaskMs.toFixed(1)} ms main thread (${s.warmScriptMs.toFixed(1)} ms script), `
      + `${s.warmAtlasDraws} sheet draws + ${s.warmCanvasDraws} canvas copies`);
    console.log(`  Sides painted in the first frame: ${s.paintedInFirstFrame}`);
    console.log(`  On-page canvases after one board: ${s.boardCanvases} (${mb(s.boardCanvasBytes)}, largest ${s.largestCanvas}); `
      + `off-page: ${mb(s.cacheOrDetachedBytesAfterOne)}`);
    console.log(`  Off-page canvas memory after ${1 + WARM_BOARDS} boards: ${mb(s.detachedBytesAfter7Boards)} before GC, `
      + `${mb(s.detachedBytesAfterGc)} after GC; live total after GC ${mb(s.liveBytesAfterGc)}`);
    console.log(`  Renderer resident memory after GC: ${mb(s.rendererRss)}`);
  }
  if (JSON_OUT) await writeFile(JSON_OUT, `${JSON.stringify({ dist: DIST, runs: RUNS, cpu: CPU_SLOWDOWN, summaries }, null, 2)}\n`);
}

await main();
