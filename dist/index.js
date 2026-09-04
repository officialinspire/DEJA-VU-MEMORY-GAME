const STORAGE = {
  settings: 'inspireDejaVu:v1:settings',
  game: 'inspireDejaVu:v1:activeGame',
  stats: 'inspireDejaVu:v1:statistics',
};

const DIFFICULTIES = {
  easy: { label: 'Easy', rows: 3, cols: 4, pairs: 6 },
  intermediate: { label: 'Intermediate', rows: 4, cols: 4, pairs: 8 },
  advanced: { label: 'Advanced', rows: 4, cols: 5, pairs: 10 },
  insane: { label: 'Insane', rows: 6, cols: 5, pairs: 15 },
};

const PATTERNS = [
  { col: 0, row: 0, name: 'red circle' },
  { col: 1, row: 0, name: 'blue square' },
  { col: 2, row: 0, name: 'green triangle' },
  { col: 3, row: 0, name: 'purple rectangle' },
  { col: 4, row: 0, name: 'orange oval' },
  { col: 0, row: 1, name: 'cyan diamond' },
  { col: 1, row: 1, name: 'pink pentagon' },
  { col: 2, row: 1, name: 'yellow hexagon' },
  { col: 3, row: 1, name: 'teal octagon' },
  { col: 4, row: 1, name: 'gold star' },
  { col: 0, row: 2, name: 'purple crescent' },
  { col: 1, row: 2, name: 'red semicircle' },
  { col: 2, row: 2, name: 'orange trapezoid' },
  { col: 3, row: 2, name: 'green parallelogram' },
  { col: 4, row: 2, name: 'blue kite' },
  { col: 0, row: 3, name: 'pink cross' },
  { col: 1, row: 3, name: 'purple spiral' },
];

const TIMING = Object.freeze({
  normal: Object.freeze({
    cardFlip: 430,
    matchResolve: 460,
    mismatchStudy: 920,
    mismatchFlipBack: 470,
    completionDialog: 450,
  }),
  reduced: Object.freeze({
    cardFlip: 1,
    matchResolve: 10,
    mismatchStudy: 120,
    mismatchFlipBack: 10,
    completionDialog: 10,
  }),
});

function timing(name) {
  return (settings.reducedMotion ? TIMING.reduced : TIMING.normal)[name];
}

const DEFAULT_SETTINGS = {
  theme: 'cyber',
  mode: 'dark',
  music: true,
  musicVolume: 0.22,
  sfx: true,
  sfxVolume: 0.35,
  reducedMotion: false,
};

const DEFAULT_STATS = {
  played: 0,
  won: 0,
  perfect: 0,
  bestScore: 0,
  bests: {},
};

const screens = [...document.querySelectorAll('.screen')];
const startScreen = document.querySelector('#screen-start');
const introVideo = document.querySelector('#intro-video');
const skipIntroButton = document.querySelector('#btn-skip-intro');
const continueButton = document.querySelector('#btn-continue');
const cardGrid = document.querySelector('#card-grid');
const gameMessage = document.querySelector('#game-message');
const liveStatus = document.querySelector('#live-status');
const difficultyDialog = document.querySelector('#difficulty-dialog');
const pauseDialog = document.querySelector('#pause-dialog');
const completeDialog = document.querySelector('#complete-dialog');

let settings = readStorage(STORAGE.settings, DEFAULT_SETTINGS);
let statistics = readStorage(STORAGE.stats, DEFAULT_STATS);
let game = createEmptyGame();
let currentScreen = 'start';
let started = false;
let gameGeneration = 0;
const gameplayTimers = new Set();
let audioContext = null;
let musicFadeFrame = 0;

const music = new Audio('./deja-vu-theme.mp3');
music.loop = true;
music.preload = 'auto';
music.volume = 0;

