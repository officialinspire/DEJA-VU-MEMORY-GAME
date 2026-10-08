import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
const distDirectory = path.join(rootDirectory, 'dist');

const readRoot = (relativePath) => readFile(path.join(rootDirectory, relativePath), 'utf8');

async function verifyRuntime() {
  const source = await readRoot('runtime-config.js');
  const document = {
    hidden: false,
    querySelector() { return null; },
  };
  const nativeSetTimeout = () => 1;
  const nativeSetInterval = () => 1;
  const window = { setTimeout: nativeSetTimeout, setInterval: nativeSetInterval };
  vm.runInNewContext(source, { document, window, Number, Object, Math }, { filename: 'runtime-config.js' });
  assert.equal(window.setTimeout, nativeSetTimeout, 'runtime config leaves setTimeout alone');
  assert.equal(window.setInterval, nativeSetInterval, 'runtime config leaves setInterval alone');

  const runtime = window.DEJA_VU_RUNTIME;
  assert.ok(runtime, 'runtime configuration installs');
  assert.equal(runtime.calculateScore('easy', 2, 10), 5250, 'score formula remains authoritative');

  const boundaries = [
    [0, 'POOR'], [49, 'POOR'], [50, 'AVERAGE'], [69, 'AVERAGE'],
    [70, 'GOOD'], [84, 'GOOD'], [85, 'EXCELLENT'], [100, 'EXCELLENT'],
  ];
  boundaries.forEach(([percent, rating]) => {
    assert.equal(runtime.getPerformanceRating(percent), rating, `${percent}% maps to ${rating}`);
  });

  const easyMaximum = runtime.difficulties.easy.pairs * runtime.scoring.basePerPair;
  [49, 50, 69, 70, 84, 85].forEach((percent) => {
    assert.equal(
      runtime.calculatePerformancePercent('easy', easyMaximum * percent / 100),
      percent,
      `${percent}% boundary is exact`
    );
  });

  for (const [key, studyMs] of [['easy', 1050], ['intermediate', 950], ['advanced', 850], ['insane', 750]]) {
    assert.equal(runtime.difficulties[key].mismatchStudyMs, studyMs, `${key} mismatch study time`);
  }
}

async function verifyGameplayClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const platform = {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  };
  // Runs every timer due by `time` in order; `late` makes each fire that many
  // ms after its due time, as real timers do.
  const runUntil = (time, late = 0) => {
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due + late > time) break;
      timers.delete(next[0]);
      now = next[1].due + late;
      next[1].callback();
    }
    now = time;
  };
  const source = (await readRoot('gameplay-clock.js')).replace(/^export /gm, '');
  const sandbox = { Math, Number, Set, performance: { now: () => now }, window: {} };
  vm.runInNewContext(`${source}\nthis.createGameplayClock = createGameplayClock;`, sandbox, { filename: 'gameplay-clock.js' });
  const clock = sandbox.createGameplayClock(platform);

  const fired = [];
  clock.schedule(() => fired.push('match'), 460);
  runUntil(459);
  assert.deepEqual(fired, [], 'a gameplay timer does not fire early');
  runUntil(460);
  assert.deepEqual(fired, ['match'], 'a gameplay timer fires on time');

  clock.schedule(() => fired.push('study'), 920);
  runUntil(760);
  clock.suspend('pause');
  assert.equal(timers.size, 0, 'a suspended clock holds no native timers');
  runUntil(10760);
  clock.suspend('hidden');
  clock.resume('pause');
  assert.equal(timers.size, 0, 'it stays frozen while any suspension remains');
  runUntil(12000);
  clock.resume('hidden');
  runUntil(12619);
  assert.deepEqual(fired, ['match'], 'resuming keeps the remaining time, not the wall time');
  runUntil(12620);
  assert.deepEqual(fired, ['match', 'study'], 'and fires once the remaining time has passed');

  const cancel = clock.schedule(() => fired.push('stale'), 100);
  clock.schedule(() => fired.push('stale'), 200);
  cancel();
  clock.cancelAll();
  runUntil(20000);
  assert.deepEqual(fired, ['match', 'study'], 'cancelled gameplay timers never fire');
  assert.equal(timers.size, 0, 'and leave no native timers behind');

  const seconds = [];
  clock.onSecond((second) => {
    assert.ok(clock.elapsedMs() >= second * 1000, `second ${second} is reported only once it has passed`);
    seconds.push(second);
  });
  now = 30000;
  clock.setCounting(true);
  runUntil(32500, 37);
  assert.equal(clock.elapsedMs(), 2500, 'the score clock counts play time');
  clock.exclude('preview');
  runUntil(36500, 37);
  assert.equal(clock.elapsedMs(), 2500, 'an excluded span (the memorize preview) is not scored');
  assert.equal(timers.size, 0, 'a stopped score clock holds no native timers');
  clock.include('preview');
  runUntil(37000, 37);
  clock.suspend('hidden');
  runUntil(47000, 37);
  assert.equal(clock.elapsedMs(), 3000, 'a hidden page is not scored');
  clock.resume('hidden');
  runUntil(54000, 37);
  assert.equal(clock.elapsedMs(), 10000, 'late timers cause no drift: time comes from timestamps');
  assert.deepEqual(seconds, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'each whole second is reported exactly once');
  clock.setCounting(false);
  assert.equal(timers.size, 0, 'nothing is left running once play stops');
  clock.resetElapsed(42500);
  assert.equal(clock.elapsedMs(), 42500, 'a resumed game restores its time');
}

