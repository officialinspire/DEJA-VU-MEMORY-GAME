const MUSIC_SCENES = Object.freeze({
  silent: 'silent',
  menu: 'menu',
  gameplay: 'gameplay',
});

const TRACK_SOURCES = Object.freeze({
  menu: new URL('./Deja Vu - Main Menu (Vibe 1).mp3', import.meta.url).href,
  gameplay: new URL('./Minimalist Electronic Focus Theme.mp3', import.meta.url).href,
});

// Nothing is downloaded until warmMusic() or the first gesture's unlock: the
// card art goes first on a cold connection. play() inside the gesture loads a
// preload="none" track just as well, so the unlock is unaffected.
const tracks = Object.fromEntries(Object.entries(TRACK_SOURCES).map(([name, source]) => {
  const audio = new Audio(source);
  audio.loop = true;
  audio.preload = 'none';
  audio.volume = 0;
  return [name, audio];
}));

// Each element is unlocked on its own: mobile browsers allow play() per
// element, once a gesture has let it start. A play() refused for want of a
// gesture is retried inside the next real one. Transient failures (a dropped
// connection, a decode error) are retried a few times with backoff, and get a
// fresh budget on the next gesture or when the network comes back.
const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 1000;
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'];
const trackState = Object.fromEntries(Object.keys(tracks).map((name) => [name, {
  unlocked: false,
  needsGesture: false,
  failures: 0,
  retryTimer: 0,
}]));

let enabled = true;
let masterVolume = 0.22;
let requestedScene = MUSIC_SCENES.silent;
let requestedScale = 1;
let fadeFrame = 0;
let transitionRevision = 0;
let unlockPromise = null;
let gestureRetryArmed = false;
const pendingPlay = new Map();

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function targetVolume(name) {
  if (!enabled || document.hidden || requestedScene === MUSIC_SCENES.silent) return 0;
  return name === requestedScene ? clamp(masterVolume * requestedScale) : 0;
}

function shouldBePlaying(name) {
  return targetVolume(name) > 0;
}

function pauseSilentTracks() {
  Object.entries(tracks).forEach(([name, audio]) => {
    if (shouldBePlaying(name)) return;
    audio.volume = 0;
    audio.pause();
  });
}

function startPlayback(audio) {
  try {
    return Promise.resolve(audio.play());
  } catch (error) {
    return Promise.reject(error);
  }
}

function markPlayable(name) {
  const state = trackState[name];
  state.unlocked = true;
  state.needsGesture = false;
  state.failures = 0;
}

function playbackFailed(name, error) {
  // Our own pause() or load() interrupted it: not a failure.
  if (error?.name === 'AbortError') return;
  if (error?.name === 'NotAllowedError') {
    trackState[name].needsGesture = true;
    armGestureRetry();
    return;
  }
  scheduleRetry(name);
}

function scheduleRetry(name) {
  const state = trackState[name];
  if (state.retryTimer || state.failures >= RETRY_LIMIT) return;
  state.failures += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = 0;
    retryTrack(name);
  }, RETRY_BASE_MS * 2 ** (state.failures - 1));
}

function retryTrack(name) {
  const audio = tracks[name];
  // A failed resource has to be fetched again before it can play.
  if (audio.error && audio.paused) audio.load();
  // Never while hidden or unwanted: the next scene change asks again.
  if (shouldBePlaying(name)) ensurePlaying(name, transitionRevision);
}

function freshRetryBudget() {
  Object.values(trackState).forEach((state) => {
    state.failures = 0;
  });
}

function armGestureRetry() {
  if (gestureRetryArmed) return;
  gestureRetryArmed = true;
  GESTURE_EVENTS.forEach((type) => document.addEventListener(type, retryOnGesture, true));
}

function disarmGestureRetry() {
  gestureRetryArmed = false;
  GESTURE_EVENTS.forEach((type) => document.removeEventListener(type, retryOnGesture, true));
}

// Runs inside the gesture itself, the only place play() is allowed.
function retryOnGesture(event) {
  if (!event.isTrusted) return;
  freshRetryBudget();
  Object.entries(trackState).forEach(([name, state]) => {
    if (!state.needsGesture) return;
    state.needsGesture = false;
    if (shouldBePlaying(name)) ensurePlaying(name, transitionRevision);
    else unlockTrack(name);
  });
  // A play() refused again re-arms it.
  if (!Object.values(trackState).some((state) => state.needsGesture)) disarmGestureRetry();
}

function ensurePlaying(name, revision) {
  const audio = tracks[name];
  if (!audio?.paused) return Promise.resolve();
  if (pendingPlay.has(name)) return pendingPlay.get(name);

  const playback = startPlayback(audio)
    .then(() => markPlayable(name), (error) => playbackFailed(name, error))
    .finally(() => {
      if (pendingPlay.get(name) === playback) pendingPlay.delete(name);
      if (revision !== transitionRevision && !shouldBePlaying(name)) {
        audio.volume = 0;
        audio.pause();
      }
    });
  pendingPlay.set(name, playback);
  return playback;
}

