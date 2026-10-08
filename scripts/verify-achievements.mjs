// Achievements: the catalog, its thresholds, the evaluator, the backfill and
// the tracker's handling of unlocks.
//
// The catalog and evaluator are imported as they ship; board sizes and
// scoring come from the real runtime-config.js, and turn timings from
// index.js itself, so "attainable" is checked against the game as it plays.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { ACHIEVEMENT_CATEGORIES, buildAchievementCatalog, speedMistakeLimit } from '../achievement-catalog.js';
import {
  awardCompletion,
  backfillAchievements,
  describeAchievements,
  isMet,
  metricValue,
  provenByStatistics,
  recordCompletionAndAward,
  resetAchievementProgress,
} from '../achievement-evaluator.js';
import {
  DIFFICULTY_KEYS,
  PROGRESS_KEY,
  createEmptyProgress,
  isAchievementId,
  isRunId,
  readProgress,
  seedFromLegacyStatistics,
} from '../progress-model.js';
import { recordAbandonment, recordCompletion, resetProgress } from '../progress-evaluator.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRoot = (file) => readFile(path.join(rootDirectory, file), 'utf8');
const STATS_KEY = 'inspireDejaVu:v1:statistics';

const runtimeWindow = {};
vm.runInNewContext(await readRoot('runtime-config.js'), {
  window: runtimeWindow, document: { querySelector: () => null }, Number, Object, Math,
});
const runtime = runtimeWindow.DEJA_VU_RUNTIME;
const catalog = buildAchievementCatalog(runtime);
const byId = new Map(catalog.map((entry) => [entry.id, entry]));
const entry = (id) => {
  assert.ok(byId.has(id), `no achievement ${id}`);
  return byId.get(id);
};

// index.js's turn timings with animations on (the slower setting).
const timingSource = /const TIMING = (Object\.freeze\(\{[\s\S]*?\n\}\));/.exec(await readRoot('index.js'));
assert.ok(timingSource, 'index.js TIMING table not found');
const TIMING = vm.runInNewContext(`(${timingSource[1]})`, { Object }).normal;

// A deliberate human pace: 450 ms to find and click each card of a turn.
const HUMAN_CLICK_MS = 450;

/**
 * Gameplay time for a game played at `clickMs` per card with animations on:
 * every pair waits out the match resolution, every mistake the mismatch study
 * and flip-back. The memorize preview is not gameplay time.
 */
function playedMs(key, mistakes, clickMs = HUMAN_CLICK_MS) {
  const { pairs, mismatchStudyMs } = runtime.difficulties[key];
  return pairs * (2 * clickMs + TIMING.matchResolve)
    + mistakes * (2 * clickMs + mismatchStudyMs + TIMING.mismatchFlipBack);
}

let runCounter = 0;
function completion(overrides = {}) {
  const difficultyKey = overrides.difficultyKey || 'easy';
  const { pairs } = runtime.difficulties[difficultyKey];
  const mistakes = overrides.mistakes ?? 0;
  const elapsedMs = overrides.elapsedMs ?? playedMs(difficultyKey, mistakes);
  const elapsed = Math.floor(elapsedMs / 1000);
  // With mistakes, the shortest longest chain they allow.
  const bestMatchChain = overrides.bestMatchChain ?? (mistakes === 0 ? pairs : Math.ceil(pairs / (mistakes + 1)));
  runCounter += 1;
  return {
    runId: `run-ach-${String(runCounter).padStart(5, '0')}`,
    difficultyKey,
    pairs,
    moves: pairs + mistakes,
    mistakes,
    perfect: mistakes === 0,
    elapsed,
    elapsedMs,
    score: runtime.calculateScore(difficultyKey, mistakes, elapsed),
    bestMatchChain,
    finalMatchChain: mistakes === 0 ? pairs : Math.min(1, bestMatchChain),
    day: '2026-05-04',
    completedAt: 1_780_000_000_000 + runCounter,
    ...overrides,
  };
}

const NOW = 1_790_000_000_000;
const play = (progress, detail) => recordCompletionAndAward(progress, detail, catalog, runtime, NOW);
const unlocksOf = (progress, detail) => play(progress, detail).unlocked;
const metIds = (progress) => catalog.filter((item) => isMet(item, metricValue(progress, item, runtime))).map((item) => item.id);

// ------------------------------------------------------------- catalog ---

const STABLE_IDS = [
  'wins-1', 'wins-3', 'wins-5', 'wins-10', 'wins-20', 'wins-30', 'wins-50', 'wins-75', 'wins-100', 'wins-150',
  'wins-200', 'wins-300', 'wins-500', 'wins-750', 'wins-1000',
  'easy-wins-1', 'easy-wins-5', 'easy-wins-10', 'easy-wins-25', 'easy-wins-50',
  'intermediate-wins-1', 'intermediate-wins-5', 'intermediate-wins-10', 'intermediate-wins-25', 'intermediate-wins-50',
  'advanced-wins-1', 'advanced-wins-5', 'advanced-wins-10', 'advanced-wins-25', 'advanced-wins-50',
  'insane-wins-1', 'insane-wins-5', 'insane-wins-10', 'insane-wins-25', 'insane-wins-50',
  'perfect-1', 'perfect-2', 'perfect-3', 'perfect-5', 'perfect-10', 'perfect-20', 'perfect-35', 'perfect-50', 'perfect-75', 'perfect-100',
  'pairs-25', 'pairs-50', 'pairs-100', 'pairs-250', 'pairs-500', 'pairs-1000', 'pairs-2000', 'pairs-3500', 'pairs-5000', 'pairs-10000',
  'speed-easy-1', 'speed-easy-2', 'speed-intermediate-1', 'speed-intermediate-2', 'speed-advanced-1', 'speed-advanced-2',
  'speed-advanced-3', 'speed-insane-1', 'speed-insane-2', 'speed-insane-3',
  'excellent-easy', 'excellent-intermediate', 'excellent-advanced', 'excellent-insane', 'performance-95',
  'score-1', 'score-2', 'score-3', 'earned-1', 'earned-2',
  'perfect-streak-2', 'perfect-streak-3', 'perfect-streak-4', 'perfect-streak-5', 'perfect-streak-6',
  'perfect-streak-8', 'perfect-streak-10', 'perfect-streak-15', 'perfect-streak-20', 'perfect-streak-25',
  'daily-streak-2', 'daily-streak-3', 'daily-streak-5', 'daily-streak-7', 'daily-streak-10',
  'daily-streak-14', 'daily-streak-21', 'daily-streak-30', 'daily-streak-50', 'daily-streak-100',
  'flawless-insanity', 'unbroken-thread', 'perfect-prism', 'four-rooms-one-day', 'lightning-recall',
];