function installCardFlipPolish() {
  if (document.querySelector('#deja-vu-card-flip-polish')) return;
  const style = document.createElement('style');
  style.id = 'deja-vu-card-flip-polish';
  style.textContent = `
    :root { --card-flip-duration: ${TIMING.normal.cardFlip}ms; }
    .memory-card {
      transform: translateZ(0);
      -webkit-tap-highlight-color: transparent;
    }
    .memory-card-inner {
      will-change: transform;
      transform-origin: center center;
      transition-duration: var(--card-flip-duration) !important;
    }
    .card-side {
      transform-style: preserve-3d;
      -webkit-transform-style: preserve-3d;
    }
    .card-side-back {
      transform: rotateY(0deg) translateZ(0.2px);
    }
    .card-side-front {
      transform: rotateY(180deg) translateZ(0.2px);
    }
    .memory-card.is-flipped,
    .memory-card.is-matched {
      pointer-events: none;
    }
    .memory-card.is-matched .memory-card-inner {
      transition: none !important;
    }
    .reduced-motion .memory-card-inner {
      transition-duration: ${TIMING.reduced.cardFlip}ms !important;
    }
  `;
  document.head.append(style);
}

function createSessionId() {
  return crypto.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEmptyGame() {
  return {
    version: 1,
    active: false,
    difficulty: 'easy',
    deck: [],
    open: [],
    matchedPairs: 0,
    moves: 0,
    mistakes: 0,
    elapsed: 0,
    paused: false,
    locked: false,
    turn: 'idle',
    completed: false,
    sessionId: '',
    turnId: 0,
  };
}

function scheduleGameplayTask(callback, delay) {
  const generation = gameGeneration;
  const sessionId = game.sessionId;
  const turnId = game.turnId;
  const timer = window.setTimeout(() => {
    gameplayTimers.delete(timer);
    if (generation !== gameGeneration) return;
    if (sessionId !== game.sessionId) return;
    if (turnId !== game.turnId) return;
    callback();
  }, delay);
  gameplayTimers.add(timer);
  return timer;
}

function cancelGameplayTasks() {
  gameplayTimers.forEach((timer) => window.clearTimeout(timer));
  gameplayTimers.clear();
}

function beginGameGeneration() {
  cancelGameplayTasks();
  gameGeneration += 1;
}

function resetTransientTurn() {
  game.open = [];
  game.locked = false;
  game.turn = 'idle';
}

function readStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === 'object' ? { ...fallback, ...value } : { ...fallback };
  } catch (_) {
    return { ...fallback };
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    announce('Progress could not be saved on this device.');
    return false;
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}

function showScreen(name) {
  currentScreen = name;
  screens.forEach((screen) => {
    const active = screen.id === `screen-${name}`;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
  });
  const activeScreen = document.querySelector(`#screen-${name}`);
  activeScreen?.focus({ preventScroll: true });
}

function announce(message) {
  liveStatus.textContent = '';
  requestAnimationFrame(() => {
    liveStatus.textContent = message;
  });
}

function setGameMessage(message, tone = '') {
  gameMessage.textContent = message;
  gameMessage.classList.toggle('is-success', tone === 'success');
  gameMessage.classList.toggle('is-error', tone === 'error');
}

function beginExperience() {
  if (started) return;
  started = true;
  initAudio();
  showScreen('intro');
  introVideo.currentTime = 0;
  const playback = introVideo.play();
  if (playback?.catch) playback.catch(showMenu);
}

function showMenu() {
  introVideo.pause();
  beginGameGeneration();
  if (game.active) resetTransientTurn();
  if (pauseDialog.open) pauseDialog.close();
  if (completeDialog.open) completeDialog.close();
  updateContinueButton();
  showScreen('menu');
  fadeMusic(settings.music ? settings.musicVolume : 0, 850);
}

function updateContinueButton() {
  continueButton.disabled = !hasValidSavedGame();
}

function hasValidSavedGame() {
  const saved = readStorage(STORAGE.game, {});
  return Boolean(
    saved.active &&
    DIFFICULTIES[saved.difficulty] &&
    Array.isArray(saved.deck) &&
    saved.deck.length === DIFFICULTIES[saved.difficulty].pairs * 2
  );
}

