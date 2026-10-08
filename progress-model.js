// DEJA VU progress record: what achievement tracking has to remember.
//
// Pure data, no DOM or storage. Kept under its own key, apart from the legacy
// statistics, so the statistics integrity guard (which rebuilds that record
// from the fields it knows) can never strip it. Every read is validated: a
// damaged field is repaired on its own instead of costing the whole record,
// and a record written by a newer build is reported, not reinterpreted.
//
// Version 2 adds the achievements: what has been unlocked (when, and by which
// run), and the per-run bests their progress is measured on. Totals and
// unlocks live in one record so a win and what it unlocked are saved together.

export const PROGRESS_KEY = 'inspireDejaVu:v1:progress';
export const PROGRESS_VERSION = 2;
export const DIFFICULTY_KEYS = Object.freeze(['easy', 'intermediate', 'advanced', 'insane']);
// Runs already recorded, newest last: enough to refuse any replayed event in
// practice while keeping the record small.
export const LEDGER_LIMIT = 100;

const COUNTERS = Object.freeze([
  'wins',
  'perfectWins',
  'matchedPairs',
  'earnedScore',
  'activeTimeMs',
  'bestMatchChain',
  'perfectStreak',
  'bestPerfectStreak',
]);
// Per-difficulty bests behind the achievements' progress, null until a win
// sets one: fewest mistakes, fastest win within the speed goals' mistake
// limit, fastest win without a mistake (gameplay seconds), and top score.
const BESTS = Object.freeze(['fewestMistakes', 'fastestSharpWin', 'fastestPerfectWin', 'topScore']);
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;
const ACHIEVEMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

export function isRunId(value) {
  return typeof value === 'string' && RUN_ID.test(value);
}