const METRICS = new Set([
  'wins', 'perfectWins', 'matchedPairs', 'earnedScore', 'bestPerfectStreak', 'bestDailyStreak', 'bestMatchChain',
  'fewestMistakes', 'fastestSharpWin', 'fastestPerfectWin', 'topScore', 'topPerformance', 'perfectDifficulties',
  'difficultiesInOneDay',
]);

function verifyCatalog() {
  assert.equal(catalog.length, 100, 'exactly 100 achievements');
  assert.deepEqual(catalog.map((item) => item.id), STABLE_IDS, 'ids are stable: never renamed, reordered or reused');
  assert.equal(new Set(catalog.map((item) => item.id)).size, 100, 'ids are unique');
  assert.equal(new Set(catalog.map((item) => item.name.toLowerCase())).size, 100, 'names are unique');

  const allocation = {
    wins: 15, difficulty: 20, perfect: 10, pairs: 10, speed: 10, score: 10, 'perfect-streak': 10, 'daily-streak': 10, challenge: 5,
  };
  assert.deepEqual(Object.fromEntries(ACHIEVEMENT_CATEGORIES.map((category) => [category.key, category.count])), allocation);
  for (const category of ACHIEVEMENT_CATEGORIES) {
    assert.equal(catalog.filter((item) => item.category === category.key).length, category.count, `${category.key} has ${category.count}`);
  }
  for (const key of DIFFICULTY_KEYS) {
    assert.equal(catalog.filter((item) => item.category === 'difficulty' && item.difficulty === key).length, 5, `5 win milestones for ${key}`);
  }

  for (const item of catalog) {
    assert.ok(Object.isFrozen(item), `${item.id} is frozen`);
    assert.ok(isAchievementId(item.id), `${item.id} is a valid id`);
    assert.ok(item.name.trim().length >= 3 && item.name.length <= 40, `${item.id} has a name`);
    assert.match(item.requirement, /^[A-Z].{8,110}\.$/, `${item.id} has a plain one-sentence requirement`);
    assert.ok(METRICS.has(item.metric), `${item.id} measures something known`);
    assert.ok(['atLeast', 'atMost'].includes(item.comparison));
    assert.ok(Number.isSafeInteger(item.threshold) && item.threshold >= 0, `${item.id} has a whole-number threshold`);
    assert.ok(item.difficulty === null || DIFFICULTY_KEYS.includes(item.difficulty));
    if (item.unit === 'difficulties') assert.match(item.requirement, /every difficulty/, `${item.id} states its threshold`);
    else assert.ok(item.threshold <= 1 || item.requirement.includes(item.threshold.toLocaleString('en-US')), `${item.id} states its threshold`);
  }
  // Counting milestones climb strictly.
  for (const [category, metric] of [['wins', 'wins'], ['perfect', 'perfectWins'], ['pairs', 'matchedPairs'], ['perfect-streak', 'bestPerfectStreak'], ['daily-streak', 'bestDailyStreak']]) {
    const thresholds = catalog.filter((item) => item.category === category).map((item) => item.threshold);
    assert.ok(catalog.filter((item) => item.category === category).every((item) => item.metric === metric));
    assert.ok(thresholds.every((value, index) => index === 0 || value > thresholds[index - 1]), `${category} thresholds climb`);
  }
  // Streak milestones start above one: a one-game or one-day streak is just a win.
  assert.ok(catalog.filter((item) => item.category.endsWith('streak')).every((item) => item.threshold >= 2));
  // No achievement can be earned by making mistakes, moves or time pile up.
  assert.ok(catalog.every((item) => !['moves', 'mistakes', 'activeTimeMs'].includes(item.metric)));
}

// -------------------------------------------- derived, attainable thresholds ---

function verifyThresholds() {
  // Speed: a time budget per pair on the real board, and a third of its pairs
  // as the mistake limit.
  const expected = {
    easy: [30, 21], intermediate: [40, 28], advanced: [50, 35, 25], insane: [75, 52, 37],
  };
  const budgets = [5, 3.5, 2.5];
  for (const key of DIFFICULTY_KEYS) {
    const { pairs } = runtime.difficulties[key];
    const goals = catalog.filter((item) => item.category === 'speed' && item.difficulty === key);
    assert.deepEqual(goals.map((item) => item.threshold), expected[key], `${key} speed thresholds`);
    goals.forEach((item, index) => {
      assert.equal(item.threshold, Math.floor(pairs * budgets[index]), `${item.id} is ${budgets[index]} s per pair`);
      assert.equal(item.mistakeLimit, speedMistakeLimit(pairs));
      assert.equal(item.metric, 'fastestSharpWin');
      // Attainable at a human pace even with every allowed mistake, and with
      // full animations: the slower of the two motion settings.
      const humanMs = playedMs(key, item.mistakeLimit);
      assert.ok(humanMs < item.threshold * 1000, `${item.id}: ${humanMs} ms at a human pace is within ${item.threshold} s`);
    });
    assert.ok(goals.every((item, index) => index === 0 || item.threshold < goals[index - 1].threshold), `${key} tiers get faster`);
  }
  assert.deepEqual(DIFFICULTY_KEYS.map((key) => speedMistakeLimit(runtime.difficulties[key].pairs)), [2, 2, 3, 5]);

  // Score: ratings from the runtime's bands, single-game scores from stated
  // reference games scored by the runtime, each a game a human can play.
  const excellent = runtime.performanceBands.find((band) => band.rating === 'EXCELLENT').minimum;
  for (const key of DIFFICULTY_KEYS) {
    const item = entry(`excellent-${key}`);
    assert.equal(item.threshold, excellent);
    const limit = speedMistakeLimit(runtime.difficulties[key].pairs);
    const seconds = Math.floor(playedMs(key, limit) / 1000);
    const percent = runtime.calculatePerformancePercent(key, runtime.calculateScore(key, limit, seconds));
    assert.ok(percent >= excellent, `${item.id}: a human-paced game with ${limit} mistakes rates ${percent}%`);
  }
  const nearPerfect = entry('performance-95');
  const quickEasy = Math.floor(playedMs('easy', 0) / 1000);
  assert.ok(runtime.calculatePerformancePercent('easy', runtime.calculateScore('easy', 0, quickEasy)) >= nearPerfect.threshold);
  for (const item of catalog.filter((candidate) => candidate.metric === 'topScore')) {
    const { difficulty, mistakes, seconds } = item.reference;
    assert.equal(item.threshold, runtime.calculateScore(difficulty, mistakes, seconds), `${item.id} is its reference game's score`);
    assert.ok(playedMs(difficulty, mistakes) <= seconds * 1000, `${item.id}: its reference game is playable in ${seconds} s`);
    assert.ok(item.threshold <= runtime.difficulties[difficulty].pairs * runtime.scoring.basePerPair);
  }
  assert.deepEqual(catalog.filter((item) => item.metric === 'topScore').map((item) => item.threshold), [5000, 10000, 14000]);

  // Challenges.
  const largest = Math.max(...DIFFICULTY_KEYS.map((key) => runtime.difficulties[key].pairs));
  const others = DIFFICULTY_KEYS.map((key) => runtime.difficulties[key].pairs).filter((pairs) => pairs < largest);
  const thread = entry('unbroken-thread');
  assert.ok(thread.threshold <= largest && thread.threshold > Math.max(...others), 'a chain only the largest board can hold');
  const lightning = entry('lightning-recall');
  assert.equal(lightning.threshold, runtime.difficulties.advanced.pairs * 3);
  assert.ok(playedMs('advanced', 0) < lightning.threshold * 1000, 'Lightning Recall is playable at a human pace');
  assert.equal(entry('perfect-prism').threshold, DIFFICULTY_KEYS.length);
  assert.equal(entry('four-rooms-one-day').threshold, DIFFICULTY_KEYS.length);
}

