// DEJA VU saved-game integrity guard.
// Runs before index.js so malformed or incompatible saves never reach gameplay.
(function validateSavedGameAtStartup() {
  const GAME_KEY = 'inspireDejaVu:v1:activeGame';
  const SAVE_VERSION = 1;
  const MAX_PATTERN_INDEX = 16;
  const DIFFICULTIES = Object.freeze({
    easy: Object.freeze({ pairs: 6 }),
    intermediate: Object.freeze({ pairs: 8 }),
    advanced: Object.freeze({ pairs: 10 }),
    insane: Object.freeze({ pairs: 15 }),
  });

  function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }

  function isValidCard(card) {
    return Boolean(
      card &&
      typeof card === 'object' &&
      typeof card.uid === 'string' &&
      card.uid.length > 0 &&
      Number.isInteger(card.pattern) &&
      card.pattern >= 0 &&
      card.pattern <= MAX_PATTERN_INDEX &&
      typeof card.matched === 'boolean'
    );
  }

  function isStableTransientState(saved) {
    const openIsStable = !('open' in saved) || (Array.isArray(saved.open) && saved.open.length === 0);
    const pausedIsStable = !('paused' in saved) || saved.paused === false;
    const lockedIsStable = !('locked' in saved) || saved.locked === false;
    const turnIsStable = !('turn' in saved) || saved.turn === 'idle';
    const completedIsStable = !('completed' in saved) || saved.completed === false;
    const sessionIsStable = !('sessionId' in saved) || saved.sessionId === '';
    const turnIdIsStable = !('turnId' in saved) || saved.turnId === 0;
    return openIsStable && pausedIsStable && lockedIsStable && turnIsStable && completedIsStable && sessionIsStable && turnIdIsStable;
  }

  function validateSavedGame(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
    if (saved.version !== SAVE_VERSION || saved.active !== true) return false;

    const difficulty = DIFFICULTIES[saved.difficulty];
    if (!difficulty || !Array.isArray(saved.deck)) return false;
    if (saved.deck.length !== difficulty.pairs * 2) return false;
    if (!saved.deck.every(isValidCard)) return false;
    if (!isStableTransientState(saved)) return false;

    if (!isNonNegativeInteger(saved.moves) || !isNonNegativeInteger(saved.mistakes) || !isNonNegativeInteger(saved.elapsed)) return false;
    if (!isNonNegativeInteger(saved.matchedPairs) || saved.matchedPairs > difficulty.pairs) return false;
    if (saved.mistakes > saved.moves) return false;

    const uidSet = new Set(saved.deck.map((card) => card.uid));
    if (uidSet.size !== saved.deck.length) return false;

    const groups = new Map();
    for (const card of saved.deck) {
      const group = groups.get(card.pattern) || [];
      group.push(card);
      groups.set(card.pattern, group);
    }

    if (groups.size !== difficulty.pairs) return false;

    let matchedPairs = 0;
    for (const pair of groups.values()) {
      if (pair.length !== 2) return false;
      if (pair[0].matched !== pair[1].matched) return false;
      if (pair[0].matched) matchedPairs += 1;
    }

    return matchedPairs === saved.matchedPairs;
  }

  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (raw === null) return;
    const saved = JSON.parse(raw);
    if (!validateSavedGame(saved)) {
      localStorage.removeItem(GAME_KEY);
      console.warn('DEJA VU removed an invalid or incompatible saved game.');
    }
  } catch (_) {
    try {
      localStorage.removeItem(GAME_KEY);
    } catch (_) {}
  }
})();
