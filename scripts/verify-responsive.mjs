import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { isRunId, localDayKey } from '../progress-model.js';

const styles = fs.readFileSync('styles.css', 'utf8');
const responsive = fs.readFileSync('responsive-board.css', 'utf8');
const accessibility = fs.readFileSync('accessibility.js', 'utf8');
const indexSource = fs.readFileSync('index.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));

assert.equal(manifest.orientation, 'any');
assert.match(styles, /--safe-top:\s*env\(safe-area-inset-top/);
assert.match(styles, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
assert.match(styles, /\.game-screen\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(styles, /\.game-dialog\s*\{[^}]*safe-top[^}]*safe-bottom[^}]*overflow-y:\s*auto/s);
assert.match(styles, /html,\s*body\s*\{[^}]*min-width:\s*0/s);
assert.match(responsive, /\.icon-button\s*\{[^}]*min-width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem/s);
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(styles, /html\.reduced-motion \*/);
assert.match(indexSource, /button\.type = 'button'/);
assert.match(
  indexSource,
  /event\.key === 'Escape'[^\{]+!pauseDialog\.open\)\s*\{[^}]*event\.preventDefault\(\);[^}]*pauseGame\(\);/s,
  'Escape prevents the opening key from immediately canceling the pause dialog'
);
for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
  assert.match(indexSource, new RegExp(key));
}
assert.match(accessibility, /'Enter', ' '/);

const viewports = [
  [320, 568],
  [375, 667],
  [390, 844],
  [430, 932],
  [844, 390],
  [768, 1024],
  [1024, 768],
  [1280, 720],
  [1440, 900],
];

const boards = [
  { name: 'easy', cols: 4, rows: 3 },
  { name: 'intermediate', cols: 4, rows: 4 },
  { name: 'advanced', cols: 5, rows: 4 },
  { name: 'insane', cols: 5, rows: 6 },
];