// A long career of valid, human-paced completions only: every achievement
// is reachable through the evaluator, each unlocks at exactly the completion
// that first meets it, and nothing is ever met without being unlocked.
function verifyCareer() {
  let progress = createEmptyProgress();
  const plan = ['easy', 'intermediate', 'advanced', 'insane', 'insane', 'insane', 'insane', 'insane', 'insane', 'insane'];
  const start = Date.UTC(2026, 0, 1);
  let at = Date.UTC(2026, 0, 1, 9);
  for (let dayIndex = 0; dayIndex < 110; dayIndex += 1) {
    const day = new Date(start + dayIndex * 86_400_000).toISOString().slice(0, 10);
    for (const difficultyKey of plan) {
      at += 60_000;
      const detail = completion({ difficultyKey, day, completedAt: at });
      const result = play(progress, detail);
      assert.equal(result.recorded, true);
      for (const id of result.unlocked) {
        assert.deepEqual(result.progress.achievements.unlocked[id], { at, runId: detail.runId }, `${id} is stamped with its run`);
      }
      assert.deepEqual(Object.keys(result.progress.achievements.unlocked).sort(), metIds(result.progress).sort(), `on ${day}: unlocked exactly what is met`);
      progress = result.progress;
    }
  }
  const described = describeAchievements(progress, catalog, runtime);
  assert.equal(described.filter((item) => item.unlocked).length, 100, 'every achievement is attainable through valid completions');
  assert.ok(described.every((item) => item.progress === 1 && isRunId(item.runId) && item.backfilled === false));
}

// ----------------------------------------------------------- boundaries ---

// A record with one measure set, for the counting achievements.
function withMeasure(item, value) {
  const progress = createEmptyProgress();
  const scope = item.difficulty ? progress.byDifficulty[item.difficulty] : progress.totals;
  if (item.metric === 'bestDailyStreak') progress.daily = { current: value, best: value, lastWinDay: value ? '2026-05-04' : null };
  else if (item.metric === 'perfectWins' || item.metric === 'bestPerfectStreak') {
    Object.assign(scope, { wins: value, perfectWins: value, perfectStreak: value, bestPerfectStreak: value });
  } else scope[item.metric] = value;
  return progress;
}

