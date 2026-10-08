// DEJA VU progress tracking: records what core gameplay reports, durably.
//
// Listens only to the authoritative events index.js emits (completion, a run
// abandoned by a new game, statistics reset); it never looks at the board.
// The rules live in progress-evaluator.js and achievement-evaluator.js; this
// module only reads and writes the record. A completion and the achievements
// it unlocks are saved in one write.
//
// Storage is treated as unreliable:
//  - every update re-reads the stored record first, so another tab's progress
//    is built on rather than overwritten;
//  - a record that is not a record at all is copied to a ":corrupt" key before
//    being replaced, so nothing is destroyed silently;
//  - a record written by a newer build is never overwritten: this tab keeps
//    its progress in memory only;
//  - storage that cannot be read or written (private modes, quota, a denied
//    permission) leaves tracking working in memory for the session.

import {
  PROGRESS_KEY,
  createEmptyProgress,
  readProgress,
  seedFromLegacyStatistics,
} from './progress-model.js';
import { recordAbandonment, resetProgress } from './progress-evaluator.js';
import { buildAchievementCatalog } from './achievement-catalog.js';
import { backfillAchievements, describeAchievements, recordCompletionAndAward } from './achievement-evaluator.js';

const STATS_KEY = 'inspireDejaVu:v1:statistics';
const CORRUPT_KEY = `${PROGRESS_KEY}:corrupt`;

const runtime = () => window.DEJA_VU_RUNTIME;
let catalog = null;
function achievementCatalog() {
  if (!catalog && runtime()) catalog = buildAchievementCatalog(runtime());
  return catalog || [];
}

let memory = null;
// Set when this tab holds progress the store refused to save (a full quota):
// it is ahead of what a read would return until a write succeeds again.
let unsaved = false;
let status = { persistent: true, source: 'unknown' };

function store() {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

function readItem(key) {
  const storage = store();
  if (!storage) return { available: false, value: null };
  try {
    return { available: true, value: storage.getItem(key) };
  } catch (_) {
    return { available: false, value: null };
  }
}

function writeItem(key, value) {
  const storage = store();
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function legacyStatistics() {
  const { value } = readItem(STATS_KEY);
  try {
    return JSON.parse(value || 'null');
  } catch (_) {
    return null;
  }
}

// A record created now, or carried over from version 1, is credited with
// every achievement earlier play proves. Runs once: the result is saved.
function backfill(progress, statistics) {
  if (!runtime()) return progress;
  return backfillAchievements(progress, statistics, achievementCatalog(), runtime(), Date.now()).progress;
}

function legacySeed() {
  const statistics = legacyStatistics();
  return backfill(seedFromLegacyStatistics(statistics), statistics);
}

/** The record to build on now, and whether it may be written back. */
function load() {
  if (unsaved && memory) return { progress: memory, writable: true, source: 'unsaved' };
  const { available, value } = readItem(PROGRESS_KEY);
  if (!available) return { progress: memory || legacySeed(), writable: false, source: 'storage unavailable' };
  const read = readProgress(value);
  if (read.status === 'newer') return { progress: memory || createEmptyProgress(), writable: false, source: 'newer record' };
  if (read.status === 'migrated') return { progress: backfill(read.progress, legacyStatistics()), writable: true, source: 'migrated' };
  if (read.progress) return { progress: read.progress, writable: true, source: read.status };
  if (read.status === 'corrupt') writeItem(CORRUPT_KEY, value);
  return { progress: memory || legacySeed(), writable: true, source: read.status };
}

function save(progress, writable) {
  memory = progress;
  const persisted = writable && writeItem(PROGRESS_KEY, JSON.stringify(progress));
  unsaved = writable && !persisted;
  status = { persistent: persisted, source: status.source };
  return persisted;
}

function update(operation, cause) {
  const loaded = load();
  status = { persistent: loaded.writable, source: loaded.source };
  const result = operation(loaded.progress);
  const unlocked = result.unlocked || [];
  if (result.recorded) {
    save(result.progress, loaded.writable);
    window.dispatchEvent(new CustomEvent('deja-vu:progress-updated', {
      detail: { cause, reason: result.reason, persistent: status.persistent, unlocked },
    }));
    if (unlocked.length) {
      const achievements = describeAchievements(result.progress, achievementCatalog(), runtime())
        .filter((achievement) => unlocked.includes(achievement.id));
      window.dispatchEvent(new CustomEvent('deja-vu:achievements-unlocked', {
        detail: { cause, runId: result.runId, persistent: status.persistent, achievements },
      }));
    }
  } else if (['repaired', 'empty', 'corrupt', 'migrated'].includes(loaded.source)) {
    save(loaded.progress, loaded.writable);
  }
  return result;
}

/** A copy of the current record, for presentation. */
export function getProgress() {
  return JSON.parse(JSON.stringify(load().progress));
}

/** Whether progress is being saved, and what the last read found. */
export function getProgressStatus() {
  return { ...status };
}

/**
 * All 100 achievements, in catalog order, each with its requirement,
 * threshold, current progress and unlock time (see describeAchievements).
 */
export function getAchievements() {
  if (!runtime()) return [];
  return describeAchievements(load().progress, achievementCatalog(), runtime());
}

window.addEventListener('deja-vu:completion', (event) => {
  update((progress) => recordCompletionAndAward(progress, event.detail, achievementCatalog(), runtime(), Date.now()), 'completion');
});

window.addEventListener('deja-vu:run-abandoned', (event) => {
  update((progress) => recordAbandonment(progress, event.detail), 'abandonment');
});

window.addEventListener('deja-vu:statistics-reset', (event) => {
  update((progress) => resetProgress(progress, event.detail?.at ?? Date.now()), 'reset');
});

// Settle the record now, before any game: a first run seeds it, and backfills
// achievements, from the legacy statistics while those still describe only
// earlier games (index.js counts a win in them before announcing it); a
// version-1 record is carried over and backfilled; a damaged one is repaired.
update(() => ({ recorded: false }), 'load');
