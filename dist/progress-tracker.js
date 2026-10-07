// DEJA VU progress tracking: records what core gameplay reports, durably.
//
// Listens only to the authoritative events index.js emits (completion, a run
// abandoned by a new game, statistics reset); it never looks at the board.
// The rules live in progress-evaluator.js; this module only reads and writes
// the record.
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
import { recordAbandonment, recordCompletion, resetProgress } from './progress-evaluator.js';

const STATS_KEY = 'inspireDejaVu:v1:statistics';
const CORRUPT_KEY = `${PROGRESS_KEY}:corrupt`;

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

function legacySeed() {
  const { value } = readItem(STATS_KEY);
  try {
    return seedFromLegacyStatistics(JSON.parse(value || 'null'));
  } catch (_) {
    return createEmptyProgress();
  }
}

/** The record to build on now, and whether it may be written back. */
function load() {
  if (unsaved && memory) return { progress: memory, writable: true, source: 'unsaved' };
  const { available, value } = readItem(PROGRESS_KEY);
  if (!available) return { progress: memory || legacySeed(), writable: false, source: 'storage unavailable' };
  const read = readProgress(value);
  if (read.status === 'newer') return { progress: memory || createEmptyProgress(), writable: false, source: 'newer record' };
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
  if (result.recorded) {
    save(result.progress, loaded.writable);
    window.dispatchEvent(new CustomEvent('deja-vu:progress-updated', {
      detail: { cause, reason: result.reason, persistent: status.persistent },
    }));
  } else if (loaded.source === 'repaired' || loaded.source === 'empty' || loaded.source === 'corrupt') {
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

window.addEventListener('deja-vu:completion', (event) => {
  update((progress) => recordCompletion(progress, event.detail, window.DEJA_VU_RUNTIME), 'completion');
});

window.addEventListener('deja-vu:run-abandoned', (event) => {
  update((progress) => recordAbandonment(progress, event.detail), 'abandonment');
});

window.addEventListener('deja-vu:statistics-reset', (event) => {
  update((progress) => resetProgress(progress, event.detail?.at ?? Date.now()), 'reset');
});

// Settle the record now, before any game: a first run seeds it from the
// legacy statistics while those still describe only earlier games (index.js
// counts a win in them before announcing it), and a damaged one is repaired.
update(() => ({ recorded: false }), 'load');