function verifyBoundaries() {
  const counting = ['wins', 'perfectWins', 'matchedPairs', 'earnedScore', 'bestPerfectStreak', 'bestDailyStreak'];
  for (const item of catalog.filter((candidate) => counting.includes(candidate.metric))) {
    assert.equal(isMet(item, metricValue(withMeasure(item, item.threshold - 1), item, runtime)), false, `${item.id}: one short is not enough`);
    assert.equal(isMet(item, metricValue(withMeasure(item, item.threshold), item, runtime)), true, `${item.id}: the threshold is`);
    if (item.difficulty) {
      const elsewhere = DIFFICULTY_KEYS.find((key) => key !== item.difficulty);
      assert.equal(isMet(item, metricValue(withMeasure({ ...item, difficulty: elsewhere }, item.threshold), item, runtime)), false, `${item.id}: other boards do not count`);
    }
  }

  // Counting through real completions: wins-3 on the third win, not before.
  let progress = createEmptyProgress();
  progress = play(progress, completion()).progress;
  progress = play(progress, completion({ mistakes: 1 })).progress;
  assert.ok(!Object.hasOwn(progress.achievements.unlocked, 'wins-3'));
  assert.ok(unlocksOf(progress, completion({ mistakes: 4 })).includes('wins-3'));

  // Speed: inclusive of the threshold second and of the mistake limit.
  const empty = createEmptyProgress();
  for (const item of catalog.filter((candidate) => candidate.category === 'speed')) {
    const base = { difficultyKey: item.difficulty, mistakes: item.mistakeLimit };
    assert.ok(unlocksOf(empty, completion({ ...base, elapsedMs: item.threshold * 1000 + 999 })).includes(item.id), `${item.id} at ${item.threshold} s`);
    assert.ok(!unlocksOf(empty, completion({ ...base, elapsedMs: (item.threshold + 1) * 1000 })).includes(item.id), `${item.id} not at ${item.threshold + 1} s`);
    const tooMany = unlocksOf(empty, completion({ difficultyKey: item.difficulty, mistakes: item.mistakeLimit + 1, elapsedMs: 1000 }));
    assert.ok(!tooMany.some((id) => entry(id).category === 'speed'), `${item.id}: one mistake over the limit never counts, however fast`);
  }

  // Single-game score: the reference game reaches it, one second slower not.
  for (const item of catalog.filter((candidate) => candidate.metric === 'topScore')) {
    const { difficulty, mistakes, seconds } = item.reference;
    const base = { difficultyKey: difficulty, mistakes };
    assert.ok(unlocksOf(empty, completion({ ...base, elapsedMs: seconds * 1000 })).includes(item.id), `${item.id} at its threshold`);
    assert.ok(!unlocksOf(empty, completion({ ...base, elapsedMs: (seconds + 1) * 1000 })).includes(item.id), `${item.id} not 5 points below`);
  }

  // Ratings: the rounding edge of the band, on each board.
  const ratingEdge = (key, minimum) => {
    let seconds = 0;
    while (runtime.calculatePerformancePercent(key, runtime.calculateScore(key, 0, seconds + 1)) >= minimum) seconds += 1;
    return seconds;
  };
  for (const item of [...DIFFICULTY_KEYS.map((key) => entry(`excellent-${key}`)), entry('performance-95')]) {
    const key = item.difficulty || 'easy';
    const edge = ratingEdge(key, item.threshold);
    assert.ok(unlocksOf(empty, completion({ difficultyKey: key, elapsedMs: edge * 1000 })).includes(item.id), `${item.id} at ${edge} s`);
    assert.ok(!unlocksOf(empty, completion({ difficultyKey: key, elapsedMs: (edge + 1) * 1000 })).includes(item.id), `${item.id} not at ${edge + 1} s`);
  }
  assert.equal(runtime.calculatePerformancePercent('easy', runtime.calculateScore('easy', 0, ratingEdge('easy', 85))), 85);

  // Earned score across games: exactly at the threshold.
  const earned = entry('earned-1');
  const nearly = withMeasure(earned, 0);
  const run = completion({ difficultyKey: 'insane' });
  nearly.totals.earnedScore = earned.threshold - run.score;
  assert.ok(unlocksOf(nearly, run).includes('earned-1'));
  nearly.totals.earnedScore -= 1;
  assert.ok(!unlocksOf(nearly, completion({ difficultyKey: 'insane' })).includes('earned-1'));

  // Challenges.
  assert.ok(!unlocksOf(empty, completion({ difficultyKey: 'insane', mistakes: 1 })).includes('flawless-insanity'));
  assert.ok(unlocksOf(empty, completion({ difficultyKey: 'insane' })).includes('flawless-insanity'));

  assert.ok(!unlocksOf(empty, completion({ difficultyKey: 'insane', mistakes: 2, bestMatchChain: 11 })).includes('unbroken-thread'));
  assert.ok(unlocksOf(empty, completion({ difficultyKey: 'insane', mistakes: 2, bestMatchChain: 12 })).includes('unbroken-thread'));
  assert.ok(!unlocksOf(empty, completion({ difficultyKey: 'advanced' })).includes('unbroken-thread'), 'a perfect Advanced board is only 10 long');

  let prism = createEmptyProgress();
  for (const key of ['easy', 'intermediate', 'advanced']) prism = play(prism, completion({ difficultyKey: key })).progress;
  assert.equal(metricValue(prism, entry('perfect-prism'), runtime), 3);
  assert.ok(!unlocksOf(prism, completion({ difficultyKey: 'insane', mistakes: 1 })).includes('perfect-prism'));
  assert.ok(unlocksOf(prism, completion({ difficultyKey: 'insane' })).includes('perfect-prism'));

  let rooms = createEmptyProgress();
  for (const key of ['easy', 'intermediate', 'advanced']) rooms = play(rooms, completion({ difficultyKey: key, day: '2026-05-04' })).progress;
  assert.ok(!unlocksOf(rooms, completion({ difficultyKey: 'insane', day: '2026-05-05' })).includes('four-rooms-one-day'), 'the next day starts over');
  assert.ok(!unlocksOf(rooms, completion({ difficultyKey: 'insane', day: '2026-05-03' })).includes('four-rooms-one-day'), 'a back-dated win counts toward no day');
  const backdated = play(rooms, completion({ difficultyKey: 'insane', day: '2026-05-03' })).progress;
  assert.deepEqual(backdated.achievements.day, { key: '2026-05-04', difficulties: ['easy', 'intermediate', 'advanced'], most: 3 });
  rooms = play(rooms, completion({ difficultyKey: 'easy', day: '2026-05-04' })).progress;
  assert.equal(rooms.achievements.day.difficulties.length, 3, 'a second Easy win the same day adds no room');
  assert.ok(unlocksOf(rooms, completion({ difficultyKey: 'insane', day: '2026-05-04', mistakes: 3 })).includes('four-rooms-one-day'));

  assert.ok(unlocksOf(empty, completion({ difficultyKey: 'advanced', elapsedMs: 30_999 })).includes('lightning-recall'));
  assert.ok(!unlocksOf(empty, completion({ difficultyKey: 'advanced', elapsedMs: 31_000 })).includes('lightning-recall'));
  assert.ok(!unlocksOf(empty, completion({ difficultyKey: 'advanced', mistakes: 1, elapsedMs: 10_000 })).includes('lightning-recall'));
}

// ------------------------------------------------- award once, duplicates ---

