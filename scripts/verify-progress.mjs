// Progress tracking: the record, the evaluator, the tracker's storage
// handling, and the two integrity guards that run before it.
//
// Pure modules are imported as they ship; scoring comes from the real
// runtime-config.js; the guards run as the classic scripts they are. Each
// tracker case gets a fresh module instance and a fresh fake window.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import {
  LEDGER_LIMIT,
  PROGRESS_KEY,
  createEmptyProgress,
  dayNumber,
  localDayKey,
  readProgress,
  seedFromLegacyStatistics,
} from '../progress-model.js';
import {
  currentDailyStreak,
  recordAbandonment,
  recordCompletion,
  resetProgress,
  validateCompletion,
} from '../progress-evaluator.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRoot = (file) => readFile(path.join(rootDirectory, file), 'utf8');
const STATS_KEY = 'inspireDejaVu:v1:statistics';
const GAME_KEY = 'inspireDejaVu:v1:activeGame';

// The game's own scoring and difficulty table.
const runtimeWindow = {};
vm.runInNewContext(await readRoot('runtime-config.js'), {
  window: runtimeWindow, document: { querySelector: () => null }, Number, Object, Math,
});
const runtime = runtimeWindow.DEJA_VU_RUNTIME;

let runCounter = 0;
function completion(overrides = {}) {
  const difficultyKey = overrides.difficultyKey || 'easy';
  const pairs = runtime.difficulties[difficultyKey]?.pairs ?? 6;
  const mistakes = overrides.mistakes ?? 0;
  const elapsedMs = overrides.elapsedMs ?? 42_300;
  const elapsed = Math.floor(elapsedMs / 1000);
  runCounter += 1;
  return {
    runId: `run-test-${String(runCounter).padStart(4, '0')}`,
    difficultyKey,
    pairs,
    moves: pairs + mistakes,
    mistakes,
    perfect: mistakes === 0,
    elapsed,
    elapsedMs,
    score: runtime.calculateScore(runtime.difficulties[difficultyKey] ? difficultyKey : 'easy', mistakes, elapsed),
    bestMatchChain: mistakes === 0 ? pairs : Math.max(1, pairs - mistakes),
    finalMatchChain: mistakes === 0 ? pairs : 1,
    day: '2026-03-10',
    ...overrides,
  };
}

const record = (progress, detail) => recordCompletion(progress, detail, runtime);

// ------------------------------------------------------------ the record ---

