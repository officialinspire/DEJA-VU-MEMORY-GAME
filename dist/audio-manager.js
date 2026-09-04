const MUSIC_SCENES = Object.freeze({
  silent: 'silent',
  menu: 'menu',
  gameplay: 'gameplay',
});

const TRACK_SOURCES = Object.freeze({
  menu: new URL('./Deja Vu - Main Menu (Vibe 1).mp3', import.meta.url).href,
  gameplay: new URL('./Minimalist Electronic Focus Theme.mp3', import.meta.url).href,
});

const tracks = Object.fromEntries(Object.entries(TRACK_SOURCES).map(([name, source]) => {
  const audio = new Audio(source);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 0;
  return [name, audio];
}));

let enabled = true;
let masterVolume = 0.22;
let requestedScene = MUSIC_SCENES.silent;
let requestedScale = 1;
let fadeFrame = 0;
let transitionRevision = 0;
let unlocked = false;
let unlockPromise = null;
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

function ensurePlaying(name, revision) {
  const audio = tracks[name];
  if (!audio?.paused) return Promise.resolve();
  if (pendingPlay.has(name)) return pendingPlay.get(name);

  let playResult;
  try {
    playResult = audio.play();
  } catch (_) {
    playResult = Promise.reject();
  }

  const playback = Promise.resolve(playResult)
    .catch(() => {})
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

export function unlockMusic() {
  if (unlocked || unlockPromise) return unlockPromise || Promise.resolve(true);

  const attempts = Object.entries(tracks).map(([name, audio]) => {
    let playback;
    try {
      playback = audio.play();
    } catch (_) {
      playback = Promise.reject();
    }

    return Promise.resolve(playback)
      .then(() => true, () => false)
      .finally(() => {
        if (!shouldBePlaying(name)) audio.pause();
      });
  });

  unlockPromise = Promise.all(attempts)
    .then((results) => {
      unlocked = results.some(Boolean);
      return unlocked;
    })
    .finally(() => {
      unlockPromise = null;
    });
  return unlockPromise;
}

export function getMusicState() {
  return {
    scene: requestedScene,
    enabled,
    masterVolume,
    volumeScale: requestedScale,
    unlocked,
    transitioning: Boolean(fadeFrame),
    tracks: Object.fromEntries(Object.entries(tracks).map(([name, audio]) => [name, {
      paused: audio.paused,
      volume: audio.volume,
      source: audio.currentSrc || audio.src,
    }])),
  };
}

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