function verifyAwardOnce() {
  const empty = createEmptyProgress();
  const first = completion({ completedAt: 1_780_000_123_456 });
  const won = play(empty, first);
  assert.deepEqual(won.progress.achievements.unlocked['wins-1'], { at: 1_780_000_123_456, runId: first.runId }, 'stamped with the completion time and run');
  assert.ok(won.unlocked.includes('wins-1') && won.unlocked.includes('perfect-1') && won.unlocked.includes('easy-wins-1'));

  const replay = play(won.progress, first);
  assert.deepEqual(replay, { progress: won.progress, recorded: false, reason: 'duplicate', unlocked: [] }, 'a replayed completion awards nothing');
  const tampered = play(won.progress, { ...completion(), score: 6000 });
  assert.deepEqual([tampered.recorded, tampered.unlocked], [false, []], 'an invalid completion awards nothing');

  const second = play(won.progress, completion({ completedAt: 1_780_000_999_999 }));
  assert.deepEqual(second.progress.achievements.unlocked['wins-1'], won.progress.achievements.unlocked['wins-1'], 'an unlock never changes once made');
  assert.ok(!second.unlocked.includes('wins-1'));

  const fallback = play(empty, completion({ completedAt: -5 }));
  assert.equal(fallback.progress.achievements.unlocked['wins-1'].at, NOW, 'without a valid completion time, the time of recording');

  // The award step on its own never re-awards either.
  const again = awardCompletion(second.progress, recordCompletion(second.progress, completion(), runtime).completion, catalog, runtime, NOW);
  assert.ok(again.unlocked.every((id) => !Object.hasOwn(second.progress.achievements.unlocked, id)));

  // Abandonment and reset never unlock; a reset keeps what was unlocked.
  const abandoned = recordAbandonment(second.progress, { runId: 'run-ach-left-01', difficultyKey: 'easy', mistakes: 2 });
  assert.deepEqual(abandoned.progress.achievements, second.progress.achievements, 'abandoning a run touches no achievement');
  const reset = resetProgress(second.progress, NOW).progress;
  assert.deepEqual(reset.achievements.unlocked, second.progress.achievements.unlocked, 'a reset takes nothing back');
  assert.deepEqual(reset.achievements.bests.easy, { fewestMistakes: null, fastestSharpWin: null, fastestPerfectWin: null, topScore: null }, 'but progress toward the rest starts over');
  assert.equal(reset.totals.wins, 0);
  const afterReset = play(reset, completion());
  assert.ok(!afterReset.unlocked.includes('wins-1'), 'and nothing is awarded twice');
  const shown = describeAchievements(afterReset.progress, catalog, runtime);
  const winsThree = shown.find((item) => item.id === 'wins-3');
  assert.deepEqual([winsThree.value, winsThree.unlocked], [1, false], 'locked ones measure from the reset');
  // Progress toward what is still locked: a share of the threshold, or for a
  // time or mistake limit, how close the best so far comes to it.
  let partial = createEmptyProgress();
  for (const detail of [completion(), completion(), completion(), completion()]) partial = play(partial, detail).progress;
  partial = play(partial, completion({ difficultyKey: 'insane', mistakes: 3, elapsedMs: 59_500 })).progress;
  const progressOf = (state) => Object.fromEntries(describeAchievements(state, catalog, runtime).map((item) => [item.id, [item.value, item.progress]]));
  const partialShown = progressOf(partial);
  assert.deepEqual(partialShown['wins-10'], [5, 0.5]);
  assert.deepEqual(partialShown['flawless-insanity'], [3, 1 / 4], 'three mistakes from none');
  assert.deepEqual(partialShown['speed-insane-3'], [59, 38 / 60], '59 s against 37 s');
  assert.deepEqual(partialShown['speed-insane-1'], [59, 1]);
  assert.deepEqual(partialShown['lightning-recall'], [null, 0], 'no perfect Advanced win yet');
  assert.deepEqual(progressOf(createEmptyProgress())['wins-1'], [0, 0]);
  const winsOne = shown.find((item) => item.id === 'wins-1');
  assert.deepEqual([winsOne.unlocked, winsOne.progress, winsOne.unlockedAt], [true, 1, 1_780_000_123_456]);

  // The player's own reset of achievement progress: everything the
  // achievements stand on starts over, except the ledger.
  const earned = second.progress;
  const cleared = resetAchievementProgress({ ...earned, resetAt: 1_780_000_000_000 }, NOW);
  assert.deepEqual([cleared.recorded, cleared.unlocked], [true, []]);
  assert.deepEqual(cleared.progress.achievements, { ...createEmptyProgress().achievements, resetAt: NOW }, 'unlocks, bests and days start over');
  assert.deepEqual(cleared.progress.totals, createEmptyProgress().totals, 'and the totals they are measured on');
  assert.deepEqual(cleared.progress.recordedRuns, earned.recordedRuns, 'the ledger stays');
  assert.equal(cleared.progress.resetAt, 1_780_000_000_000, 'the statistics reset time is not this one');
  assert.equal(cleared.progress.legacy, null, 'nothing is backfilled again');
  assert.equal(play(cleared.progress, first).reason, 'duplicate', 'a replayed old completion still cannot count');
  const fresh = play(cleared.progress, completion());
  assert.ok(fresh.unlocked.includes('wins-1'), 'achievements can be earned again after this reset');
  assert.equal(resetAchievementProgress(earned, 'soon').progress.achievements.resetAt, null);
}

// ------------------------------------- no reward for spam or worse play ---

function verifyNoRewardForWorsePlay() {
  // Mashing cards: the mistakes random clicking makes, at a speed only
  // reduced motion allows. It wins the game, and nothing else.
  const mashed = unlocksOf(createEmptyProgress(), completion({ mistakes: 30, elapsedMs: 13_000 }));
  assert.deepEqual(mashed.sort(), ['easy-wins-1', 'wins-1'], 'spam clicking earns only the win itself');

  // A worse game (more mistakes, more time) never unlocks or advances more
  // than a better one, from the same record.
  let seed = 20260504;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const states = [createEmptyProgress()];
  let career = createEmptyProgress();
  for (let index = 0; index < 40; index += 1) {
    career = play(career, completion({ difficultyKey: DIFFICULTY_KEYS[index % 4], mistakes: index % 3 === 0 ? 1 : 0, day: '2026-05-04' })).progress;
    if (index % 10 === 9) states.push(career);
  }
  for (let trial = 0; trial < 400; trial += 1) {
    const state = states[trial % states.length];
    const difficultyKey = DIFFICULTY_KEYS[Math.floor(random() * 4)];
    const mistakes = Math.floor(random() * 8);
    const seconds = Math.floor(playedMs(difficultyKey, mistakes) / 1000) + Math.floor(random() * 120);
    const extraMistakes = Math.floor(random() * 4);
    const extraSeconds = extraMistakes ? Math.floor(random() * 60) : 1 + Math.floor(random() * 60);
    const better = completion({ difficultyKey, mistakes, elapsedMs: seconds * 1000, day: '2026-05-04' });
    const worse = completion({ difficultyKey, mistakes: mistakes + extraMistakes, elapsedMs: (seconds + extraSeconds) * 1000, day: '2026-05-04' });
    const good = play(state, better);
    const bad = play(state, worse);
    assert.ok(bad.unlocked.every((id) => good.unlocked.includes(id)), `trial ${trial}: a worse game unlocked ${bad.unlocked.filter((id) => !good.unlocked.includes(id))}`);
    const goodProgress = describeAchievements(good.progress, catalog, runtime);
    describeAchievements(bad.progress, catalog, runtime).forEach((item, index) => {
      assert.ok(item.progress <= goodProgress[index].progress + 1e-12, `trial ${trial}: a worse game advanced ${item.id}`);
    });
  }
}

// ------------------------------------------------- backfill and migration ---

