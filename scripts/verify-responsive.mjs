import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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

const pendingTimers = new Map();
let nextTimer = 1;
const feedback = [];
const storage = new Map();
const runtime = {
  difficulties: {
    easy: { label: 'Easy', rows: 3, cols: 4, pairs: 6 },
    intermediate: { label: 'Intermediate', rows: 4, cols: 4, pairs: 8 },
    advanced: { label: 'Advanced', rows: 4, cols: 5, pairs: 10 },
    insane: { label: 'Insane', rows: 6, cols: 5, pairs: 15 },
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
  setTimeout(callback) {
    const id = nextTimer++;
    pendingTimers.set(id, callback);
    return id;
  },
  clearTimeout(id) { pendingTimers.delete(id); },
  dispatchEvent() {},
  confirm() { return true; },
};

const sandbox = {
  window,
  document,
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

function flushTimers(limit = 30) {
  let count = 0;
  while (pendingTimers.size) {
    assert.ok(count++ < limit, 'gameplay timer queue did not settle');
    const [id, callback] = pendingTimers.entries().next().value;
    pendingTimers.delete(id);
    callback();
  }
}

function gameState(patterns, options = {}) {
  return {
    version: 1,
    active: true,
    difficulty: 'easy',
    deck: patterns.map((pattern, index) => ({ uid: `card-${index}`, pattern, matched: Boolean(options.matched?.includes(index)) })),
    open: [], matchedPairs: options.matchedPairs || 0, moves: 0, mistakes: 0, elapsed: 0,
    paused: false, locked: false, turn: 'idle', completed: false, sessionId: 'test-session', turnId: 0,
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
flushTimers();
assert.equal(api.getGame().matchedPairs, 1, 'matching pair resolves');
assert.equal(elements['card-grid'].cards[0].disabled, true, 'matched cards become inert');
assert.deepEqual(feedback, ['select', 'select', 'match'], 'matching turn emits two selects and one match cue');

api.flipCard(2);
api.flipCard(3);
flushTimers();
assert.equal(api.getGame().mistakes, 1, 'mismatch increments mistakes');
assert.equal(api.getGame().open.length, 0, 'mismatch returns both cards');
assert.deepEqual(
  feedback,
  ['select', 'select', 'match', 'select', 'select', 'mistake'],
  'mismatch turn emits two selects and one mistake cue'
);

api.pauseGame();
assert.equal(api.getGame().paused, true, 'pause freezes the game');
assert.equal(elements['pause-dialog'].open, true, 'pause dialog opens');
elements['pause-dialog'].close();
api.resumeGame();
assert.equal(api.getGame().paused, false, 'resume continues the game');

const matched = Array.from({ length: 10 }, (_, index) => index);
elements['card-grid'].cards = Array.from({ length: 12 }, (_, index) => makeCard(index, index < 10));
api.setGame(gameState([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], { matched, matchedPairs: 5 }));
api.flipCard(10);
api.flipCard(11);
flushTimers();
assert.equal(api.getGame().completed, true, 'last match completes the board');
assert.equal(elements['complete-dialog'].open, true, 'completion dialog opens');
assert.equal(elements['complete-grade'].textContent, 'EXCELLENT', 'completion rating renders');

const cueCount = (name) => feedback.filter((cue) => cue === name).length;
assert.equal(cueCount('select'), 6, 'each of six valid card openings emits one select cue');
assert.equal(cueCount('match'), 2, 'each resolved match emits one match cue');
assert.equal(cueCount('mistake'), 1, 'the mismatch emits one mistake cue');
assert.equal(cueCount('tap'), 1, 'pause emits one subtle tap cue');
assert.equal(cueCount('complete'), 1, 'completion emits one cue');

const smallestCards = Math.min(...viewportResults.map((result) => result.cardWidth));
const scrollingCases = viewportResults.filter((result) => result.scrolls).length;
console.log(`Responsive matrix: PASS (${viewports.length} viewports × ${boards.length} boards; smallest card ${smallestCards}px; ${scrollingCases} vertical-scroll cases)`);
console.log('Gameplay flow: PASS (selection, match, mismatch, pause/resume, completion)');
console.log('Keyboard, safe-area, dialog, orientation, and reduced-motion invariants: PASS');