function openDifficultyDialog() {
  playSound('tap');
  difficultyDialog.showModal();
  difficultyDialog.querySelector('[data-difficulty]')?.focus();
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function createDeck(pairCount) {
  const chosen = shuffle(PATTERNS.map((_, index) => index)).slice(0, pairCount);
  const pairs = chosen.flatMap((pattern) => [
    { uid: crypto.randomUUID?.() || `${pattern}-a-${Math.random()}`, pattern, matched: false },
    { uid: crypto.randomUUID?.() || `${pattern}-b-${Math.random()}`, pattern, matched: false },
  ]);
  return shuffle(pairs);
}

function startNewGame(difficultyKey, skipConfirm = false) {
  if (!DIFFICULTIES[difficultyKey]) return;
  if (!skipConfirm && game.active && !window.confirm('Start a new game? Your current board will be replaced.')) return;

  beginGameGeneration();
  const difficulty = DIFFICULTIES[difficultyKey];
  game = {
    ...createEmptyGame(),
    active: true,
    difficulty: difficultyKey,
    deck: createDeck(difficulty.pairs),
    sessionId: createSessionId(),
  };
  statistics.played += 1;
  writeStorage(STORAGE.stats, statistics);
  saveGame();
  difficultyDialog.close();
  renderGame();
  showScreen('game');
  fadeMusic(settings.music ? settings.musicVolume * 0.78 : 0, 650);
  requestAnimationFrame(() => cardGrid.querySelector('.memory-card')?.focus());
  playSound('start');
}

function resumeSavedGame() {
  const saved = readStorage(STORAGE.game, {});
  if (!saved.active || !DIFFICULTIES[saved.difficulty] || !Array.isArray(saved.deck)) {
    updateContinueButton();
    return;
  }
  beginGameGeneration();
  game = {
    ...createEmptyGame(),
    ...saved,
    open: [],
    paused: false,
    locked: false,
    turn: 'idle',
    completed: false,
    sessionId: createSessionId(),
    turnId: 0,
    deck: saved.deck.map((card) => ({ ...card })),
  };
  renderGame();
  showScreen('game');
  fadeMusic(settings.music ? settings.musicVolume * 0.78 : 0, 650);
  requestAnimationFrame(() => cardGrid.querySelector('.memory-card:not(:disabled)')?.focus());
  playSound('tap');
}

function saveGame() {
  if (!game.active) return;
  const stableGame = {
    ...game,
    open: [],
    paused: false,
    locked: false,
    turn: 'idle',
    completed: false,
    sessionId: '',
    turnId: 0,
    deck: game.deck.map((card) => ({ ...card })),
  };
  writeStorage(STORAGE.game, stableGame);
  updateContinueButton();
}

function renderGame() {
  const difficulty = DIFFICULTIES[game.difficulty];
  document.querySelector('#game-difficulty').textContent = difficulty.label;
  cardGrid.style.setProperty('--cols', difficulty.cols);
  cardGrid.setAttribute('aria-rowcount', difficulty.rows);
  cardGrid.setAttribute('aria-colcount', difficulty.cols);
  cardGrid.replaceChildren();

  game.deck.forEach((card, index) => {
    const pattern = PATTERNS[card.pattern];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'memory-card';
    button.dataset.index = String(index);
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-rowindex', String(Math.floor(index / difficulty.cols) + 1));
    button.setAttribute('aria-colindex', String((index % difficulty.cols) + 1));
    button.setAttribute('aria-label', card.matched ? `Matched ${pattern.name}` : `Hidden card ${index + 1}`);
    button.setAttribute('aria-pressed', card.matched ? 'true' : 'false');
    button.disabled = card.matched;
    button.classList.toggle('is-matched', card.matched);
    button.innerHTML = `
      <span class="memory-card-inner" aria-hidden="true">
        <span class="card-side card-side-back"></span>
        <span class="card-side card-side-front" style="--sprite-x:${pattern.col * 25}%;--sprite-y:${pattern.row * 33.333333}%"></span>
      </span>`;
    button.addEventListener('click', () => flipCard(index));
    cardGrid.append(button);
  });

  updateGameDisplay();
  setGameMessage('Find every matching pair.');
}

function updateGameDisplay() {
  const difficulty = DIFFICULTIES[game.difficulty];
  document.querySelector('#stat-moves').textContent = String(game.moves);
  document.querySelector('#stat-mistakes').textContent = String(game.mistakes);
  document.querySelector('#stat-time').textContent = formatTime(game.elapsed);
  document.querySelector('#pairs-label').textContent = `${game.matchedPairs} of ${difficulty.pairs} pairs found`;
  document.querySelector('#match-progress').style.width = `${(game.matchedPairs / difficulty.pairs) * 100}%`;
}

function flipCard(index) {
  if (!game.active || game.paused || game.locked || game.completed) return;
  if (!['idle', 'one-open'].includes(game.turn)) return;
  if (game.open.length >= 2) return;

  const card = game.deck[index];
  const button = cardGrid.querySelector(`[data-index="${index}"]`);
  if (!card || card.matched || game.open.includes(index) || !button || button.disabled) return;

  if (game.open.length === 0) game.turnId += 1;
  game.open.push(index);
  game.turn = game.open.length === 1 ? 'one-open' : 'resolving';
  button.classList.add('is-flipped');
  button.setAttribute('aria-label', PATTERNS[card.pattern].name);
  button.setAttribute('aria-pressed', 'true');
  playSound('flip');

  if (game.open.length === 1) {
    setGameMessage('Choose its match.');
    return;
  }

  game.moves += 1;
  game.locked = true;
  const [firstIndex, secondIndex] = game.open;
  const first = game.deck[firstIndex];
  const second = game.deck[secondIndex];
  if (!first || !second || firstIndex === secondIndex) {
    resetTransientTurn();
    renderGame();
    return;
  }
  updateGameDisplay();

  if (first.pattern === second.pattern) {
    scheduleGameplayTask(() => resolveMatch(firstIndex, secondIndex), timing('matchResolve'));
  } else {
    game.mistakes += 1;
    updateGameDisplay();
    setGameMessage('Not a match — remember both positions.', 'error');
    playSound('miss');
    const firstButton = cardGrid.querySelector(`[data-index="${firstIndex}"]`);
    const secondButton = cardGrid.querySelector(`[data-index="${secondIndex}"]`);
    firstButton?.classList.add('is-wrong');
    secondButton?.classList.add('is-wrong');
    scheduleGameplayTask(() => beginMismatchFlipBack(firstIndex, secondIndex), timing('mismatchStudy'));
  }
}

function isCurrentResolvingPair(firstIndex, secondIndex) {
  return Boolean(
    game.active &&
    !game.completed &&
    game.locked &&
    game.turn === 'resolving' &&
    game.open.length === 2 &&
    game.open[0] === firstIndex &&
    game.open[1] === secondIndex &&
    game.deck[firstIndex] &&
    game.deck[secondIndex]
  );
}

function resolveMatch(firstIndex, secondIndex) {
  if (!isCurrentResolvingPair(firstIndex, secondIndex)) return;
  const first = game.deck[firstIndex];
  const second = game.deck[secondIndex];
  if (first.matched || second.matched || first.pattern !== second.pattern) return;

  first.matched = true;
  second.matched = true;
  game.matchedPairs += 1;
  resetTransientTurn();

  [firstIndex, secondIndex].forEach((index) => {
    const button = cardGrid.querySelector(`[data-index="${index}"]`);
    if (!button) return;
    button.classList.add('is-matched');
    button.classList.remove('is-flipped');
    button.disabled = true;
    button.setAttribute('aria-label', `Matched ${PATTERNS[game.deck[index].pattern].name}`);
    button.setAttribute('aria-pressed', 'true');
  });

  updateGameDisplay();
  setGameMessage('Match found.', 'success');
  announce(`Match found. ${game.matchedPairs} pairs complete.`);
  playSound('match');

  if (game.matchedPairs >= DIFFICULTIES[game.difficulty].pairs) {
    completeGame();
  } else {
    saveGame();
    focusNextCard(secondIndex);
  }
}

function beginMismatchFlipBack(firstIndex, secondIndex) {
  if (!isCurrentResolvingPair(firstIndex, secondIndex)) return;
  const first = game.deck[firstIndex];
  const second = game.deck[secondIndex];
  if (first.matched || second.matched || first.pattern === second.pattern) return;

  [firstIndex, secondIndex].forEach((index) => {
    const button = cardGrid.querySelector(`[data-index="${index}"]`);
    if (!button) return;
    button.classList.remove('is-wrong');
    button.classList.remove('is-flipped');
    button.setAttribute('aria-label', `Hidden card ${index + 1}`);
    button.setAttribute('aria-pressed', 'false');
  });

  setGameMessage('Try again.');
  scheduleGameplayTask(() => finishMismatch(firstIndex, secondIndex), timing('mismatchFlipBack'));
}

function finishMismatch(firstIndex, secondIndex) {
  if (!isCurrentResolvingPair(firstIndex, secondIndex)) return;
  resetTransientTurn();
  saveGame();
  focusNextCard(secondIndex);
}

function focusNextCard(fromIndex) {
  const candidates = [...cardGrid.querySelectorAll('.memory-card:not(:disabled)')];
  const next = candidates.find((button) => Number(button.dataset.index) > fromIndex) || candidates[0];
  next?.focus({ preventScroll: true });
}

function completeGame() {
  if (!game.active || game.completed) return;
  game.completed = true;
  game.active = false;
  game.paused = true;
  game.locked = true;
  game.turn = 'complete';
  beginGameGeneration();
  removeStorage(STORAGE.game);
  updateContinueButton();

  const pairs = DIFFICULTIES[game.difficulty].pairs;
  const score = Math.max(0, pairs * 1000 - game.mistakes * 350 - game.elapsed * 5);
  const grade = game.mistakes === 0
    ? 'Perfect Recall'
    : game.mistakes <= Math.ceil(pairs * 0.25)
      ? 'Sharp Memory'
      : game.mistakes <= Math.ceil(pairs * 0.6)
        ? 'Pattern Seeker'
        : 'Memory Rebuilt';

  statistics.won += 1;
  statistics.perfect += game.mistakes === 0 ? 1 : 0;
  statistics.bestScore = Math.max(statistics.bestScore || 0, score);
  const previous = statistics.bests[game.difficulty];
  statistics.bests[game.difficulty] = {
    time: previous ? Math.min(previous.time, game.elapsed) : game.elapsed,
    mistakes: previous ? Math.min(previous.mistakes, game.mistakes) : game.mistakes,
    score: previous ? Math.max(previous.score, score) : score,
  };
  writeStorage(STORAGE.stats, statistics);

  document.querySelector('#complete-grade').textContent = grade;
  document.querySelector('#complete-summary').textContent = `${game.moves} moves · ${game.mistakes} mistakes · ${formatTime(game.elapsed)}`;
  document.querySelector('#complete-score').textContent = score.toLocaleString();
  fadeMusic(settings.music ? settings.musicVolume : 0, 750);
  scheduleGameplayTask(() => {
    if (!game.completed || currentScreen !== 'game') return;
    completeDialog.showModal();
    document.querySelector('#btn-play-again').focus();
    playSound('win');
  }, timing('completionDialog'));
}

function pauseGame() {
  if (!game.active || game.completed || currentScreen !== 'game' || pauseDialog.open) return;
  game.paused = true;
  saveGame();
  fadeMusic(settings.music ? settings.musicVolume * 0.25 : 0, 350);
  pauseDialog.showModal();
  document.querySelector('#btn-resume').focus();
  playSound('tap');
}

function resumeGame() {
  if (!game.active || game.completed) return;
  game.paused = false;
  fadeMusic(settings.music ? settings.musicVolume * 0.78 : 0, 350);
  requestAnimationFrame(() => cardGrid.querySelector('.memory-card:not(:disabled)')?.focus());
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renderStatistics() {
  statistics = readStorage(STORAGE.stats, DEFAULT_STATS);
  document.querySelector('#stats-played').textContent = String(statistics.played || 0);
  document.querySelector('#stats-won').textContent = String(statistics.won || 0);
  document.querySelector('#stats-perfect').textContent = String(statistics.perfect || 0);
  document.querySelector('#stats-best-score').textContent = statistics.bestScore
    ? Number(statistics.bestScore).toLocaleString()
    : '—';

  const bestList = document.querySelector('#best-list');
  bestList.replaceChildren();
  Object.entries(DIFFICULTIES).forEach(([key, difficulty]) => {
    const best = statistics.bests?.[key];
    const row = document.createElement('div');
    row.className = 'best-row';
    row.innerHTML = `
      <strong>${difficulty.label}</strong>
      <span>${best ? formatTime(best.time) : 'No time'}</span>
      <span>${best ? `${best.mistakes} mistakes` : 'No score'}</span>`;
    bestList.append(row);
  });
}

function applySettings() {
  const validTheme = ['cyber', 'woodgrain', 'paper', 'light'].includes(settings.theme) ? settings.theme : 'cyber';
  const validMode = ['system', 'dark', 'light'].includes(settings.mode) ? settings.mode : 'dark';
  const resolvedMode = validMode === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : validMode;
  document.documentElement.dataset.theme = validTheme;
  document.documentElement.dataset.mode = resolvedMode;
  document.documentElement.classList.toggle('reduced-motion', Boolean(settings.reducedMotion));
  document.querySelector('meta[name="theme-color"]').content = resolvedMode === 'dark' ? '#07111f' : '#e8edf4';

  document.querySelector('#setting-theme').value = validTheme;
  document.querySelector('#setting-mode').value = validMode;
  document.querySelector('#setting-music').checked = Boolean(settings.music);
  document.querySelector('#setting-music-volume').value = String(settings.musicVolume);
  document.querySelector('#setting-sfx').checked = Boolean(settings.sfx);
  document.querySelector('#setting-sfx-volume').value = String(settings.sfxVolume);
  document.querySelector('#setting-motion').checked = Boolean(settings.reducedMotion);

  if (!settings.music) fadeMusic(0, 250);
  else if (currentScreen === 'menu') fadeMusic(settings.musicVolume, 300);
  else if (currentScreen === 'game' && !game.paused) fadeMusic(settings.musicVolume * 0.78, 300);
}

function saveSettings() {
  writeStorage(STORAGE.settings, settings);
  applySettings();
}

function initAudio() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioContext = new AudioContextClass();
  }
  audioContext?.resume?.();
}