function verifyBackfill() {
  // What one legacy best proves.
  const prove = (best) => provenByStatistics({ won: 1, bests: { easy: best } }, runtime).byDifficulty.easy;
  assert.deepEqual(prove({ time: 15, mistakes: 0, score: 5900 }), { fewestMistakes: 0, topScore: 5900, fastestSharpWin: 20, fastestPerfectWin: 20 }, 'a best score that leaves no room for a mistake proves a perfect game and its time');
  assert.deepEqual(prove({ time: 20, mistakes: 1, score: 5525 }), { fewestMistakes: 1, topScore: 5525, fastestSharpWin: 25, fastestPerfectWin: null }, 'the other bests narrow what the best score allows');
  const separate = { won: 1, bests: { easy: { time: 10, mistakes: 0, score: 5525 } } };
  assert.deepEqual(prove(separate.bests.easy), { fewestMistakes: 0, topScore: 5525, fastestSharpWin: 95, fastestPerfectWin: null }, 'a fast best time and a clean best game may be different games: only the best-score game\'s bound is proven');
  const separateUnlocks = backfillAchievements(seedFromLegacyStatistics(separate), separate, catalog, runtime, NOW).unlocked;
  assert.ok(!separateUnlocks.some((id) => entry(id).category === 'speed' || id === 'lightning-recall'), 'so no speed goal is backfilled from a 10 s best time');
  assert.deepEqual(prove({ time: 100, mistakes: 0, score: 5900 }), { fewestMistakes: 0, topScore: null, fastestSharpWin: null, fastestPerfectWin: null }, 'a score no game consistent with the other bests can make proves nothing');
  for (const score of [0, 6500, 5001]) {
    assert.equal(prove({ time: 20, mistakes: 0, score }).topScore, null, `a score of ${score} proves nothing`);
  }
  const insane = provenByStatistics({ won: 1, bests: { insane: { time: 40, mistakes: 1, score: 13000 } } }, runtime).byDifficulty.insane;
  assert.deepEqual(insane, { fewestMistakes: 1, topScore: 13000, fastestSharpWin: 330, fastestPerfectWin: null });
  const garbage = provenByStatistics({ won: 'x', perfect: 3, bests: { easy: { time: -1, mistakes: 0, score: 10 }, nope: {}, insane: 'broken' } }, runtime);
  assert.deepEqual(garbage, { wins: 0, perfectWins: 0, byDifficulty: {} }, 'invalid entries prove nothing');
  assert.deepEqual(provenByStatistics(null, runtime), { wins: 0, perfectWins: 0, byDifficulty: {} });

  // A player upgrading with legacy statistics only.
  const stats = {
    played: 14, won: 10, perfect: 3, bestScore: 13000,
    bests: { easy: { time: 15, mistakes: 0, score: 5900 }, insane: { time: 40, mistakes: 1, score: 13000 } },
  };
  const seeded = seedFromLegacyStatistics(stats);
  const { progress, unlocked } = backfillAchievements(seeded, stats, catalog, runtime, NOW);
  assert.deepEqual(unlocked.sort(), [
    'easy-wins-1', 'excellent-easy', 'excellent-insane', 'insane-wins-1', 'perfect-1', 'perfect-2', 'perfect-3',
    'performance-95', 'score-1', 'score-2', 'speed-easy-1', 'speed-easy-2', 'wins-1', 'wins-10', 'wins-3', 'wins-5',
  ].sort(), 'exactly what the old record proves');
  assert.ok(Object.values(progress.achievements.unlocked).every((award) => award.at === NOW && award.runId === null), 'backfilled: no run, the time of the backfill');
  assert.deepEqual(DIFFICULTY_KEYS.map((key) => progress.byDifficulty[key].wins), [0, 0, 0, 0], 'no per-difficulty count is invented');
  assert.deepEqual([progress.totals.matchedPairs, progress.totals.bestPerfectStreak, progress.daily.best], [0, 0, 0], 'nor pairs or streak history');
  assert.deepEqual({ ...progress, achievements: seeded.achievements }, seeded, 'only the achievements section changes');
  assert.deepEqual(progress.achievements.bests.insane, { fewestMistakes: 1, fastestSharpWin: 330, fastestPerfectWin: null, topScore: 13000 });
  const shown = describeAchievements(progress, catalog, runtime);
  assert.ok(shown.find((item) => item.id === 'easy-wins-1').backfilled);
  assert.equal(shown.find((item) => item.id === 'easy-wins-5').value, 0, 'the next difficulty milestone counts from tracked wins only');
  assert.equal(shown.find((item) => item.id === 'flawless-insanity').value, 1, 'progress shows the proven best');

  const twice = backfillAchievements(progress, stats, catalog, runtime, NOW + 1);
  assert.deepEqual([twice.unlocked, twice.progress], [[], progress], 'the backfill is idempotent');

  // A perfect Insane game proves an unbroken chain of all its pairs.
  const perfectInsane = { won: 1, perfect: 1, bests: { insane: { time: 90, mistakes: 0, score: 1000 } } };
  const chain = backfillAchievements(seedFromLegacyStatistics(perfectInsane), perfectInsane, catalog, runtime, NOW);
  assert.ok(chain.unlocked.includes('flawless-insanity') && chain.unlocked.includes('unbroken-thread'));
  assert.equal(chain.progress.totals.bestMatchChain, 0, 'without writing a chain into the totals');

  // Bests already better than the legacy ones are kept.
  const better = createEmptyProgress();
  better.achievements.bests.easy = { fewestMistakes: 0, fastestSharpWin: 9, fastestPerfectWin: 9, topScore: 5955 };
  assert.deepEqual(backfillAchievements(better, stats, catalog, runtime, NOW).progress.achievements.bests.easy, better.achievements.bests.easy);

  // A version-1 record is carried over: its tracked totals and streaks are
  // facts, and backfill from them as well as from the statistics.
  const v1 = createEmptyProgress();
  delete v1.achievements;
  v1.version = 1;
  Object.assign(v1.totals, { wins: 7, perfectWins: 4, matchedPairs: 80, earnedScore: 40000, bestMatchChain: 10, perfectStreak: 1, bestPerfectStreak: 3 });
  Object.assign(v1.byDifficulty.advanced, { wins: 5, perfectWins: 2, matchedPairs: 50, bestMatchChain: 10, perfectStreak: 1, bestPerfectStreak: 2 });
  v1.daily = { current: 2, best: 4, lastWinDay: '2026-04-30' };
  v1.recordedRuns = ['run-v1-000001'];
  const read = readProgress(JSON.stringify(v1));
  assert.equal(read.status, 'migrated');
  assert.equal(read.progress.version, 2);
  assert.deepEqual(read.progress.achievements, createEmptyProgress().achievements, 'with an empty achievements section to backfill');
  const migrated = backfillAchievements(read.progress, { won: 7, perfect: 4, bests: {} }, catalog, runtime, NOW);
  assert.deepEqual(migrated.unlocked.sort(), [
    'advanced-wins-1', 'advanced-wins-5', 'daily-streak-2', 'daily-streak-3', 'pairs-25', 'pairs-50',
    'perfect-1', 'perfect-2', 'perfect-3', 'perfect-streak-2', 'perfect-streak-3', 'wins-1', 'wins-3', 'wins-5',
  ].sort());
  assert.equal(migrated.progress.achievements.bests.advanced.fewestMistakes, 0, 'tracked perfect wins prove a perfect game there');
  assert.deepEqual(migrated.progress.recordedRuns, ['run-v1-000001']);
}