function verifyModel() {
  assert.deepEqual(readProgress(null), { progress: null, status: 'empty' });
  assert.equal(readProgress('not json').status, 'corrupt', 'unparseable text is corrupt');
  assert.equal(readProgress('[]').status, 'corrupt', 'an array is not a record');
  assert.deepEqual(readProgress('{"version":99}'), { progress: null, status: 'newer' }, 'a newer build\'s record is not reinterpreted');

  const empty = createEmptyProgress();
  assert.deepEqual(readProgress(JSON.stringify(empty)), { progress: empty, status: 'ok' }, 'a clean record reads back as is');

  const damaged = createEmptyProgress();
  damaged.totals = { ...damaged.totals, wins: 7, perfectWins: 9, earnedScore: -5, perfectStreak: 12, bestPerfectStreak: 1, matchedPairs: 'lots' };
  damaged.byDifficulty.easy.wins = 3;
  damaged.byDifficulty.insane = 'broken';
  damaged.daily = { current: 4, best: 2, lastWinDay: '2026-02-30' };
  damaged.recordedRuns = ['run-good-0001', 'bad id!', 'run-good-0001', 42, ...Array.from({ length: 150 }, (_, index) => `run-fill-${String(index).padStart(4, '0')}`)];
  const repaired = readProgress(JSON.stringify(damaged));
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.progress.totals.wins, 7, 'valid fields survive next to damaged ones');
  assert.equal(repaired.progress.totals.perfectWins, 7, 'perfect wins never exceed wins');
  assert.equal(repaired.progress.totals.earnedScore, 0, 'a negative total is reset on its own');
  assert.equal(repaired.progress.totals.matchedPairs, 0);
  assert.equal(repaired.progress.totals.perfectStreak, 7, 'a streak never exceeds the perfect wins behind it');
  assert.equal(repaired.progress.totals.bestPerfectStreak, 7, 'the best streak is at least the current one');
  assert.equal(repaired.progress.byDifficulty.easy.wins, 3);
  assert.equal(repaired.progress.byDifficulty.insane.wins, 0, 'a damaged difficulty starts over alone');
  assert.deepEqual(repaired.progress.daily, { current: 0, best: 2, lastWinDay: null }, 'an impossible date drops the running streak');
  assert.equal(repaired.progress.recordedRuns.length, LEDGER_LIMIT, 'the ledger stays bounded');
  assert.ok(!repaired.progress.recordedRuns.includes('bad id!'), 'invalid run ids are dropped');
  assert.equal(new Set(repaired.progress.recordedRuns).size, LEDGER_LIMIT, 'and duplicates');

  const v1 = { ...createEmptyProgress(), version: 1, totals: { ...createEmptyProgress().totals, wins: 4, perfectWins: 1 } };
  delete v1.achievements;
  const carried = readProgress(JSON.stringify(v1));
  assert.equal(carried.status, 'migrated', 'a version-1 record is carried over, to be backfilled');
  assert.deepEqual([carried.progress.version, carried.progress.totals.wins, carried.progress.totals.perfectWins], [2, 4, 1]);
  assert.deepEqual(carried.progress.achievements, createEmptyProgress().achievements);

  const unversioned = readProgress(JSON.stringify({ totals: { wins: 2 } }));
  assert.equal(unversioned.status, 'repaired', 'a record without a version is salvaged, not trusted');
  assert.equal(unversioned.progress.totals.wins, 2);

  // Calendar days, not 24-hour spans.
  assert.equal(dayNumber('2026-02-29'), null, '2026 has no 29 February');
  assert.equal(dayNumber('2028-02-29') - dayNumber('2028-02-28'), 1, 'leap day');
  assert.equal(dayNumber('2026-13-01'), null);
  assert.equal(dayNumber('2026-3-1'), null);
  assert.equal(dayNumber('1969-12-31'), null);
  assert.equal(dayNumber('2026-03-09') - dayNumber('2026-03-08'), 1, 'a 23-hour daylight-saving day is still one day');
  assert.equal(dayNumber('2026-11-02') - dayNumber('2026-11-01'), 1, 'and a 25-hour one');
  assert.equal(dayNumber('2027-01-01') - dayNumber('2026-12-31'), 1, 'across the year end');

  // The local calendar decides the day, wherever the device is.
  const instant = new Date('2026-03-01T05:00:00Z');
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  assert.equal(localDayKey(instant), '2026-02-28', 'in Los Angeles that instant is still 28 February');
  process.env.TZ = 'Pacific/Auckland';
  assert.equal(localDayKey(instant), '2026-03-01', 'in Auckland it is 1 March');
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;

  const seeded = seedFromLegacyStatistics({ played: 9, won: 5, perfect: 8, bestScore: 4000, bests: {} });
  assert.equal(seeded.totals.wins, 5, 'legacy wins carry over');
  assert.equal(seeded.totals.perfectWins, 5, 'legacy perfect games carry over, capped at wins');
  assert.deepEqual(seeded.legacy, { wins: 5, perfectWins: 5 }, 'and are marked as legacy');
  assert.equal(seeded.byDifficulty.easy.wins, 0, 'the old record has no per-difficulty counts');
  assert.deepEqual(seedFromLegacyStatistics('garbage'), createEmptyProgress());
  assert.deepEqual(seedFromLegacyStatistics({ won: 0 }), createEmptyProgress());
}

