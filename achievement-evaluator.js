// DEJA VU achievement evaluator: pure functions from (record, run) to unlocks.
//
// No DOM, storage or clock: times come in as arguments, scoring and board
// sizes from runtime-config.js (`runtime`), the definitions from
// achievement-catalog.js (`catalog`). Inputs are never mutated.
//
// When achievements are evaluated, explicitly:
//  - On a completed run that progress-evaluator.js has just recorded: valid,
//    and new by its runId. Only completions can raise anything an achievement
//    measures, so matches, mismatches, abandoned runs and resets never trigger
//    an evaluation, and a replayed or invalid completion is refused before it
//    gets here.
//  - Once, when a record is first created or carried over from version 1:
//    the backfill below.
// Each achievement is awarded once. An unlock records when it happened and
// the run that earned it, and is never changed or repeated afterwards, a
// statistics reset included.
//
// Nothing rewards clicking more or playing worse: no measure counts moves or
// mistakes upward, time and score goals are measured on the game's own clock
// and scoring, and speed goals only count wins within a mistake limit. A
// worse game never unlocks anything a better one would not.

import { DIFFICULTY_KEYS, dayNumber } from './progress-model.js';
import { recordCompletion } from './progress-evaluator.js';
import { speedMistakeLimit } from './achievement-catalog.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const count = (value) => (isCount(value) ? value : 0);
const lower = (current, candidate) => (candidate === null ? current : current === null ? candidate : Math.min(current, candidate));
const higher = (current, candidate) => (candidate === null ? current : current === null ? candidate : Math.max(current, candidate));
const highest = (values) => values.reduce(higher, null);
const timestamp = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * The value an achievement is measured on, from the record alone; null while
 * nothing counts yet (no qualifying win for a best).
 */
export function metricValue(progress, entry, runtime) {
  const { metric, difficulty } = entry;
  const scope = difficulty ? progress.byDifficulty[difficulty] : progress.totals;
  const { bests, day } = progress.achievements;
  const boards = difficulty ? [difficulty] : DIFFICULTY_KEYS;
  const perfectBoards = DIFFICULTY_KEYS.filter((key) => bests[key].fewestMistakes === 0);
  switch (metric) {
    case 'wins':
    case 'perfectWins':
    case 'matchedPairs':
    case 'earnedScore':
    case 'bestPerfectStreak':
      return scope[metric];
    case 'bestMatchChain':
      // A win without a mistake is one unbroken chain of every pair it has.
      return Math.max(scope.bestMatchChain, ...perfectBoards.filter((key) => boards.includes(key)).map((key) => runtime.difficulties[key].pairs));
    case 'bestDailyStreak':
      return progress.daily.best;
    case 'fewestMistakes':
    case 'fastestSharpWin':
    case 'fastestPerfectWin':
      return bests[difficulty][metric];
    case 'topScore':
      return highest(boards.map((key) => bests[key].topScore));
    case 'topPerformance':
      return highest(boards.map((key) => (bests[key].topScore === null
        ? null
        : runtime.calculatePerformancePercent(key, bests[key].topScore))));
    case 'perfectDifficulties':
      return perfectBoards.length;
    case 'difficultiesInOneDay':
      return day.most;
    default:
      return null;
  }
}

export function isMet(entry, value) {
  if (value === null || value === undefined) return false;
  return entry.comparison === 'atMost' ? value <= entry.threshold : value >= entry.threshold;
}

// Awards every achievement in the catalog that `valueOf` now meets and that
// is not unlocked yet. Returns the ids awarded.
function unlock(progress, catalog, valueOf, stamp) {
  const { unlocked } = progress.achievements;
  const awarded = [];
  for (const entry of catalog) {
    if (Object.hasOwn(unlocked, entry.id) || !isMet(entry, valueOf(entry))) continue;
    unlocked[entry.id] = { ...stamp };
    awarded.push(entry.id);
  }
  return awarded;
}