function verifyModel() {
  const damaged = createEmptyProgress();
  damaged.achievements = {
    unlocked: {
      'wins-1': { at: 1_780_000_000_000, runId: 'run-good-0001' },
      'perfect-1': { at: 'yesterday', runId: 'bad id!' },
      'Not An Id': { at: 1, runId: null },
      'future-achievement': { at: 5, runId: null },
      'easy-wins-1': true,
    },
    bests: {
      easy: { fewestMistakes: 1, fastestSharpWin: 40, fastestPerfectWin: 30, topScore: -3 },
      insane: { fewestMistakes: 0, fastestSharpWin: 50, fastestPerfectWin: 30, topScore: 14000 },
      advanced: 'broken',
    },
    day: { key: '2026-05-04', difficulties: ['easy', 'easy', 'nope', 'insane'], most: 9 },
  };
  const read = readProgress(JSON.stringify(damaged));
  assert.equal(read.status, 'repaired');
  assert.deepEqual(read.progress.achievements.unlocked, {
    'wins-1': { at: 1_780_000_000_000, runId: 'run-good-0001' },
    'perfect-1': { at: null, runId: null },
    'future-achievement': { at: 5, runId: null },
  }, 'a damaged stamp keeps the unlock; invalid ids and entries are dropped; unknown ids are kept');
  assert.deepEqual(read.progress.achievements.bests.easy, { fewestMistakes: 1, fastestSharpWin: 40, fastestPerfectWin: null, topScore: null }, 'a perfect time without a perfect game is dropped');
  assert.deepEqual(read.progress.achievements.bests.insane, { fewestMistakes: 0, fastestSharpWin: 30, fastestPerfectWin: 30, topScore: 14000 }, 'a perfect win is within the speed limit too');
  assert.deepEqual(read.progress.achievements.bests.advanced, { fewestMistakes: null, fastestSharpWin: null, fastestPerfectWin: null, topScore: null });
  assert.deepEqual(read.progress.achievements.day, { key: '2026-05-04', difficulties: ['easy', 'insane'], most: 4 });
  const noDay = readProgress(JSON.stringify({ ...createEmptyProgress(), achievements: { day: { key: '2026-02-30', difficulties: ['easy'], most: 1 }, resetAt: -4 } }));
  assert.deepEqual(noDay.progress.achievements.day, { key: null, difficulties: [], most: 1 });
  assert.equal(noDay.progress.achievements.resetAt, null, 'an invalid reset time is dropped');
  const resetKept = { ...createEmptyProgress(), achievements: { ...createEmptyProgress().achievements, resetAt: 1_780_000_000_000 } };
  assert.deepEqual(readProgress(JSON.stringify(resetKept)), { progress: resetKept, status: 'ok' });
  const clean = play(createEmptyProgress(), completion()).progress;
  assert.deepEqual(readProgress(JSON.stringify(clean)), { progress: clean, status: 'ok' }, 'a record with unlocks reads back as is');
  assert.equal(readProgress(JSON.stringify({ ...clean, version: 3 })).status, 'newer');
}

// ----------------------------------------------------------- the tracker ---

function fakeStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

let instance = 0;
async function loadTracker(localStorage) {
  const window = new EventTarget();
  Object.defineProperty(window, 'localStorage', { get: () => localStorage });
  window.DEJA_VU_RUNTIME = runtime;
  globalThis.window = window;
  const events = [];
  for (const type of ['deja-vu:achievements-unlocked', 'deja-vu:progress-updated']) {
    window.addEventListener(type, (event) => events.push({ type, detail: event.detail }));
  }
  instance += 1;
  const url = `${pathToFileURL(path.join(rootDirectory, 'progress-tracker.js')).href}?achievements=${instance}`;
  const tracker = await import(url);
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  const unlocks = () => events.filter((event) => event.type === 'deja-vu:achievements-unlocked');
  return { ...tracker, emit, complete: (detail) => emit('deja-vu:completion', detail), events, unlocks };
}

const stored = (storage) => JSON.parse(storage.data.get(PROGRESS_KEY));