function tone(frequency, duration, delay = 0, type = 'sine') {
  if (!settings.sfx || !audioContext) return;
  const start = audioContext.currentTime + delay;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, settings.sfxVolume * 0.12), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playSound(name) {
  initAudio();
  if (name === 'tap') tone(330, 0.06, 0, 'triangle');
  if (name === 'flip') tone(510, 0.07, 0, 'triangle');
  if (name === 'start') {
    tone(330, 0.09, 0, 'triangle');
    tone(495, 0.12, 0.07, 'triangle');
  }
  if (name === 'match') {
    tone(620, 0.13, 0, 'sine');
    tone(820, 0.18, 0.08, 'sine');
  }
  if (name === 'miss') tone(145, 0.2, 0, 'sawtooth');
  if (name === 'win') {
    tone(440, 0.18, 0, 'triangle');
    tone(660, 0.18, 0.12, 'triangle');
    tone(880, 0.28, 0.24, 'sine');
  }
}

function fadeMusic(targetVolume, duration = 500) {
  window.cancelAnimationFrame(musicFadeFrame);
  const target = Math.max(0, Math.min(1, Number(targetVolume) || 0));
  const startVolume = music.volume;
  const startTime = performance.now();
  if (target > 0) music.play().catch(() => {});

  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / Math.max(1, duration));
    music.volume = startVolume + (target - startVolume) * progress;
    if (progress < 1) {
      musicFadeFrame = requestAnimationFrame(step);
    } else if (target === 0) {
      music.pause();
    }
  };
  musicFadeFrame = requestAnimationFrame(step);
}

