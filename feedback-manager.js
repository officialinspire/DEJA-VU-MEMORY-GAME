const HAPTIC_PATTERNS = Object.freeze({
  select: 11,
  match: Object.freeze([15, 25, 20]),
  mistake: Object.freeze([24, 35, 24]),
});

const CUES = Object.freeze({
  tap: Object.freeze([
    Object.freeze({ frequency: 320, duration: 0.045, type: 'triangle', level: 0.035 }),
  ]),
  select: Object.freeze([
    Object.freeze({ frequency: 540, duration: 0.04, type: 'sine', level: 0.05 }),
  ]),
  start: Object.freeze([
    Object.freeze({ frequency: 330, duration: 0.075, type: 'triangle', level: 0.05 }),
    Object.freeze({ frequency: 495, duration: 0.1, delay: 0.06, type: 'triangle', level: 0.055 }),
  ]),
  match: Object.freeze([
    Object.freeze({ frequency: 610, duration: 0.1, type: 'sine', level: 0.055 }),
    Object.freeze({ frequency: 790, duration: 0.15, delay: 0.075, type: 'sine', level: 0.06 }),
  ]),
  mistake: Object.freeze([
    Object.freeze({ frequency: 155, endFrequency: 112, duration: 0.16, delay: 0.045, type: 'triangle', level: 0.06, filterFrequency: 430 }),
  ]),
  complete: Object.freeze([
    Object.freeze({ frequency: 440, duration: 0.12, type: 'triangle', level: 0.045 }),
    Object.freeze({ frequency: 660, duration: 0.14, delay: 0.1, type: 'triangle', level: 0.05 }),
    Object.freeze({ frequency: 880, duration: 0.2, delay: 0.2, type: 'sine', level: 0.05 }),
  ]),
});

let audioContext = null;
let sfxEnabled = true;
let sfxVolume = 0.35;
let hapticsEnabled = true;

function clamp(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioContext = new AudioContextClass();
  }
  return audioContext;
}

function playTone({
  frequency,
  endFrequency = frequency,
  duration,
  delay = 0,
  type = 'sine',
  level = 0.05,
  filterFrequency = 0,
}) {
  const context = ensureAudioContext();
  if (!sfxEnabled || !context) return;

  const start = context.currentTime + delay;
  const finish = start + duration;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency !== frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, finish);
  }

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, sfxVolume * level), start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, finish);

  if (filterFrequency && context.createBiquadFilter) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFrequency, start);
    oscillator.connect(filter);
    filter.connect(gain);
  } else {
    oscillator.connect(gain);
  }
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(finish + 0.02);
}

function vibrate(pattern) {
  if (!hapticsEnabled || pattern === undefined) return false;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try {
    return Boolean(navigator.vibrate(pattern));
  } catch (_) {
    return false;
  }
}

export function configureFeedback({
  soundEnabled,
  soundVolume,
  vibrationEnabled,
}) {
  sfxEnabled = Boolean(soundEnabled);
  sfxVolume = clamp(soundVolume);
  hapticsEnabled = Boolean(vibrationEnabled);
}

export function unlockFeedback() {
  const context = ensureAudioContext();
  try {
    context?.resume?.().catch?.(() => {});
  } catch (_) {}
}

export function playFeedback(name) {
  const tones = CUES[name];
  if (!tones) return false;

  if (sfxEnabled) {
    unlockFeedback();
    tones.forEach(playTone);
  }
  const hapticPlayed = vibrate(HAPTIC_PATTERNS[name]);
  return sfxEnabled || hapticPlayed;
}

export function getFeedbackState() {
  return {
    sfxEnabled,
    sfxVolume,
    hapticsEnabled,
    hapticsSupported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
  };
}