// --------------------------------------------------------- the evaluator ---

function verifyEvaluator() {
  const start = createEmptyProgress();
  const snapshot = JSON.stringify(start);
  const easy = completion({ elapsedMs: 31_900 });
  const first = record(start, easy);
  assert.equal(JSON.stringify(start), snapshot, 'the evaluator never mutates its input');
  assert.equal(first.recorded, true);
  const { totals } = first.progress;
  assert.deepEqual(
    [totals.wins, totals.perfectWins, totals.matchedPairs, totals.earnedScore, totals.activeTimeMs, totals.bestMatchChain],
    [1, 1, 6, runtime.calculateScore('easy', 0, 31), 31_900, 6],
    'a perfect easy win is credited in full',
  );
  assert.deepEqual(first.progress.byDifficulty.easy, totals, 'and to its difficulty');
  assert.equal(first.progress.byDifficulty.insane.wins, 0, 'and to no other');

  assert.deepEqual(record(first.progress, easy), { progress: first.progress, recorded: false, reason: 'duplicate' }, 'a replayed completion changes nothing');

  // Every inconsistency is refused without touching the record.
  const refusals = {
    'invalid runId': { runId: 'bad id' },
    'unknown difficulty': { difficultyKey: 'impossible' },
    'pairs do not match the difficulty': { pairs: 7 },
    'impossible moves or mistakes': { moves: 3 },
    'inconsistent time': { elapsed: 5 },
    'score does not match the scoring rules': { score: 999_999 },
    'impossible match chain': { bestMatchChain: 9 },
    'invalid day': { day: '2026-02-30' },
  };
  for (const [reason, overrides] of Object.entries(refusals)) {
    const result = record(first.progress, completion(overrides));
    assert.deepEqual([result.recorded, result.reason, result.progress], [false, reason, first.progress], `refused: ${reason}`);
  }
  assert.equal(validateCompletion(completion({ mistakes: 0, finalMatchChain: 2 }), runtime).ok, false, 'a perfect run ends on its best chain');
  assert.equal(validateCompletion(completion(), {}).ok, false, 'without the scoring rules nothing is credited');

  // Consecutive perfect wins, lifetime and per difficulty.
  let progress = createEmptyProgress();
  for (const detail of [completion(), completion(), completion({ difficultyKey: 'insane' }), completion({ mistakes: 2 }), completion()]) {
    progress = record(progress, detail).progress;
  }
  assert.deepEqual([progress.totals.perfectStreak, progress.totals.bestPerfectStreak], [1, 3], 'a mistake ends the streak; the best is kept');
  assert.deepEqual([progress.byDifficulty.easy.perfectStreak, progress.byDifficulty.easy.bestPerfectStreak], [1, 2]);
  assert.deepEqual([progress.byDifficulty.insane.perfectStreak, progress.byDifficulty.insane.wins], [1, 1]);
  assert.deepEqual([progress.totals.wins, progress.totals.perfectWins], [5, 4]);

  // Daily streaks by local calendar day.
  const onDay = (state, day) => record(state, completion({ day })).progress;
  let daily = createEmptyProgress();
  daily = onDay(daily, '2026-12-30');
  assert.deepEqual(daily.daily, { current: 1, best: 1, lastWinDay: '2026-12-30' });
  daily = onDay(daily, '2026-12-30');
  assert.equal(daily.daily.current, 1, 'more wins the same day count once');
  daily = onDay(daily, '2026-12-31');
  daily = onDay(daily, '2027-01-01');
  assert.equal(daily.daily.current, 3, 'consecutive days extend it, across the year end');
  assert.equal(currentDailyStreak(daily, '2027-01-01'), 3);
  assert.equal(currentDailyStreak(daily, '2027-01-02'), 3, 'still alive the day after');
  assert.equal(currentDailyStreak(daily, '2027-01-03'), 0, 'a missed day breaks it');
  daily = onDay(daily, '2027-01-03');
  assert.deepEqual([daily.daily.current, daily.daily.best], [1, 3], 'the next win starts over; the best is kept');
  daily = onDay(daily, '2026-12-31');
  assert.deepEqual(daily.daily, { current: 1, best: 3, lastWinDay: '2027-01-03' }, 'a win dated earlier (clock moved back) leaves the streak alone');
  assert.equal(daily.totals.wins, 6, 'but is still a win');
  let leap = createEmptyProgress();
  for (const day of ['2028-02-28', '2028-02-29', '2028-03-01']) leap = onDay(leap, day);
  assert.equal(leap.daily.current, 3, 'through a leap day');
  assert.equal(currentDailyStreak(createEmptyProgress(), '2026-03-10'), 0);

  // Abandonment.
  let streak = createEmptyProgress();
  streak = record(streak, completion()).progress;
  streak = record(streak, completion()).progress;
  const clean = recordAbandonment(streak, { runId: 'run-abandon-01', difficultyKey: 'easy', mistakes: 0 });
  assert.equal(clean.progress.totals.perfectStreak, 2, 'abandoning a clean run keeps the streak');
  const flawed = recordAbandonment(clean.progress, { runId: 'run-abandon-02', difficultyKey: 'easy', mistakes: 1 });
  assert.deepEqual(
    [flawed.progress.totals.perfectStreak, flawed.progress.totals.bestPerfectStreak, flawed.progress.byDifficulty.easy.perfectStreak],
    [0, 2, 0],
    'abandoning a run with a mistake ends the streak',
  );
  assert.equal(flawed.progress.totals.wins, 2, 'an abandoned run earns nothing');
  assert.equal(recordAbandonment(flawed.progress, { runId: 'run-abandon-02', difficultyKey: 'easy', mistakes: 1 }).reason, 'duplicate');
  assert.equal(
    record(flawed.progress, completion({ runId: 'run-abandon-01' })).reason,
    'duplicate',
    'an abandoned run can never complete afterwards',
  );
  const legacyRun = recordAbandonment(streak, { runId: null, difficultyKey: 'easy', mistakes: 3 });
  assert.equal(legacyRun.recorded, true, 'a save from before run ids is still handled');
  assert.equal(legacyRun.progress.totals.perfectStreak, 0);
  assert.deepEqual(legacyRun.progress.recordedRuns, streak.recordedRuns, 'without a ledger entry');

  // Reset keeps the ledger.
  const reset = resetProgress(streak, 1_800_000_000_000).progress;
  assert.equal(reset.totals.wins, 0, 'reset clears totals');
  assert.equal(reset.daily.current, 0, 'and streaks');
  assert.equal(reset.resetAt, 1_800_000_000_000);
  assert.deepEqual(reset.recordedRuns, streak.recordedRuns, 'but not the ledger');
  assert.equal(record(reset, { ...completion(), runId: streak.recordedRuns[0] }).reason, 'duplicate', 'so an old event still cannot count');

  // The ledger is bounded: the newest LEDGER_LIMIT runs are remembered.
  let many = createEmptyProgress();
  const ids = [];
  for (let index = 0; index < LEDGER_LIMIT + 5; index += 1) {
    const detail = completion();
    ids.push(detail.runId);
    many = record(many, detail).progress;
  }
  assert.equal(many.recordedRuns.length, LEDGER_LIMIT);
  assert.deepEqual(many.recordedRuns, ids.slice(-LEDGER_LIMIT), 'oldest first out');
  assert.equal(many.totals.wins, LEDGER_LIMIT + 5);

  // Totals saturate instead of overflowing.
  const huge = createEmptyProgress();
  huge.totals.earnedScore = Number.MAX_SAFE_INTEGER - 10;
  assert.equal(record(huge, completion()).progress.totals.earnedScore, Number.MAX_SAFE_INTEGER);
}