function finishTransition(revision, targets) {
  if (revision !== transitionRevision) return;
  fadeFrame = 0;
  Object.entries(tracks).forEach(([name, audio]) => {
    audio.volume = targets[name];
  });
  pauseSilentTracks();
}

export function configureMusic({ musicEnabled, volume }) {
  enabled = Boolean(musicEnabled);
  masterVolume = clamp(volume);
}

export function transitionMusic(scene, { duration = 750, volumeScale = 1 } = {}) {
  if (!Object.values(MUSIC_SCENES).includes(scene)) {
    throw new Error(`Unknown music scene: ${scene}`);
  }

  requestedScene = scene;
  requestedScale = clamp(volumeScale);
  transitionRevision += 1;
  const revision = transitionRevision;
  cancelAnimationFrame(fadeFrame);
  fadeFrame = 0;

  const targets = Object.fromEntries(Object.keys(tracks).map((name) => [name, targetVolume(name)]));
  const starts = Object.fromEntries(Object.entries(tracks).map(([name, audio]) => [name, audio.volume]));

  Object.entries(targets).forEach(([name, target]) => {
    if (target > 0) ensurePlaying(name, revision);
  });

  if (duration <= 0) {
    finishTransition(revision, targets);
    return;
  }

  const startTime = performance.now();
  const fadeDuration = Math.max(1, Number(duration) || 750);
  const step = (now) => {
    if (revision !== transitionRevision) return;
    const progress = Math.min(1, (now - startTime) / fadeDuration);
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - ((-2 * progress + 2) ** 2) / 2;

    Object.entries(tracks).forEach(([name, audio]) => {
      audio.volume = clamp(starts[name] + (targets[name] - starts[name]) * eased);
    });

    if (progress < 1) fadeFrame = requestAnimationFrame(step);
    else finishTransition(revision, targets);
  };
  fadeFrame = requestAnimationFrame(step);
}

// play() then, unless the scene wants it, pause(): lets a later scene start
// this element outside a gesture.
function unlockTrack(name) {
  const audio = tracks[name];
  return startPlayback(audio)
    .then(() => {
      markPlayable(name);
      return true;
    }, (error) => {
      playbackFailed(name, error);
      return false;
    })
    .finally(() => {
      if (!shouldBePlaying(name)) audio.pause();
    });
}

/** Call inside the first gesture. Resolves true once every track is unlocked. */
export function unlockMusic() {
  if (unlockPromise) return unlockPromise;
  const locked = Object.keys(tracks).filter((name) => !trackState[name].unlocked);
  if (!locked.length) return Promise.resolve(true);

  unlockPromise = Promise.all(locked.map(unlockTrack))
    .then(() => Object.values(trackState).every((state) => state.unlocked))
    .finally(() => {
      unlockPromise = null;
    });
  return unlockPromise;
}

// Starts buffering both loops. A track the unlock already asked to play is
// loading anyway; load() on it would abort that play().
export function warmMusic() {
  Object.values(tracks).forEach((audio) => {
    if (audio.preload === 'auto') return;
    audio.preload = 'auto';
    if (audio.paused && !audio.readyState) audio.load();
  });
}

export function getMusicState() {
  return {
    scene: requestedScene,
    enabled,
    masterVolume,
    volumeScale: requestedScale,
    unlocked: Object.values(trackState).every((state) => state.unlocked),
    transitioning: Boolean(fadeFrame),
    tracks: Object.fromEntries(Object.entries(tracks).map(([name, audio]) => [name, {
      paused: audio.paused,
      volume: audio.volume,
      source: audio.currentSrc || audio.src,
      unlocked: trackState[name].unlocked,
      needsGesture: trackState[name].needsGesture,
      failures: trackState[name].failures,
    }])),
  };
}

// A network or decode error on the element itself (not just a refused play()).
Object.entries(tracks).forEach(([name, audio]) => {
  audio.addEventListener?.('error', () => scheduleRetry(name));
});

// Back online: whatever gave up gets another bounded try.
window.addEventListener?.('online', () => {
  freshRetryBudget();
  Object.keys(tracks).forEach(retryTrack);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    transitionRevision += 1;
    cancelAnimationFrame(fadeFrame);
    fadeFrame = 0;
    Object.values(tracks).forEach((audio) => {
      audio.volume = 0;
      audio.pause();
    });
    return;
  }
  transitionMusic(requestedScene, { duration: 250, volumeScale: requestedScale });
});

export { MUSIC_SCENES };