function clamp(minimum, value, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeArea(width, height) {
  if (width === 844 && height === 390) return { top: 0, right: 44, bottom: 21, left: 44 };
  if ((width === 390 && height === 844) || (width === 430 && height === 932)) {
    return { top: 47, right: 0, bottom: 34, left: 0 };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function boardCap(width, height, board) {
  if (width >= 760) {
    if (board.rows === 6) return 28 * 16;
    return (board.cols === 5 ? 31 : 28) * 16;
  }
  if (height <= 520 && width > height) {
    if (board.rows === 6) return 24 * 16;
    return (board.cols === 5 ? 26 : 24) * 16;
  }
  if (board.rows === 6) return 24 * 16;
  return (board.cols === 5 ? 26 : 24) * 16;
}

function boardGap(width, height, board) {
  if (board.rows === 6 && height <= 760) return clamp(1.28, height * 0.004, 3.52);
  if (board.rows === 6) return clamp(1.92, height * 0.0055, 4.8);
  if (board.cols === 5 && width <= 430) return clamp(1.6, width * 0.0065, 4.48);
  if (board.cols === 5) return clamp(2.24, width * 0.008, 6.08);
  if (width <= 360) return 2.56;
  return clamp(3.2, width * 0.01, 7.36);
}

const viewportResults = [];
for (const [width, height] of viewports) {
  const safe = safeArea(width, height);
  const inlinePadding = width <= 430 ? 0.45 * 16 : 0.8 * 16;
  const availableWidth = width - safe.left - safe.right - inlinePadding * 2;
  assert.ok(availableWidth > 0, `${width}x${height} must retain usable inline space`);

  for (const board of boards) {
    const boardWidth = Math.min(availableWidth, boardCap(width, height, board));
    const gap = boardGap(width, height, board);
    const cardWidth = (boardWidth - gap * (board.cols - 1)) / board.cols;
    const boardHeight = board.rows * (cardWidth / 0.774) + gap * (board.rows - 1);

    assert.ok(boardWidth <= availableWidth + 0.01, `${board.name} overflows at ${width}x${height}`);
    assert.ok(cardWidth >= 44, `${board.name} cards fall below 44px at ${width}x${height}`);

    viewportResults.push({
      viewport: `${width}x${height}`,
      board: board.name,
      cardWidth: Math.round(cardWidth),
      scrolls: boardHeight + 130 + safe.top + safe.bottom > height,
    });
  }
}

class TestClassList {
  constructor(...names) { this.names = new Set(names); }
  add(...names) { names.forEach((name) => this.names.add(name)); }
  remove(...names) { names.forEach((name) => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.names.has(name) : Boolean(force);
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    return enabled;
  }
}

let document;
class TestElement {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.classList = new TestClassList();
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.style = { setProperty() {} };
    this.cards = [];
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelector(selector) {
    const index = selector.match(/^\[data-index="(\d+)"\]$/)?.[1];
    if (index !== undefined) return this.cards.find((card) => card.dataset.index === index) || null;
    if (selector === '.memory-card:not(:disabled)') return this.cards.find((card) => !card.disabled) || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.memory-card:not(:disabled)') return this.cards.filter((card) => !card.disabled);
    if (selector === '.memory-card') return [...this.cards];
    return [];
  }
}

const elementIds = [
  'screen-start', 'screen-intro', 'screen-menu', 'screen-game', 'intro-video', 'btn-skip-intro',
  'btn-continue', 'card-grid', 'game-message', 'live-status', 'difficulty-dialog', 'pause-dialog',
  'complete-dialog', 'stat-moves', 'stat-mistakes', 'stat-time', 'pairs-label', 'match-progress',
  'complete-grade', 'complete-performance', 'complete-difficulty', 'complete-moves',
  'complete-mistakes', 'complete-time', 'complete-summary', 'complete-score', 'btn-play-again',
  'btn-resume',
];
const elements = Object.fromEntries(elementIds.map((id) => [id, new TestElement(id)]));
elements['screen-game'].classList.add('screen');
elements['match-progress'].style = { width: '', setProperty() {} };

document = {
  activeElement: null,
  querySelector(selector) { return selector.startsWith('#') ? elements[selector.slice(1)] || null : null; },
  querySelectorAll(selector) { return selector === '.screen' ? [elements['screen-start'], elements['screen-intro'], elements['screen-menu'], elements['screen-game']] : []; },
};

// Fake timers with a fake clock: each timer remembers when it is due, and
// flushing runs them in due order, moving time forward as it goes.
const pendingTimers = new Map();
const events = [];
let nextTimer = 1;
let fakeNow = 0;
const feedback = [];
const storage = new Map();
const runtime = {
  difficulties: {
    easy: { label: 'Easy', rows: 3, cols: 4, pairs: 6, mismatchStudyMs: 1050 },
    intermediate: { label: 'Intermediate', rows: 4, cols: 4, pairs: 8, mismatchStudyMs: 950 },
    advanced: { label: 'Advanced', rows: 4, cols: 5, pairs: 10, mismatchStudyMs: 850 },
    insane: { label: 'Insane', rows: 6, cols: 5, pairs: 15, mismatchStudyMs: 750 },
  },
  calculatePerformance(key, mistakes, elapsed) {
    const pairs = this.difficulties[key].pairs;
    const score = Math.max(0, pairs * 1000 - mistakes * 350 - elapsed * 5);
    const performancePercent = Math.min(100, Math.max(0, Math.round(score / (pairs * 1000) * 100)));
    const rating = performancePercent >= 85 ? 'EXCELLENT' : performancePercent >= 70 ? 'GOOD' : performancePercent >= 50 ? 'AVERAGE' : 'POOR';
    return { score, performancePercent, rating };
  },
};

const window = {
  DEJA_VU_RUNTIME: runtime,
  setTimeout(callback, delay = 0) {
    const id = nextTimer++;
    pendingTimers.set(id, { callback, due: fakeNow + (Number(delay) || 0) });
    return id;
  },
  clearTimeout(id) { pendingTimers.delete(id); },
  // Details are copied out of the VM realm so deepStrictEqual compares values.
  dispatchEvent(event) { events.push({ type: event.type, detail: JSON.parse(JSON.stringify(event.detail ?? null)) }); },
  confirm() { return true; },
};

// The real gameplay clock, running on the fake timers above.
const clockSandbox = { window, performance: { now: () => fakeNow }, Math, Number, Set };
vm.runInNewContext(
  `${fs.readFileSync('gameplay-clock.js', 'utf8').replace(/^export /gm, '')}\nthis.gameplayClock = gameplayClock;`,
  clockSandbox,
  { filename: 'gameplay-clock.js' },
);
const clock = clockSandbox.gameplayClock;

const sandbox = {
  window,
  document,
  gameplayClock: clock,
  isRunId,
  localDayKey,
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  },
  crypto: { randomUUID: () => `test-${Math.random()}` },
  requestAnimationFrame: (callback) => callback(),
  CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  MUSIC_SCENES: { silent: 'silent', menu: 'menu', gameplay: 'gameplay' },
  configureMusic() {}, transitionMusic() {}, unlockMusic() {},
  configureFeedback() {}, unlockFeedback() {},
  playFeedback(cue) { feedback.push(cue); },
  console,
  Math,
  Number,
  Object,
  Boolean,
  JSON,
};

const bodyStart = indexSource.indexOf('const STORAGE');
const bindingStart = indexSource.indexOf("startScreen.addEventListener('pointerup'");
assert.ok(bodyStart >= 0 && bindingStart > bodyStart, 'index.js test seam must remain available');
const testableIndex = `${indexSource.slice(bodyStart, bindingStart)}
window.__DEJA_TEST__ = {
  flipCard,
  pauseGame,
  resumeGame,
  setGame(nextGame) { game = nextGame; },
  setScreen(name) { currentScreen = name; },
  getGame() { return game; },
  retire: beginGameGeneration,
};`;
vm.runInNewContext(testableIndex, sandbox, { filename: 'index.js' });

function makeCard(index, matched = false) {
  const card = new TestElement();
  card.dataset.index = String(index);
  card.classList.add('memory-card');
  card.disabled = matched;
  if (matched) card.classList.add('is-matched');
  return card;
}

function nextTimerEntry() {
  return [...pendingTimers.entries()].sort((left, right) => left[1].due - right[1].due)[0] || null;
}

function advance(ms) {
  fakeNow += ms;
}

/** Runs timers in due order until no gameplay work is left. */
function flushTimers(limit = 30) {
  let count = 0;
  while (clock.pendingTasks()) {
    assert.ok(count++ < limit, 'gameplay timer queue did not settle');
    const entry = nextTimerEntry();
    assert.ok(entry, 'gameplay work is pending with no timer armed (still suspended?)');
    const [id, timer] = entry;
    pendingTimers.delete(id);
    fakeNow = Math.max(fakeNow, timer.due);
    timer.callback();
  }
}

/** Ms of gameplay time until the next gameplay timer fires. */
function nextGameplayDelay() {
  const entry = nextTimerEntry();
  return entry ? entry[1].due - fakeNow : null;
}

function gameState(patterns, options = {}) {
  return {
    version: 1,
    active: true,
    difficulty: 'easy',
    deck: patterns.map((pattern, index) => ({ uid: `card-${index}`, pattern, matched: Boolean(options.matched?.includes(index)) })),
    open: [], matchedPairs: options.matchedPairs || 0, moves: 0, mistakes: 0, elapsed: 0,
    paused: false, locked: false, turn: 'idle', completed: false, sessionId: 'test-session', turnId: 0,
    runId: 'run-test-0001', chain: 0, bestChain: 0,
  };
}

const api = window.__DEJA_TEST__;
api.setScreen('game');
elements['card-grid'].cards = Array.from({ length: 12 }, (_, index) => makeCard(index));
api.setGame(gameState([0, 0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6]));

api.flipCard(0);
assert.equal(api.getGame().open.length, 1, 'first card opens');
assert.deepEqual(feedback, ['select'], 'valid card selection emits one select cue');
api.flipCard(1);
assert.equal(events.filter((event) => event.type === 'deja-vu:match').length, 0, 'a match is reported when it resolves, not when it is turned');
flushTimers();
assert.equal(api.getGame().matchedPairs, 1, 'matching pair resolves');
const matchEvent = events.find((event) => event.type === 'deja-vu:match');
assert.deepEqual(
  [matchEvent?.detail.runId, matchEvent?.detail.indices, matchEvent?.detail.chain, matchEvent?.detail.matchedPairs],
  ['run-test-0001', [0, 1], 1, 1],
  'the core reports the match with its run and chain',
);
assert.equal(elements['card-grid'].cards[0].disabled, true, 'matched cards become inert');
assert.deepEqual(feedback, ['select', 'select', 'match'], 'matching turn emits two selects and one match cue');

api.flipCard(2);
api.flipCard(3);
assert.equal(nextGameplayDelay(), 1050, 'a mismatch stays up for the difficulty\'s study time');
const mismatchEvent = events.find((event) => event.type === 'deja-vu:mismatch');
assert.deepEqual(
  [mismatchEvent?.detail.indices, mismatchEvent?.detail.mistakes, mismatchEvent?.detail.chain, api.getGame().bestChain],
  [[2, 3], 1, 0, 1],
  'a mistake is reported at once and ends the chain, not the best chain',
);
advance(400);
api.pauseGame();
assert.equal(clock.pendingTasks(), 1, 'pausing keeps the mismatch pending');
assert.equal(pendingTimers.size, 0, 'a paused game holds no native timers at all');
advance(5000);
elements['pause-dialog'].close();
clock.resume('pause');
api.resumeGame();
assert.equal(nextGameplayDelay(), 650, 'resuming continues the study time where it stopped');
assert.equal(api.getGame().open.length, 2, 'the mismatch is still on the table after the pause');
flushTimers();
assert.equal(api.getGame().mistakes, 1, 'mismatch increments mistakes');
assert.equal(api.getGame().open.length, 0, 'mismatch returns both cards');
assert.deepEqual(
  feedback,
  ['select', 'select', 'match', 'select', 'select', 'mistake', 'tap'],
  'mismatch turn emits two selects and one mistake cue (then the pause taps)'
);

api.pauseGame();
assert.equal(api.getGame().paused, true, 'pause freezes the game');
assert.equal(elements['pause-dialog'].open, true, 'pause dialog opens');
elements['pause-dialog'].close();
clock.resume('pause');
api.resumeGame();
assert.equal(api.getGame().paused, false, 'resume continues the game');

const matched = Array.from({ length: 10 }, (_, index) => index);
elements['card-grid'].cards = Array.from({ length: 12 }, (_, index) => makeCard(index, index < 10));
api.setGame(gameState([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], { matched, matchedPairs: 5 }));
api.flipCard(10);
api.flipCard(11);
flushTimers();
assert.equal(api.getGame().completed, true, 'last match completes the board');
const completion = events.find((event) => event.type === 'deja-vu:completion')?.detail;
assert.ok(completion, 'completion is reported');
assert.equal(completion.runId, 'run-test-0001', 'completion carries the run');
assert.equal(completion.pairs, 6);
assert.equal(completion.mistakes, 0);
assert.equal(completion.perfect, true);
assert.equal(completion.bestMatchChain, 1, 'the chain counts matches made in this run');
assert.equal(completion.finalMatchChain, 1);
assert.equal(completion.elapsed, Math.floor(completion.elapsedMs / 1000), 'whole seconds agree with the measured time');
assert.match(completion.day, /^\d{4}-\d{2}-\d{2}$/, 'completion is dated by the local calendar');
assert.equal(events.filter((event) => event.type === 'deja-vu:completion').length, 1, 'completion is reported once');
assert.equal(elements['complete-dialog'].open, true, 'completion dialog opens');
assert.equal(elements['complete-grade'].textContent, 'EXCELLENT', 'completion rating renders');

// A restart retires everything the old board still had pending.
elements['card-grid'].cards = Array.from({ length: 12 }, (_, index) => makeCard(index));
api.setGame(gameState([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0]));
api.flipCard(0);
api.flipCard(1);
assert.equal(clock.pendingTasks(), 1, 'a mismatch is pending');
api.retire();
assert.equal(clock.pendingTasks(), 0, 'a new generation cancels the old board\'s pending turn');
assert.equal(pendingTimers.size, 0, 'and its native timer');

const cueCount = (name) => feedback.filter((cue) => cue === name).length;
assert.equal(cueCount('select'), 8, 'each of eight valid card openings emits one select cue');
assert.equal(cueCount('match'), 2, 'each resolved match emits one match cue');
assert.equal(cueCount('mistake'), 2, 'each mismatch emits one mistake cue');
assert.equal(cueCount('tap'), 2, 'each of two pauses emits one subtle tap cue');
assert.equal(cueCount('complete'), 1, 'completion emits one cue');

const smallestCards = Math.min(...viewportResults.map((result) => result.cardWidth));
const scrollingCases = viewportResults.filter((result) => result.scrolls).length;
console.log(`Responsive matrix: PASS (${viewports.length} viewports × ${boards.length} boards; smallest card ${smallestCards}px; ${scrollingCases} vertical-scroll cases)`);
console.log('Gameplay flow: PASS (selection, match, mismatch, difficulty study time, pause freezes pending turns, restart cancels them, completion, authoritative match/mismatch/completion events)');
console.log('Keyboard, safe-area, dialog, orientation, and reduced-motion invariants: PASS');