// ------------------------------------------------------ integrity guards ---

function fakeStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

async function verifyGuards() {
  const statsGuard = await readRoot('stats-integrity.js');
  const saveGuard = await readRoot('save-integrity.js');
  const run = (source, localStorage) => vm.runInNewContext(source, {
    localStorage, JSON, Number, Object, Array, Math, Set, Map, console: { warn() {} },
  });

  const progress = JSON.stringify({ ...createEmptyProgress(), totals: { ...createEmptyProgress().totals, wins: 12 } });
  for (const stats of ['{broken', JSON.stringify({ played: -1, won: 'x', bests: { nope: {} } }), JSON.stringify({ played: 4, won: 2, perfect: 1, bestScore: 900, bests: {} })]) {
    const storage = fakeStorage({ [STATS_KEY]: stats, [PROGRESS_KEY]: progress });
    run(statsGuard, storage);
    assert.equal(storage.data.get(PROGRESS_KEY), progress, 'the statistics guard never touches progress');
  }

  const deck = [];
  for (let pattern = 0; pattern < 6; pattern += 1) {
    deck.push({ uid: `a${pattern}`, pattern, matched: pattern < 2 }, { uid: `b${pattern}`, pattern, matched: pattern < 2 });
  }
  const oldSave = {
    version: 1, active: true, difficulty: 'easy', deck, open: [], matchedPairs: 2, moves: 4, mistakes: 2,
    elapsed: 30, paused: false, locked: false, turn: 'idle', completed: false, sessionId: '', turnId: 0,
  };
  const cases = [
    ['a save from before run tracking', oldSave, true],
    ['a save with a run and its chain', { ...oldSave, runId: 'run-abcd-1234', chain: 1, bestChain: 2 }, true],
    ['a save whose run id is still empty', { ...oldSave, runId: '' }, true],
    ['a malformed run id', { ...oldSave, runId: 'not a run id!' }, false],
    ['a chain above its best', { ...oldSave, runId: 'run-abcd-1234', chain: 2, bestChain: 1 }, false],
    ['a best chain above the pairs matched', { ...oldSave, runId: 'run-abcd-1234', chain: 0, bestChain: 3 }, false],
    ['half a chain', { ...oldSave, chain: 1 }, false],
  ];
  for (const [label, save, kept] of cases) {
    const storage = fakeStorage({ [GAME_KEY]: JSON.stringify(save) });
    run(saveGuard, storage);
    assert.equal(storage.data.has(GAME_KEY), kept, `${label} is ${kept ? 'kept' : 'removed'}`);
  }
}

