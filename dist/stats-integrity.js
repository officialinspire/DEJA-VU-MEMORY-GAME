// Prompt 9: statistics integrity and normalization.
// Runs before index.js and repairs malformed persisted statistics without
// affecting valid historical data.
(function normalizeDejaVuStatistics() {
  const STATS_KEY = 'inspireDejaVu:v1:statistics';
  const DIFFICULTIES = new Set(['easy', 'intermediate', 'advanced', 'insane']);

  function nonNegativeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function validBest(best) {
    if (!best || typeof best !== 'object' || Array.isArray(best)) return null;
    const time = nonNegativeInteger(best.time, -1);
    const mistakes = nonNegativeInteger(best.mistakes, -1);
    const score = nonNegativeInteger(best.score, -1);
    if (time < 0 || mistakes < 0 || score < 0) return null;
    return { time, mistakes, score };
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const played = nonNegativeInteger(source.played);
    const won = Math.min(nonNegativeInteger(source.won), played);
    const perfect = Math.min(nonNegativeInteger(source.perfect), won);
    const bestScore = nonNegativeInteger(source.bestScore);
    const bests = {};

    if (source.bests && typeof source.bests === 'object' && !Array.isArray(source.bests)) {
      for (const [difficulty, best] of Object.entries(source.bests)) {
        if (!DIFFICULTIES.has(difficulty)) continue;
        const normalizedBest = validBest(best);
        if (normalizedBest) bests[difficulty] = normalizedBest;
      }
    }

    const highestDifficultyScore = Object.values(bests).reduce((max, best) => Math.max(max, best.score), 0);
    return {
      played,
      won,
      perfect,
      bestScore: Math.max(bestScore, highestDifficultyScore),
      bests,
    };
  }

  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw === null) return;
    const normalized = normalize(JSON.parse(raw));
    localStorage.setItem(STATS_KEY, JSON.stringify(normalized));
  } catch (_) {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify({ played: 0, won: 0, perfect: 0, bestScore: 0, bests: {} }));
    } catch (_) {}
  }
})();