// What this run adds to the bests and to the record of difficulties won on
// one local day.
function creditRun(achievements, completion, runtime) {
  const { difficultyKey, mistakes, elapsed, score, day } = completion;
  const bests = achievements.bests[difficultyKey];
  bests.fewestMistakes = lower(bests.fewestMistakes, mistakes);
  bests.topScore = higher(bests.topScore, score);
  if (mistakes <= speedMistakeLimit(runtime.difficulties[difficultyKey].pairs)) {
    bests.fastestSharpWin = lower(bests.fastestSharpWin, elapsed);
  }
  if (mistakes === 0) bests.fastestPerfectWin = lower(bests.fastestPerfectWin, elapsed);

  const today = dayNumber(day);
  const last = dayNumber(achievements.day.key);
  if (last === null || today > last) {
    achievements.day.key = day;
    achievements.day.difficulties = [difficultyKey];
  } else if (today === last && !achievements.day.difficulties.includes(difficultyKey)) {
    achievements.day.difficulties.push(difficultyKey);
  }
  // A win dated before the latest winning day (the clock moved back) counts
  // toward no day.
  achievements.day.most = Math.max(achievements.day.most, achievements.day.difficulties.length);
}

/**
 * Awards what a recorded completion unlocks. `completion` is the validated
 * one recordCompletion returns, and `progress` already includes it. Unlocks
 * are stamped with the completion's time (or `now`) and its runId.
 * Returns { progress, unlocked: [ids] }.
 */
export function awardCompletion(progress, completion, catalog, runtime, now) {
  const next = clone(progress);
  creditRun(next.achievements, completion, runtime);
  const stamp = { at: completion.completedAt ?? timestamp(now), runId: completion.runId };
  const unlocked = unlock(next, catalog, (entry) => metricValue(next, entry, runtime), stamp);
  return { progress: next, unlocked };
}

/**
 * A completion event, start to finish: recorded once by progress-evaluator.js,
 * then awarded. Returns { progress, recorded, reason, unlocked }.
 */
export function recordCompletionAndAward(progress, detail, catalog, runtime, now) {
  const result = recordCompletion(progress, detail, runtime);
  if (!result.recorded) return { progress, recorded: false, reason: result.reason, unlocked: [] };
  const awarded = awardCompletion(result.progress, result.completion, catalog, runtime, now);
  return { progress: awarded.progress, recorded: true, reason: result.reason, unlocked: awarded.unlocked, runId: result.completion.runId };
}

// ---------------------------------------------------------------- backfill ---

// The legacy statistics keep each difficulty's best time, fewest mistakes
// and best score independently, possibly from three different games, so only
// the best score describes one whole game. With the game's scoring it fixes
// mistakes × penalty + seconds × penalty for that game, which had no fewer
// mistakes and no less time than the other two bests. What every game
// consistent with that has in common is proven; anything else is not.
function scoreProof(key, best, runtime) {
  const unproven = { topScore: null, fastestSharpWin: null, fastestPerfectWin: null };
  const { pairs } = runtime.difficulties[key];
  const { basePerPair, mistakePenalty, timePenaltyPerSecond } = runtime.scoring;
  const deficit = pairs * basePerPair - best.score;
  // A score of 0 may be clamped, so it fixes nothing; one above the board's
  // maximum is impossible.
  if (best.score === 0 || deficit < 0 || mistakePenalty <= 0 || timePenaltyPerSecond <= 0) return unproven;
  const games = [];
  for (let mistakes = best.mistakes; mistakes * mistakePenalty + best.time * timePenaltyPerSecond <= deficit; mistakes += 1) {
    const seconds = (deficit - mistakes * mistakePenalty) / timePenaltyPerSecond;
    if (Number.isInteger(seconds) && runtime.calculateScore(key, mistakes, seconds) === best.score) games.push({ mistakes, seconds });
  }
  if (!games.length) return unproven;
  const mostMistakes = Math.max(...games.map((game) => game.mistakes));
  const mostSeconds = Math.max(...games.map((game) => game.seconds));
  return {
    topScore: best.score,
    fastestSharpWin: mostMistakes <= speedMistakeLimit(pairs) ? mostSeconds : null,
    fastestPerfectWin: mostMistakes === 0 ? mostSeconds : null,
  };
}