async function verifyTracker() {
  // Legacy statistics only: seeded and backfilled at load, before any game.
  const stats = { played: 4, won: 2, perfect: 1, bestScore: 5900, bests: { easy: { time: 15, mistakes: 0, score: 5900 } } };
  const storage = fakeStorage({ [STATS_KEY]: JSON.stringify(stats) });
  let tracker = await loadTracker(storage);
  const backfilled = stored(storage).achievements.unlocked;
  assert.equal(stored(storage).version, 2);
  assert.ok(Object.hasOwn(backfilled, 'speed-easy-2') && Object.hasOwn(backfilled, 'perfect-1'), 'backfilled on load');
  assert.ok(Object.values(backfilled).every((award) => award.runId === null && Number.isSafeInteger(award.at)));
  assert.deepEqual(tracker.unlocks(), [], 'a backfill is not announced as a new unlock');
  assert.deepEqual(tracker.getSessionBackfill().sort(), Object.keys(backfilled).sort(), 'but reported once, for this page load');

  const list = tracker.getAchievements();
  assert.equal(list.length, 100);
  for (const item of list) {
    for (const field of ['id', 'name', 'requirement', 'category', 'threshold', 'value', 'progress', 'unlocked', 'unlockedAt']) {
      assert.ok(Object.hasOwn(item, field), `${item.id} reports ${field}`);
    }
    assert.ok(item.progress >= 0 && item.progress <= 1);
  }

  // Gameplay events that cannot raise anything evaluate nothing and write nothing.
  const before = storage.data.get(PROGRESS_KEY);
  tracker.emit('deja-vu:match', { runId: 'run-ach-live-01', difficultyKey: 'easy', chain: 6, bestChain: 6, matchedPairs: 6 });
  tracker.emit('deja-vu:mismatch', { runId: 'run-ach-live-01', difficultyKey: 'easy', chain: 0, bestChain: 6, mistakes: 1 });
  assert.equal(storage.data.get(PROGRESS_KEY), before, 'matches and mismatches leave the record alone');
  tracker.emit('deja-vu:run-abandoned', { runId: 'run-ach-left-02', difficultyKey: 'easy', mistakes: 1 });
  assert.deepEqual(tracker.unlocks(), [], 'abandoning a run unlocks nothing');

  // index.js counts the win in the legacy statistics before announcing it.
  storage.setItem(STATS_KEY, JSON.stringify({ ...stats, played: 5, won: 3, perfect: 2 }));
  const win = completion({ difficultyKey: 'insane', completedAt: 1_780_123_456_789 });
  tracker.complete(win);
  tracker.complete(win);
  const unlockedNow = stored(storage).achievements.unlocked;
  assert.deepEqual(unlockedNow['flawless-insanity'], { at: 1_780_123_456_789, runId: win.runId }, 'a win unlocks with its run and time');
  assert.deepEqual(unlockedNow['perfect-1'], backfilled['perfect-1'], 'an earlier unlock is untouched');
  assert.ok(Object.hasOwn(unlockedNow, 'wins-3'), 'the legacy wins plus this one');
  assert.equal(tracker.unlocks().length, 1, 'announced once, the replay not at all');
  const announced = tracker.unlocks()[0].detail;
  assert.equal(announced.runId, win.runId);
  assert.ok(announced.achievements.every((item) => item.unlocked && item.unlockedAt === 1_780_123_456_789 && item.name && item.requirement));
  assert.deepEqual(announced.achievements.map((item) => item.id).sort(), Object.keys(unlockedNow).filter((id) => unlockedNow[id].runId === win.runId).sort());

  // Reload: same storage, fresh instance. Nothing is re-backfilled or re-awarded.
  const snapshot = storage.data.get(PROGRESS_KEY);
  tracker = await loadTracker(storage);
  assert.equal(storage.data.get(PROGRESS_KEY), snapshot, 'a reload changes nothing');
  assert.deepEqual(tracker.getSessionBackfill(), [], 'and reports no backfill');
  tracker.complete(win);
  assert.deepEqual(tracker.unlocks(), [], 'a replay after a reload awards nothing');

  // A statistics reset keeps every unlock.
  tracker.emit('deja-vu:statistics-reset', { at: NOW });
  assert.deepEqual(stored(storage).achievements.unlocked, unlockedNow);
  assert.equal(stored(storage).totals.wins, 0);
  assert.deepEqual(tracker.unlocks(), [], 'a reset unlocks nothing');

  // Resetting achievements, confirmed on the Achievements screen, clears them
  // and leaves the statistics record alone.
  const statsBefore = storage.data.get(STATS_KEY);
  tracker.emit('deja-vu:achievements-reset', { at: NOW + 5 });
  assert.deepEqual(stored(storage).achievements.unlocked, {});
  assert.equal(stored(storage).achievements.resetAt, NOW + 5);
  assert.equal(storage.data.get(STATS_KEY), statsBefore, 'statistics untouched');
  const afterReset = tracker.events.filter((event) => event.type === 'deja-vu:progress-updated').at(-1).detail;
  assert.deepEqual([afterReset.cause, afterReset.unlocked], ['achievements reset', []]);
  tracker.complete(win);
  assert.deepEqual(stored(storage).achievements.unlocked, {}, 'an old run still cannot earn anything');
  tracker.complete(completion({ completedAt: NOW + 10 }));
  assert.equal(stored(storage).achievements.unlocked['wins-1'].at, NOW + 10, 'a new one can');

  // A version-1 record is migrated once, at load.
  const v1 = createEmptyProgress();
  delete v1.achievements;
  v1.version = 1;
  Object.assign(v1.totals, { wins: 5, perfectWins: 5, perfectStreak: 5, bestPerfectStreak: 5, matchedPairs: 30 });
  const old = fakeStorage({ [PROGRESS_KEY]: JSON.stringify(v1), [STATS_KEY]: JSON.stringify({ played: 5, won: 5, perfect: 5, bests: {} }) });
  tracker = await loadTracker(old);
  assert.equal(stored(old).version, 2);
  assert.equal(readProgress(old.data.get(PROGRESS_KEY)).status, 'ok');
  assert.ok(['wins-5', 'perfect-5', 'perfect-streak-5', 'pairs-25'].every((id) => stored(old).achievements.unlocked[id]?.runId === null));
  const migratedOnce = old.data.get(PROGRESS_KEY);
  await loadTracker(old);
  assert.equal(old.data.get(PROGRESS_KEY), migratedOnce, 'migrated once: a reload does not backfill again');

  // A record from a newer build: untouched, unlocks kept in memory.
  const newer = '{"version":3,"future":true}';
  const future = fakeStorage({ [PROGRESS_KEY]: newer });
  tracker = await loadTracker(future);
  tracker.complete(completion());
  assert.equal(future.data.get(PROGRESS_KEY), newer);
  assert.ok(tracker.getAchievements().find((item) => item.id === 'wins-1').unlocked, 'tracked for the session');

  // A full quota: unlocks wait in memory and are written with the next save.
  const full = fakeStorage();
  tracker = await loadTracker(full);
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  const quotaWin = completion();
  tracker.complete(quotaWin);
  assert.equal(tracker.getAchievements().find((item) => item.id === 'wins-1').runId, quotaWin.runId);
  full.setItem = (key, value) => full.data.set(key, String(value));
  tracker.complete(completion());
  assert.equal(stored(full).achievements.unlocked['wins-1'].runId, quotaWin.runId, 'the earlier unlock is saved, not lost or re-stamped');
}

verifyCatalog();
verifyThresholds();
verifyCareer();
verifyBoundaries();
verifyAwardOnce();
verifyNoRewardForWorsePlay();
verifyBackfill();
verifyModel();
await verifyTracker();

console.log('Achievement catalog: PASS (exactly 100, stable unique ids and names, 15/20/10/10/10/10/10/10/5, plain requirements)');
console.log('Achievement thresholds: PASS (derived from board sizes, scoring and turn timings; each attainable at a human pace; every one reached by valid completions)');
console.log('Achievement evaluator: PASS (boundaries, award once, duplicates, resets, no reward for spam or worse play)');
console.log('Achievement backfill: PASS (only what legacy statistics and version-1 records prove; no invented counts or streaks; idempotent)');
console.log('Achievement storage: PASS (load backfill, unlock events, reload, reset, migration, newer record, full quota)');
