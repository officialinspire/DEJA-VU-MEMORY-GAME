// DEJA VU progress evaluator: pure functions from (record, event) to record.
//
// No DOM, storage or clock: the completion carries its own local calendar
// day, and scoring comes in from runtime-config.js (`runtime`), so the score
// credited is always the game's own formula. Inputs are never mutated.
//
// What counts, explicitly:
//  - Only completed runs are credited. Wins, perfect wins, matched pairs,
//    earned score, active play time and best match chain are added once per
//    run, when it completes, lifetime and per difficulty.
//  - A run is recorded at most once. The last LEDGER_LIMIT run ids are kept;
//    a completion or abandonment for a run already in it changes nothing.
//  - Consecutive perfect wins: a win without a mistake extends the streak, a
//    win with one ends it. Abandoning a run that already has a mistake ends
//    it too (walking away cannot protect a streak); abandoning a still-clean
//    run leaves it alone.
//  - Daily win streak, by the device's local calendar: the first win on a day
//    extends the streak if the previous winning day was yesterday, and starts
//    a new one otherwise; more wins the same day count once; a day with no win
//    breaks it. A win dated before the last winning day (the clock or time
//    zone moved back) is credited but leaves the streak as it was.
//  - Leaving for the menu, reloading or closing the page abandons nothing: the
//    run stays resumable. A run is abandoned only when a new game replaces it.
//  - Resetting statistics clears every total and streak (and the legacy
//    seed), but keeps the ledger, so a replayed old event still cannot count.

import {
  DIFFICULTY_KEYS,
  LEDGER_LIMIT,
  createEmptyProgress,
  dayNumber,
  isRunId,
} from './progress-model.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const capped = (value) => Math.min(value, Number.MAX_SAFE_INTEGER);

function reject(progress, reason) {
  return { progress, recorded: false, reason };
}

function remember(progress, runId) {
  progress.recordedRuns = [...progress.recordedRuns.filter((id) => id !== runId), runId].slice(-LEDGER_LIMIT);
}

/**
 * Checks a deja-vu:completion detail against the rules of the game. Returns
 * { ok: true, completion } with the fields the evaluator uses, or
 * { ok: false, reason }.
 */
export function validateCompletion(detail, runtime) {
  if (!detail || typeof detail !== 'object') return { ok: false, reason: 'no detail' };
  const { runId, difficultyKey } = detail;
  if (!isRunId(runId)) return { ok: false, reason: 'invalid runId' };
  const difficulty = runtime?.difficulties?.[difficultyKey];
  if (!difficulty || !DIFFICULTY_KEYS.includes(difficultyKey)) return { ok: false, reason: 'unknown difficulty' };

  const { pairs, moves, mistakes, elapsed, elapsedMs, score, bestMatchChain, finalMatchChain, day } = detail;
  if (pairs !== difficulty.pairs) return { ok: false, reason: 'pairs do not match the difficulty' };
  if (!isCount(moves) || !isCount(mistakes) || moves < pairs + mistakes) return { ok: false, reason: 'impossible moves or mistakes' };
  if (!isCount(elapsedMs) || elapsed !== Math.floor(elapsedMs / 1000)) return { ok: false, reason: 'inconsistent time' };
  if (typeof runtime.calculateScore !== 'function' || score !== runtime.calculateScore(difficultyKey, mistakes, elapsed)) {
    return { ok: false, reason: 'score does not match the scoring rules' };
  }
  if (!isCount(bestMatchChain) || bestMatchChain > pairs) return { ok: false, reason: 'impossible match chain' };
  if (!isCount(finalMatchChain) || finalMatchChain > bestMatchChain) return { ok: false, reason: 'impossible match chain' };
  if (mistakes === 0 && finalMatchChain !== bestMatchChain) return { ok: false, reason: 'impossible match chain' };
  if (dayNumber(day) === null) return { ok: false, reason: 'invalid day' };

  return {
    ok: true,
    completion: {
      runId, difficultyKey, pairs, moves, mistakes, elapsedMs, score, bestMatchChain, day, perfect: mistakes === 0,
    },
  };
}

function creditWin(totals, completion) {
  totals.wins = capped(totals.wins + 1);
  totals.matchedPairs = capped(totals.matchedPairs + completion.pairs);
  totals.earnedScore = capped(totals.earnedScore + completion.score);
  totals.activeTimeMs = capped(totals.activeTimeMs + completion.elapsedMs);
  totals.bestMatchChain = Math.max(totals.bestMatchChain, completion.bestMatchChain);
  if (completion.perfect) {
    totals.perfectWins = capped(totals.perfectWins + 1);
    totals.perfectStreak = capped(totals.perfectStreak + 1);
    totals.bestPerfectStreak = Math.max(totals.bestPerfectStreak, totals.perfectStreak);
  } else {
    totals.perfectStreak = 0;
  }
}

function creditDailyWin(daily, day) {
  const today = dayNumber(day);
  const last = dayNumber(daily.lastWinDay);
  if (last === null || today > last + 1) {
    daily.current = 1;
    daily.lastWinDay = day;
  } else if (today === last + 1) {
    daily.current += 1;
    daily.lastWinDay = day;
  }
  // today === last: already counted; today < last: the clock moved back.
  daily.best = Math.max(daily.best, daily.current);
}

/** Credits a completed run once. Returns { progress, recorded, reason }. */
export function recordCompletion(progress, detail, runtime) {
  if (progress.recordedRuns.includes(detail?.runId)) return reject(progress, 'duplicate');
  const checked = validateCompletion(detail, runtime);
  if (!checked.ok) return reject(progress, checked.reason);

  const { completion } = checked;
  const next = clone(progress);
  creditWin(next.totals, completion);
  creditWin(next.byDifficulty[completion.difficultyKey], completion);
  creditDailyWin(next.daily, completion.day);
  remember(next, completion.runId);
  return { progress: next, recorded: true, reason: 'completed' };
}

/**
 * A run replaced by a new game before it was finished. It earns nothing; if
 * it already had a mistake it ends the consecutive-perfect streaks. Saves
 * from before run ids existed have none: those are applied without the ledger.
 */
export function recordAbandonment(progress, detail) {
  const runId = isRunId(detail?.runId) ? detail.runId : null;
  if (runId && progress.recordedRuns.includes(runId)) return reject(progress, 'duplicate');
  if (!DIFFICULTY_KEYS.includes(detail?.difficultyKey)) return reject(progress, 'unknown difficulty');
  if (!isCount(detail.mistakes)) return reject(progress, 'invalid mistakes');

  const next = clone(progress);
  if (detail.mistakes > 0) {
    next.totals.perfectStreak = 0;
    next.byDifficulty[detail.difficultyKey].perfectStreak = 0;
  }
  if (runId) remember(next, runId);
  return { progress: next, recorded: true, reason: 'abandoned' };
}

/** Statistics reset: every total and streak starts over; the ledger stays. */
export function resetProgress(progress, at) {
  const next = createEmptyProgress();
  next.recordedRuns = [...progress.recordedRuns];
  next.resetAt = Number.isSafeInteger(at) && at >= 0 ? at : null;
  return { progress: next, recorded: true, reason: 'reset' };
}

/** The daily streak as it stands on `todayKey`: 0 once a day has been missed. */
export function currentDailyStreak(progress, todayKey) {
  const last = dayNumber(progress.daily.lastWinDay);
  const today = dayNumber(todayKey);
  if (last === null || today === null) return 0;
  return today - last <= 1 ? progress.daily.current : 0;
}