function handleGridKeys(event) {
  if (currentScreen !== 'game' || game.paused || game.locked || pauseDialog.open || completeDialog.open) return;
  const focused = document.activeElement.closest?.('.memory-card');
  if (!focused) return;
  const index = Number(focused.dataset.index);
  const cols = DIFFICULTIES[game.difficulty].cols;
  let nextIndex = null;
  if (event.key === 'ArrowLeft') nextIndex = index - 1;
  if (event.key === 'ArrowRight') nextIndex = index + 1;
  if (event.key === 'ArrowUp') nextIndex = index - cols;
  if (event.key === 'ArrowDown') nextIndex = index + cols;
  if (nextIndex === null) return;
  event.preventDefault();
  const total = game.deck.length;
  nextIndex = (nextIndex + total) % total;
  let attempts = 0;
  while (attempts < total) {
    const candidate = cardGrid.querySelector(`[data-index="${nextIndex}"]`);
    if (candidate && !candidate.disabled) {
      candidate.focus({ preventScroll: true });
      return;
    }
    nextIndex = (nextIndex + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + total) % total;
    attempts += 1;
  }
}

function handleMenuKeys(event) {
  if (currentScreen !== 'menu' || difficultyDialog.open) return;
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const buttons = [...document.querySelectorAll('.menu-nav button:not(:disabled)')];
  const currentIndex = buttons.indexOf(document.activeElement);
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[nextIndex]?.focus();
}