/**
 * What the legacy statistics record (`inspireDejaVu:v1:statistics`) proves:
 * the number of wins and of perfect wins, and per difficulty with a best
 * entry, a win there, its fewest mistakes, and what its best score proves.
 * Nothing about pairs, totals per difficulty, days or streaks: the old record
 * never kept them.
 */
export function provenByStatistics(statistics, runtime) {
  const source = isRecord(statistics) ? statistics : {};
  const wins = count(source.won);
  const proof = { wins, perfectWins: Math.min(count(source.perfect), wins), byDifficulty: {} };
  const bests = isRecord(source.bests) ? source.bests : {};
  for (const key of DIFFICULTY_KEYS) {
    const best = bests[key];
    if (!isRecord(best) || !isCount(best.time) || !isCount(best.mistakes) || !isCount(best.score)) continue;
    proof.byDifficulty[key] = { fewestMistakes: best.mistakes, ...scoreProof(key, best, runtime) };
  }
  return proof;
}

/**
 * Credits a new or carried-over record with what earlier play proves: the
 * record's own totals (which a version-1 record kept since it began), and
 * the legacy statistics. Bests take proven values only, and only improve.
 * Per-difficulty win counts are not invented: a legacy best proves one win
 * there, which can unlock that difficulty's first milestone, and no count is
 * written. Streaks and days are never backfilled beyond what the record
 * tracked. Backfilled unlocks carry `runId: null` and the time of the
 * backfill, since when they were first earned is unknown.
 * Returns { progress, unlocked: [ids] }.
 */
export function backfillAchievements(progress, statistics, catalog, runtime, now) {
  const next = clone(progress);
  const proof = provenByStatistics(statistics, runtime);
  for (const key of DIFFICULTY_KEYS) {
    const bests = next.achievements.bests[key];
    if (next.byDifficulty[key].perfectWins > 0) bests.fewestMistakes = lower(bests.fewestMistakes, 0);
    const legacy = proof.byDifficulty[key];
    if (!legacy) continue;
    bests.fewestMistakes = lower(bests.fewestMistakes, legacy.fewestMistakes);
    bests.topScore = higher(bests.topScore, legacy.topScore);
    bests.fastestSharpWin = lower(bests.fastestSharpWin, legacy.fastestSharpWin);
    bests.fastestPerfectWin = lower(bests.fastestPerfectWin, legacy.fastestPerfectWin);
  }
  const valueOf = (entry) => {
    const value = metricValue(next, entry, runtime);
    if (entry.metric === 'wins') {
      return Math.max(value, entry.difficulty ? (proof.byDifficulty[entry.difficulty] ? 1 : 0) : proof.wins);
    }
    if (entry.metric === 'perfectWins' && !entry.difficulty) return Math.max(value, proof.perfectWins);
    return value;
  };
  const unlocked = unlock(next, catalog, valueOf, { at: timestamp(now), runId: null });
  return { progress: next, unlocked };
}

// ---------------------------------------------------------- presentation ---

function fraction(entry, value) {
  if (value === null) return 0;
  if (entry.comparison === 'atMost') return value <= entry.threshold ? 1 : (entry.threshold + 1) / (value + 1);
  return Math.min(1, value / entry.threshold);
}

/**
 * Every achievement with where the player stands: the catalog fields, plus
 * `value` (the current measure, null if none yet), `progress` (0 to 1; 1 once
 * unlocked), `unlocked`, `unlockedAt` (ms), `runId` (the run that earned it)
 * and `backfilled` (proven from earlier history).
 */
export function describeAchievements(progress, catalog, runtime) {
  const { unlocked } = progress.achievements;
  return catalog.map((entry) => {
    const value = metricValue(progress, entry, runtime);
    const award = Object.hasOwn(unlocked, entry.id) ? unlocked[entry.id] : null;
    return {
      id: entry.id,
      name: entry.name,
      requirement: entry.requirement,
      category: entry.category,
      difficulty: entry.difficulty,
      comparison: entry.comparison,
      threshold: entry.threshold,
      unit: entry.unit,
      value,
      progress: award ? 1 : fraction(entry, value),
      unlocked: Boolean(award),
      unlockedAt: award ? award.at : null,
      runId: award ? award.runId : null,
      backfilled: Boolean(award) && award.runId === null,
    };
  });
}