// ----------------------------------------------------------- the tracker ---

let instance = 0;
async function loadTracker(localStorage, { throwOnAccess = false } = {}) {
  const window = new EventTarget();
  Object.defineProperty(window, 'localStorage', {
    get() {
      if (throwOnAccess) throw new Error('SecurityError: storage is disabled');
      return localStorage;
    },
  });
  window.DEJA_VU_RUNTIME = runtime;
  globalThis.window = window;
  instance += 1;
  const url = `${pathToFileURL(path.join(rootDirectory, 'progress-tracker.js')).href}?instance=${instance}`;
  const tracker = await import(url);
  const complete = (detail) => window.dispatchEvent(new CustomEvent('deja-vu:completion', { detail }));
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  return { ...tracker, window, complete, emit };
}

const stored = (storage) => JSON.parse(storage.data.get(PROGRESS_KEY));

async function verifyTracker() {
  // Upgrade: legacy statistics seed the record once, at load, before any win.
  const storage = fakeStorage({ [STATS_KEY]: JSON.stringify({ played: 5, won: 3, perfect: 1, bestScore: 4800, bests: {} }) });
  let tracker = await loadTracker(storage);
  assert.equal(stored(storage).totals.wins, 3, 'the legacy seed is written on load');
  const win = completion();
  // index.js counts the win in the legacy statistics before announcing it.
  storage.setItem(STATS_KEY, JSON.stringify({ played: 6, won: 4, perfect: 2, bestScore: 4800, bests: {} }));
  tracker.complete(win);
  tracker.complete(win);
  assert.equal(stored(storage).totals.wins, 4, 'one win, counted once, not re-seeded');
  assert.deepEqual(stored(storage).legacy, { wins: 3, perfectWins: 1 });

  // A reload is a fresh instance on the same storage.
  tracker = await loadTracker(storage);
  tracker.complete(win);
  assert.equal(tracker.getProgress().totals.wins, 4, 'a completion replayed after a reload still counts once');
  tracker.emit('deja-vu:run-abandoned', { runId: 'run-left-0001', difficultyKey: 'easy', mistakes: 1, moves: 3 });
  assert.equal(stored(storage).totals.perfectStreak, 0, 'an abandoned run with a mistake ends the streak');
  tracker.emit('deja-vu:statistics-reset', { at: 1_800_000_000_000 });
  assert.equal(stored(storage).totals.wins, 0, 'a statistics reset clears progress');
  tracker.complete(win);
  assert.equal(stored(storage).totals.wins, 0, 'and an old completion still cannot count');

  // A record that is not a record is kept aside, then replaced.
  const corrupt = fakeStorage({ [PROGRESS_KEY]: '{"version":1,"totals":' });
  tracker = await loadTracker(corrupt);
  assert.equal(corrupt.data.get(`${PROGRESS_KEY}:corrupt`), '{"version":1,"totals":', 'the damaged text is kept aside');
  assert.equal(readProgress(corrupt.data.get(PROGRESS_KEY)).status, 'ok', 'and a valid record replaces it');
  tracker.complete(completion());
  assert.equal(stored(corrupt).totals.wins, 1);

  // A record from a newer build is never overwritten.
  const newer = '{"version":7,"future":true}';
  const future = fakeStorage({ [PROGRESS_KEY]: newer });
  tracker = await loadTracker(future);
  tracker.complete(completion());
  assert.equal(future.data.get(PROGRESS_KEY), newer, 'the newer record is left untouched');
  assert.equal(tracker.getProgress().totals.wins, 1, 'progress is kept in memory instead');
  assert.equal(tracker.getProgressStatus().persistent, false);

  // Storage that cannot even be opened.
  tracker = await loadTracker(fakeStorage(), { throwOnAccess: true });
  assert.doesNotThrow(() => tracker.complete(completion()), 'denied storage never breaks a completion');
  tracker.complete(completion());
  assert.equal(tracker.getProgress().totals.wins, 2, 'progress is tracked in memory for the session');
  assert.equal(tracker.getProgressStatus().persistent, false);

  // Storage that reads but refuses writes (a full quota).
  const full = fakeStorage();
  tracker = await loadTracker(full);
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  tracker.complete(completion());
  tracker.complete(completion());
  assert.equal(tracker.getProgress().totals.wins, 2, 'unsaved progress is not lost to the stale stored copy');
  delete full.setItem;
  full.setItem = (key, value) => full.data.set(key, String(value));
  tracker.complete(completion());
  assert.equal(stored(full).totals.wins, 3, 'and is written in full once storage accepts it again');
}

verifyModel();
verifyEvaluator();
await verifyGuards();
await verifyTracker();

console.log('Progress record: PASS (versioned, version-1 migration, field-by-field repair, newer builds left alone, bounded ledger, calendar days, legacy seed)');
console.log('Progress evaluator: PASS (wins/perfect/pairs/score/time/chains per difficulty, runtime scoring, refusals, perfect and daily streaks, abandonment, reset)');
console.log('Progress storage: PASS (reload, duplicates, corrupt, newer, denied and full storage; integrity guards keep progress and migrate saves)');