export function isAchievementId(value) {
  return typeof value === 'string' && value.length <= 64 && ACHIEVEMENT_ID.test(value);
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const count = (value) => (isCount(value) ? value : 0);
const optionalCount = (value) => (isCount(value) ? value : null);

/** The device's local calendar day, as YYYY-MM-DD. */
export function localDayKey(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whole days from 1970-01-01 to a day key, by the calendar alone: no clock,
 * time zone or daylight-saving change can make two days 23 or 25 hours apart.
 * null for anything that is not a real date.
 */
export function dayNumber(key) {
  const match = typeof key === 'string' ? DAY_KEY.exec(key) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1970) return null;
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return Math.round(time / DAY_MS);
}

export function emptyTotals() {
  return Object.fromEntries(COUNTERS.map((name) => [name, 0]));
}

export function emptyBests() {
  return Object.fromEntries(BESTS.map((name) => [name, null]));
}

/**
 * unlocked: { [achievementId]: { at, runId } }, `at` in ms (null if lost to
 *   damage), `runId` the run that earned it, or null when earlier history
 *   proved it;
 * bests: per difficulty, see BESTS;
 * day: the latest local day with a win, the difficulties won on it, and the
 *   most difficulties ever won on one day.
 */
export function emptyAchievements() {
  return {
    unlocked: {},
    bests: Object.fromEntries(DIFFICULTY_KEYS.map((key) => [key, emptyBests()])),
    day: { key: null, difficulties: [], most: 0 },
  };
}

export function createEmptyProgress() {
  return {
    version: PROGRESS_VERSION,
    totals: emptyTotals(),
    byDifficulty: Object.fromEntries(DIFFICULTY_KEYS.map((key) => [key, emptyTotals()])),
    daily: { current: 0, best: 0, lastWinDay: null },
    recordedRuns: [],
    legacy: null,
    resetAt: null,
    achievements: emptyAchievements(),
  };
}

function normalizeTotals(raw) {
  const totals = Object.fromEntries(COUNTERS.map((name) => [name, count(raw?.[name])]));
  totals.perfectWins = Math.min(totals.perfectWins, totals.wins);
  totals.perfectStreak = Math.min(totals.perfectStreak, totals.perfectWins);
  totals.bestPerfectStreak = Math.min(Math.max(totals.bestPerfectStreak, totals.perfectStreak), totals.perfectWins);
  return totals;
}

function normalizeDaily(raw) {
  const lastWinDay = dayNumber(raw?.lastWinDay) === null ? null : raw.lastWinDay;
  const current = lastWinDay ? Math.max(1, count(raw?.current)) : 0;
  return { current, best: Math.max(count(raw?.best), current), lastWinDay };
}

function normalizeBests(raw) {
  const bests = Object.fromEntries(BESTS.map((name) => [name, optionalCount(raw?.[name])]));
  // A time without a mistake claims a perfect win the fewest-mistakes count
  // must agree with; and a perfect win is also within the speed limit.
  if (bests.fastestPerfectWin !== null && bests.fewestMistakes !== 0) bests.fastestPerfectWin = null;
  if (bests.fastestPerfectWin !== null) {
    bests.fastestSharpWin = Math.min(bests.fastestSharpWin ?? bests.fastestPerfectWin, bests.fastestPerfectWin);
  }
  return bests;
}

function normalizeAchievements(raw) {
  const achievements = emptyAchievements();
  if (!isRecord(raw)) return achievements;
  if (isRecord(raw.unlocked)) {
    for (const [id, unlock] of Object.entries(raw.unlocked)) {
      if (!isAchievementId(id) || !isRecord(unlock)) continue;
      achievements.unlocked[id] = {
        at: Number.isSafeInteger(unlock.at) && unlock.at >= 0 ? unlock.at : null,
        runId: isRunId(unlock.runId) ? unlock.runId : null,
      };
    }
  }
  for (const key of DIFFICULTY_KEYS) {
    achievements.bests[key] = normalizeBests(isRecord(raw.bests?.[key]) ? raw.bests[key] : {});
  }
  const day = isRecord(raw.day) ? raw.day : {};
  if (dayNumber(day.key) !== null) {
    achievements.day.key = day.key;
    const won = Array.isArray(day.difficulties) ? day.difficulties.filter((key) => DIFFICULTY_KEYS.includes(key)) : [];
    achievements.day.difficulties = [...new Set(won)];
  }
  achievements.day.most = Math.min(Math.max(count(day.most), achievements.day.difficulties.length), DIFFICULTY_KEYS.length);
  return achievements;
}

function normalize(raw) {
  const progress = createEmptyProgress();
  progress.totals = normalizeTotals(isRecord(raw.totals) ? raw.totals : {});
  for (const key of DIFFICULTY_KEYS) {
    progress.byDifficulty[key] = normalizeTotals(isRecord(raw.byDifficulty?.[key]) ? raw.byDifficulty[key] : {});
  }
  progress.daily = normalizeDaily(isRecord(raw.daily) ? raw.daily : {});
  const runs = Array.isArray(raw.recordedRuns) ? raw.recordedRuns.filter(isRunId) : [];
  progress.recordedRuns = [...new Set(runs)].slice(-LEDGER_LIMIT);
  if (isRecord(raw.legacy)) {
    const wins = count(raw.legacy.wins);
    progress.legacy = { wins, perfectWins: Math.min(count(raw.legacy.perfectWins), wins) };
  }
  progress.resetAt = Number.isSafeInteger(raw.resetAt) && raw.resetAt >= 0 ? raw.resetAt : null;
  progress.achievements = normalizeAchievements(raw.achievements);
  return progress;
}

/**
 * Reads a stored record (a JSON string or a parsed value). Returns
 * { progress, status }:
 *  - 'ok'        the record was valid;
 *  - 'repaired'  some fields were invalid and were reset on their own;
 *  - 'migrated'  written by an earlier version: carried over, with an empty
 *                achievements section for the caller to backfill;
 *  - 'empty'     nothing stored;
 *  - 'corrupt'   not a record at all (progress is null);
 *  - 'newer'     written by a newer build (progress is null: leave it alone).
 */
export function readProgress(raw) {
  if (raw === null || raw === undefined) return { progress: null, status: 'empty' };
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return { progress: null, status: 'corrupt' };
    }
  }
  if (!isRecord(data)) return { progress: null, status: 'corrupt' };
  if (Number.isInteger(data.version) && data.version > PROGRESS_VERSION) return { progress: null, status: 'newer' };
  const progress = normalize(data);
  if (Number.isInteger(data.version) && data.version < PROGRESS_VERSION) return { progress, status: 'migrated' };
  const status = data.version === PROGRESS_VERSION && JSON.stringify(progress) === JSON.stringify(data) ? 'ok' : 'repaired';
  return { progress, status };
}

/**
 * The first record for a player upgrading with legacy statistics: their
 * earlier wins and perfect games count toward lifetime totals. Nothing else
 * can be recovered (the old record has no per-difficulty counts, pairs,
 * score or time), so those start from zero.
 */
export function seedFromLegacyStatistics(stats) {
  const progress = createEmptyProgress();
  const wins = count(stats?.won);
  if (!wins) return progress;
  const perfectWins = Math.min(count(stats?.perfect), wins);
  progress.totals.wins = wins;
  progress.totals.perfectWins = perfectWins;
  progress.legacy = { wins, perfectWins };
  return progress;
}
