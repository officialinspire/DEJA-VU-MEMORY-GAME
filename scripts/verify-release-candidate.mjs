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
  let intervalCallback = null;
  const document = {
    hidden: false,
    querySelector() { return null; },
  };
  const window = {
    setTimeout() { return 1; },
    setInterval(callback) { intervalCallback = callback; return 1; },
  };
  vm.runInNewContext(source, { document, window, Number, Object, Math }, { filename: 'runtime-config.js' });

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

  let ticks = 0;
  window.setInterval(() => { ticks += 1; }, 1000);
  window.DEJA_VU_PREVIEW_ACTIVE = true;
  intervalCallback();
  assert.equal(ticks, 0, 'preview excludes the gameplay clock');
  window.DEJA_VU_PREVIEW_ACTIVE = false;
  intervalCallback();
  assert.equal(ticks, 1, 'gameplay clock resumes after preview');
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
      audioInstances.push(this);
    }
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
    .concat('\nwindow.__AUDIO_TEST__ = { MUSIC_SCENES, configureMusic, transitionMusic, unlockMusic, getMusicState };');
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
  assert.match(swSource, /deja-vu-v1\.0\.24/);

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
await verifyMusicManager();
await verifyFeedbackManager();
await verifyAppShell();

console.log('Runtime scoring: PASS (formula, preview exclusion, and 49/50, 69/70, 84/85 boundaries)');
console.log('Scene music: PASS (unlock, crossfade, pause/resume, completion level, rapid cancellation, no duplicate loops)');
console.log('Feedback: PASS (one cue per event, independent SFX/haptics, unsupported vibration guard)');
console.log('Service-worker shell: PASS (complete, unique, both songs, no legacy active dependency)');