startScreen.addEventListener('pointerup', beginExperience, { once: true });
window.addEventListener('keydown', (event) => {
  if (currentScreen === 'start') beginExperience();
  if (event.key === 'Escape' && currentScreen === 'game') pauseGame();
  handleGridKeys(event);
  handleMenuKeys(event);
});

skipIntroButton.addEventListener('click', showMenu);
introVideo.addEventListener('ended', showMenu);
introVideo.addEventListener('error', showMenu);

document.querySelector('#btn-new-game').addEventListener('click', openDifficultyDialog);
continueButton.addEventListener('click', resumeSavedGame);
document.querySelector('#btn-statistics').addEventListener('click', () => {
  playSound('tap');
  renderStatistics();
  showScreen('statistics');
});
document.querySelector('#btn-how-to-play').addEventListener('click', () => {
  playSound('tap');
  showScreen('help');
});
document.querySelector('#btn-settings').addEventListener('click', () => {
  playSound('tap');
  applySettings();
  showScreen('settings');
});

document.querySelectorAll('[data-back-menu]').forEach((button) => button.addEventListener('click', () => {
  playSound('tap');
  showMenu();
}));

difficultyDialog.querySelectorAll('[data-difficulty]').forEach((button) => button.addEventListener('click', () => {
  startNewGame(button.dataset.difficulty);
}));