async function verifyMusicManager() {
  let clock = 0;
  let nextFrame = 1;
  const frames = new Map();
  const audioInstances = [];

  class FakeAudio {
    constructor(source) {
      this.src = source;
      this.currentSrc = source;
      this.paused = true;
      this.volume = 0;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.loadCalls = 0;
      this.readyState = 0;
      this.preload = 'auto';
      audioInstances.push(this);
    }
    load() { this.loadCalls += 1; }
    play() { this.paused = false; this.playCalls += 1; return Promise.resolve(); }
    pause() { this.paused = true; this.pauseCalls += 1; }
  }

  const document = {
    hidden: false,
    addEventListener() {},
  };
  const window = {};
  const sandbox = {
    Audio: FakeAudio,
    cancelAnimationFrame(id) { frames.delete(id); },
    document,
    performance: { now: () => clock },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    URL,
    window,
  };
  const source = (await readRoot('audio-manager.js'))
    .replace(/new URL\((['"][^'"]+['"]), import\.meta\.url\)\.href/g, '$1')
    .replace(/export function /g, 'function ')
    .replace(/export \{ MUSIC_SCENES \};?/, '')
    .concat('\nwindow.__AUDIO_TEST__ = { MUSIC_SCENES, configureMusic, transitionMusic, unlockMusic, warmMusic, getMusicState };');
  vm.runInNewContext(source, sandbox, { filename: 'audio-manager.js' });
  const api = window.__AUDIO_TEST__;
  const advance = (time) => {
    clock = time;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
  };
  const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} is close to ${expected}`);

  assert.equal(audioInstances.length, 2, 'exactly two reusable music loops are created');
  assert.equal(audioInstances.reduce((total, audio) => total + audio.playCalls, 0), 0, 'music is silent before interaction');
  assert.deepEqual(audioInstances.map((audio) => audio.preload), ['none', 'none'], 'music downloads nothing before the card art');
  api.warmMusic();
  assert.deepEqual(audioInstances.map((audio) => audio.preload), ['auto', 'auto'], 'warming switches both loops to buffering');
  assert.deepEqual(audioInstances.map((audio) => audio.loadCalls), [1, 1], 'warming starts each idle loop loading once');
  api.warmMusic();
  assert.deepEqual(audioInstances.map((audio) => audio.loadCalls), [1, 1], 'warming twice does not restart a load');
  assert.equal(await api.unlockMusic(), true, 'initial gesture unlocks mobile audio');
  assert.deepEqual(audioInstances.map((audio) => audio.playCalls), [1, 1], 'unlock attempts each loop once');

  api.configureMusic({ musicEnabled: true, volume: 0.22 });
  api.transitionMusic(api.MUSIC_SCENES.menu, { duration: 750 });
  advance(375);
  assert.equal(audioInstances[0].paused, false, 'menu loop plays after interaction');
  advance(750);
  closeTo(audioInstances[0].volume, 0.22);
  assert.equal(audioInstances[1].paused, true, 'gameplay loop remains stopped in the menu');

  api.transitionMusic(api.MUSIC_SCENES.gameplay, { duration: 750 });
  advance(1125);
  assert.ok(audioInstances.every((audio) => !audio.paused), 'crossfade overlaps both loops');
  assert.ok(audioInstances.every((audio) => audio.volume > 0), 'both loops are audible during crossfade');
  advance(1500);
  assert.equal(audioInstances[0].paused, true, 'menu loop stops after gameplay crossfade');
  closeTo(audioInstances[1].volume, 0.22);

  const gameplayPlayCalls = audioInstances[1].playCalls;
  api.transitionMusic(api.MUSIC_SCENES.gameplay, { duration: 750 });
  advance(2250);
  assert.equal(audioInstances[1].playCalls, gameplayPlayCalls, 'current track is not restarted unnecessarily');

  api.transitionMusic(api.MUSIC_SCENES.menu, { duration: 750 });
  api.transitionMusic(api.MUSIC_SCENES.gameplay, { duration: 750 });
  advance(3000);
  assert.equal(api.getMusicState().scene, 'gameplay', 'rapid navigation cancels the stale fade');
  assert.equal(audioInstances[0].paused, true, 'stale menu loop is stopped');

  api.transitionMusic(api.MUSIC_SCENES.menu, { duration: 750 });
  advance(3750);
  assert.equal(audioInstances[1].paused, true, 'pause transition ends on menu music');
  api.transitionMusic(api.MUSIC_SCENES.gameplay, { duration: 750 });
  advance(4500);
  assert.equal(audioInstances[0].paused, true, 'resume transition ends on gameplay music');

  api.transitionMusic(api.MUSIC_SCENES.gameplay, { duration: 750, volumeScale: 0.45 });
  advance(5250);
  closeTo(audioInstances[1].volume, 0.099);

  api.configureMusic({ musicEnabled: false, volume: 0.22 });
  api.transitionMusic(api.MUSIC_SCENES.gameplay, { duration: 0 });
  assert.ok(audioInstances.every((audio) => audio.paused), 'music toggle silences both loops');
}

// Failure handling, on a fresh instance: a play() refused for want of a
// gesture waits for a real one, element errors are retried with a bound, and
// nothing plays while the page is hidden.
async function verifyMusicRecovery() {
  const instances = [];
  class FakeAudio {
    constructor(source) {
      this.src = source;
      this.paused = true;
      this.volume = 0;
      this.readyState = 0;
      this.error = null;
      this.playCalls = 0;
      this.loadCalls = 0;
      this.outcomes = [];
      this.listeners = {};
      instances.push(this);
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    load() { this.loadCalls += 1; this.error = null; }
    play() {
      this.playCalls += 1;
      const outcome = this.outcomes.shift() || 'ok';
      if (outcome === 'ok') { this.paused = false; return Promise.resolve(); }
      const error = new Error(outcome);
      error.name = outcome;
      return Promise.reject(error);
    }
    pause() { this.paused = true; }
    fail() {
      this.paused = true;
      this.error = { code: 2 };
      (this.listeners.error || []).forEach((listener) => listener());
    }
  }
  const listeners = (target) => {
    const map = new Map();
    target.addEventListener = (type, listener) => map.set(type, [...(map.get(type) || []), listener]);
    target.removeEventListener = (type, listener) => map.set(type, (map.get(type) || []).filter((item) => item !== listener));
    return map;
  };
  const document = { hidden: false };
  const documentListeners = listeners(document);
  const window = {};
  const windowListeners = listeners(window);
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const sandbox = {
    Audio: FakeAudio,
    document,
    window,
    URL,
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    performance: { now: () => now },
  };
  const source = (await readRoot('audio-manager.js'))
    .replace(/new URL\((['"][^'"]+['"]), import\.meta\.url\)\.href/g, '$1')
    .replace(/export function /g, 'function ')
    .replace(/export \{ MUSIC_SCENES \};?/, '')
    .concat('\nwindow.__AUDIO_TEST__ = { MUSIC_SCENES, configureMusic, transitionMusic, unlockMusic, getMusicState };');
  vm.runInNewContext(source, sandbox, { filename: 'audio-manager.js' });
  const api = window.__AUDIO_TEST__;
  const [menu, gameplay] = instances;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const gesture = (isTrusted) => (documentListeners.get('pointerup') || []).forEach((listener) => listener({ isTrusted }));
  const runTimers = async () => {
    for (;;) {
      await settle();
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) return;
      timers.delete(next[0]);
      now = next[1].due;
      next[1].callback();
    }
  };

  // Autoplay refused: each element waits for a real gesture of its own.
  menu.outcomes = ['NotAllowedError', 'NotAllowedError'];
  gameplay.outcomes = ['NotAllowedError'];
  assert.equal(await api.unlockMusic(), false, 'a refused unlock reports that music is still locked');
  api.configureMusic({ musicEnabled: true, volume: 0.22 });
  api.transitionMusic(api.MUSIC_SCENES.menu, { duration: 0 });
  await settle();
  let state = api.getMusicState();
  assert.ok(state.tracks.menu.needsGesture && state.tracks.gameplay.needsGesture, 'each refused track waits for a gesture');
  assert.ok((documentListeners.get('pointerup') || []).length > 0, 'a gesture retry is armed');
  const playsBefore = menu.playCalls + gameplay.playCalls;
  gesture(false);
  assert.equal(menu.playCalls + gameplay.playCalls, playsBefore, 'a synthetic event cannot stand in for a gesture');
  gesture(true);
  await settle();
  state = api.getMusicState();
  assert.equal(menu.paused, false, 'the next real gesture starts the scene\'s track');
  assert.equal(gameplay.paused, true, 'and unlocks the other without playing it');
  assert.ok(state.unlocked && state.tracks.menu.unlocked && state.tracks.gameplay.unlocked, 'both elements are unlocked');
  assert.equal((documentListeners.get('pointerup') || []).length, 0, 'the gesture retry disarms once nothing is waiting');

  // A transient element error is retried with backoff, a bounded number of times.
  menu.outcomes = ['NetworkError', 'NetworkError', 'NetworkError'];
  const playsBeforeError = menu.playCalls;
  menu.fail();
  await runTimers();
  assert.equal(menu.playCalls - playsBeforeError, 3, 'an element error is retried exactly three times');
  assert.ok(menu.loadCalls >= 1, 'a failed resource is fetched again before retrying');
  assert.equal(timers.size, 0, 'and then it stops: nothing keeps retrying in the background');
  assert.equal(now, 1000 + 2000 + 4000, 'with backoff between attempts');
  (windowListeners.get('online') || []).forEach((listener) => listener());
  await settle();
  assert.equal(menu.paused, false, 'coming back online gives it another try, which plays');

  // Hidden: retries never make a sound.
  menu.outcomes = [];
  document.hidden = true;
  (documentListeners.get('visibilitychange') || []).forEach((listener) => listener());
  const playsWhileHidden = menu.playCalls;
  menu.fail();
  await runTimers();
  assert.equal(menu.playCalls, playsWhileHidden, 'no retry plays while the page is hidden');
  assert.equal(menu.paused, true, 'the hidden page stays silent');
}

async function verifyFeedbackManager() {
  const oscillators = [];
  const vibrations = [];
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() {
      const oscillator = {
        frequency: {
          values: [],
          setValueAtTime(value) { this.values.push(['set', value]); },
          exponentialRampToValueAtTime(value) { this.values.push(['ramp', value]); },
        },
        connect() {}, start() {}, stop() {}, type: '',
      };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return {
        connect() {},
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      };
    }
    createBiquadFilter() {
      return {
        connect() {}, type: '',
        frequency: { setValueAtTime(value) { this.value = value; } },
      };
    }
  }

  const navigator = { vibrate(pattern) { vibrations.push(pattern); return true; } };
  const window = { AudioContext: FakeAudioContext };
  const sandbox = { navigator, window };
  const source = (await readRoot('feedback-manager.js'))
    .replace(/export function /g, 'function ')
    .concat('\nwindow.__FEEDBACK_TEST__ = { configureFeedback, playFeedback, getFeedbackState };');
  vm.runInNewContext(source, sandbox, { filename: 'feedback-manager.js' });
  const api = window.__FEEDBACK_TEST__;
  const reset = () => { oscillators.length = 0; vibrations.length = 0; };
  const plain = (value) => JSON.parse(JSON.stringify(value));

  api.configureFeedback({ soundEnabled: true, soundVolume: 0.35, vibrationEnabled: true });
  api.playFeedback('select');
  assert.equal(oscillators.length, 1, 'selection emits one soft tick');
  assert.equal(oscillators[0].frequency.values[0][1], 540);
  assert.deepEqual(plain(vibrations), [11], 'selection emits one subtle haptic');

  reset();
  api.playFeedback('match');
  assert.deepEqual(oscillators.map((item) => item.frequency.values[0][1]), [610, 790], 'match emits the two-note chime once');
  assert.deepEqual(plain(vibrations), [[15, 25, 20]], 'match emits one double pulse');

  reset();
  api.playFeedback('mistake');
  assert.equal(oscillators.length, 1, 'mistake emits one restrained pulse');
  assert.equal(oscillators[0].type, 'triangle', 'mistake avoids the harsh sawtooth waveform');
  assert.deepEqual(oscillators[0].frequency.values, [['set', 155], ['ramp', 112]]);
  assert.deepEqual(plain(vibrations), [[24, 35, 24]], 'mistake emits one heavier double pulse');

  reset();
  api.configureFeedback({ soundEnabled: false, soundVolume: 0.35, vibrationEnabled: true });
  api.playFeedback('select');
  assert.equal(oscillators.length, 0, 'disabling SFX leaves haptics independent');
  assert.deepEqual(plain(vibrations), [11]);

  reset();
  api.configureFeedback({ soundEnabled: true, soundVolume: 0.35, vibrationEnabled: false });
  api.playFeedback('select');
  assert.equal(oscillators.length, 1, 'disabling haptics leaves SFX independent');
  assert.equal(vibrations.length, 0);

  reset();
  sandbox.navigator = {};
  api.configureFeedback({ soundEnabled: false, soundVolume: 0.35, vibrationEnabled: true });
  assert.doesNotThrow(() => api.playFeedback('mistake'), 'unsupported vibration is silent and safe');
}

async function verifyAppShell() {
  const swSource = await readRoot('sw.js');
  const indexSource = await readRoot('index.html');
  const shellBody = swSource.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1] || '';
  const shellEntries = [...shellBody.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const shellSet = new Set(shellEntries);
  assert.equal(shellEntries.length, shellSet.size, 'service-worker app shell has no duplicate entries');
  assert.match(swSource, /const CACHE_VERSION = 'v1\.8\.2';/, 'cache version is bumped for this release');
  assert.match(swSource, /const CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{CACHE_VERSION\}@\$\{SCOPE_PATH\}`;/,
    'cache name is derived from CACHE_VERSION and the worker scope');
  assert.match(swSource, /if \(!url\.pathname\.startsWith\(SCOPE_PATH\)\) return;\n/, 'requests outside the scope are left alone');
  assert.match(swSource, /key\.endsWith\(`@\$\{SCOPE_PATH\}`\)/, 'activate clears only this scope\'s generations');
  assert.match(swSource, /event\.waitUntil\(warmMediaCache\(request\)\)/, 'media warming is kept alive by waitUntil');
  assert.match(swSource, /if \(!warming\.has\(key\)\)/, 'media warming is deduplicated per file');
  assert.match(swSource, /status: 416/, 'unsatisfiable ranges still answer 416');
  assert.ok(!/cache\.addAll\(/.test(swSource), 'precache is per-asset so one failure cannot abort install');
  assert.match(swSource, /status: 206/, 'cached media answers byte-range requests offline');
  assert.ok(!/skipWaiting\(\)/.test(swSource), 'no skipWaiting, so a session never mixes cache generations');

  const optionalBody = swSource.match(/const OPTIONAL_ASSETS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  const optionalEntries = [...optionalBody.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(optionalEntries.length > 0, 'optional assets are declared');
  optionalEntries.forEach((entry) => assert.ok(shellSet.has(entry), `${entry} is precached`));
  for (const entry of optionalEntries) {
    assert.ok(/\.(?:png|mp3|mp4)$/.test(entry), `${entry} is media or artwork, not required app code`);
  }
  // Required means the install fails without it: the app code, and the card
  // sprite sheet, without which no board can be drawn offline.
  const cardArt = './card-flip-sprite-sheet.png';
  assert.ok(!optionalEntries.includes(cardArt), 'the card sprite sheet is required, so offline readiness includes the cards');
  for (const entry of shellSet) {
    if (optionalEntries.includes(entry) || entry === cardArt) continue;
    assert.ok(/(?:^\.\/$|\.(?:html|css|js|webmanifest)$)/.test(entry), `${entry} is required app code`);
  }
  assert.match(swSource, /await store\(APP_SHELL\.filter\(\(path\) => !OPTIONAL_ASSETS\.has\(path\)\)\)/,
    'required entries are precached before optional media');
  assert.match(swSource, /fetch\(toAbsolute\(path\), \{ cache: 'no-cache' \}\)/,
    'precache revalidates instead of trusting or re-downloading the HTTP cache');

  const requiredSongs = [
    './Deja Vu - Main Menu (Vibe 1).mp3',
    './Minimalist Electronic Focus Theme.mp3',
  ];
  requiredSongs.forEach((song) => assert.ok(shellSet.has(song), `${song} is cached`));

  const localReferences = [...indexSource.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1].split(/[?#]/, 1)[0])
    .filter((value) => value && !/^(?:[a-z]+:|\/\/|#)/i.test(value));
  const moduleQueue = localReferences.filter((value) => value.endsWith('.js'));
  const checkedModules = new Set();

  while (moduleQueue.length) {
    const reference = moduleQueue.shift();
    const normalized = reference.startsWith('./') ? reference : `./${reference}`;
    if (checkedModules.has(normalized)) continue;
    checkedModules.add(normalized);
    const moduleSource = await readRoot(normalized.slice(2));
    for (const match of moduleSource.matchAll(/(?:from\s+|import\s*)['"](\.\/[^'"]+\.js)['"]/g)) {
      moduleQueue.push(match[1]);
    }
    for (const match of moduleSource.matchAll(/new URL\(['"](\.\/[^'"]+)['"],\s*import\.meta\.url\)/g)) {
      localReferences.push(match[1]);
    }
  }

  for (const reference of new Set([...localReferences, ...checkedModules])) {
    const normalized = reference.startsWith('./') ? reference : `./${reference}`;
    assert.ok(shellSet.has(normalized), `${normalized} is present in the app shell`);
  }

  for (const entry of shellSet) {
    if (entry === './') continue;
    const relativePath = entry.replace(/^\.\//, '');
    await access(path.join(rootDirectory, relativePath));
    await access(path.join(distDirectory, relativePath));
  }

  const activeFiles = new Set(['index.html', 'sw.js', ...[...shellSet].filter((entry) => entry !== './').map((entry) => entry.slice(2))]);
  for (const relativePath of activeFiles) {
    if (!/\.(?:html|js|css|webmanifest)$/.test(relativePath)) continue;
    const rootSource = await readFile(path.join(rootDirectory, relativePath), 'utf8');
    const distSource = await readFile(path.join(distDirectory, relativePath), 'utf8');
    assert.ok(!rootSource.includes('deja-vu-theme.mp3'), `${relativePath} has no legacy audio dependency`);
    assert.ok(!distSource.includes('deja-vu-theme.mp3'), `dist/${relativePath} has no legacy audio dependency`);
  }
}

await verifyRuntime();
await verifyGameplayClock();
await verifyMusicManager();
await verifyMusicRecovery();
await verifyFeedbackManager();
await verifyAppShell();

console.log('Runtime scoring: PASS (formula, difficulty study times, no timer overrides, and 49/50, 69/70, 84/85 boundaries)');
console.log('Gameplay clock: PASS (on time, pause/hidden freeze remaining time, no timers while frozen, cancellation, preview and hidden time unscored, no drift)');
console.log('Scene music: PASS (deferred until card art, unlock, crossfade, pause/resume, completion level, rapid cancellation, no duplicate loops)');
console.log('Music recovery: PASS (per-track unlock, refused play retried on a real gesture only, bounded backoff on element errors, online retry, silent while hidden)');
console.log('Feedback: PASS (one cue per event, independent SFX/haptics, unsupported vibration guard)');
console.log('Service-worker shell: PASS (complete, unique, both songs, card art required, required before media, revalidating, scope-isolated, deduplicated warming, no legacy active dependency, versioned cache, tolerant precache, range-capable)');