document.querySelector('#btn-game-menu').addEventListener('click', () => {
  saveGame();
  playSound('tap');
  showMenu();
});
document.querySelector('#btn-pause').addEventListener('click', pauseGame);
document.querySelector('#btn-resume').addEventListener('click', () => {
  playSound('tap');
  resumeGame();
});
document.querySelector('#btn-pause-menu').addEventListener('click', () => {
  saveGame();
  pauseDialog.close();
  playSound('tap');
  showMenu();
});
pauseDialog.addEventListener('close', () => {
  if (currentScreen === 'game' && game.active) resumeGame();
});

document.querySelector('#btn-play-again').addEventListener('click', () => {
  const difficulty = game.difficulty;
  completeDialog.close();
  startNewGame(difficulty, true);
});
document.querySelector('#btn-complete-menu').addEventListener('click', () => {
  completeDialog.close();
  playSound('tap');
  showMenu();
});

document.querySelector('#btn-reset-stats').addEventListener('click', () => {
  if (!window.confirm('Reset all DEJA VU statistics? This cannot be undone.')) return;
  statistics = { ...DEFAULT_STATS, bests: {} };
  writeStorage(STORAGE.stats, statistics);
  renderStatistics();
  announce('Statistics reset.');
  playSound('tap');
});

document.querySelector('#setting-theme').addEventListener('change', (event) => {
  settings.theme = event.target.value;
  saveSettings();
  playSound('tap');
});
document.querySelector('#setting-mode').addEventListener('change', (event) => {
  settings.mode = event.target.value;
  saveSettings();
  playSound('tap');
});
document.querySelector('#setting-music').addEventListener('change', (event) => {
  settings.music = event.target.checked;
  saveSettings();
  playSound('tap');
});
document.querySelector('#setting-music-volume').addEventListener('input', (event) => {
  settings.musicVolume = Number(event.target.value);
  saveSettings();
});
document.querySelector('#setting-sfx').addEventListener('change', (event) => {
  settings.sfx = event.target.checked;
  saveSettings();
  playSound('tap');
});
document.querySelector('#setting-sfx-volume').addEventListener('input', (event) => {
  settings.sfxVolume = Number(event.target.value);
  saveSettings();
});
document.querySelector('#setting-motion').addEventListener('change', (event) => {
  settings.reducedMotion = event.target.checked;
  saveSettings();
  playSound('tap');
});

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (settings.mode === 'system') applySettings();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.active && currentScreen === 'game') {
    game.paused = true;
    saveGame();
  } else if (!document.hidden && game.active && currentScreen === 'game' && !pauseDialog.open) {
    pauseGame();
  }
});

window.setInterval(() => {
  if (!game.active || game.paused || game.completed || currentScreen !== 'game') return;
  game.elapsed += 1;
  document.querySelector('#stat-time').textContent = formatTime(game.elapsed);
  if (game.elapsed % 5 === 0) saveGame();
}, 1000);

window.addEventListener('beforeunload', saveGame);

installCardFlipPolish();
applySettings();
updateContinueButton();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
