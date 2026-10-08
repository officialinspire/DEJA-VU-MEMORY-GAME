// DEJA VU achievements: the catalog of exactly 100.
//
// Pure data, no DOM or storage. Every time and score threshold is derived
// here from runtime-config.js's own board table and scoring, so it follows
// the boards actually dealt:
//  - speed goals give each board a time budget per pair, and count only wins
//    with at most a third as many mistakes as the board has pairs, so mashing
//    cards quickly never qualifies;
//  - score goals are the score of a stated reference game, worked out with
//    the game's own calculateScore, and ratings use its performance bands.
// Times are gameplay seconds: the memorize preview and pauses never count.
//
// IDs are permanent. An unlock is stored under its id, so an id is never
// renamed or reused, even if a name, requirement or threshold is reworded.

export const ACHIEVEMENT_CATEGORIES = Object.freeze([
  Object.freeze({ key: 'wins', label: 'Lifetime wins', count: 15 }),
  Object.freeze({ key: 'difficulty', label: 'Difficulty wins', count: 20 }),
  Object.freeze({ key: 'perfect', label: 'Perfect wins', count: 10 }),
  Object.freeze({ key: 'pairs', label: 'Matched pairs', count: 10 }),
  Object.freeze({ key: 'speed', label: 'Speed', count: 10 }),
  Object.freeze({ key: 'score', label: 'Score', count: 10 }),
  Object.freeze({ key: 'perfect-streak', label: 'Perfect streaks', count: 10 }),
  Object.freeze({ key: 'daily-streak', label: 'Daily streaks', count: 10 }),
  Object.freeze({ key: 'challenge', label: 'Challenges', count: 5 }),
]);

const BOARDS = Object.freeze(['easy', 'intermediate', 'advanced', 'insane']);

/** The most mistakes a win may have and still count toward a speed goal. */
export function speedMistakeLimit(pairs) {
  return Math.floor(pairs / 3);
}

// Gameplay seconds allowed per pair, by speed tier. Even the fastest leaves
// room for a mistake-limit's worth of mismatches at a human clicking pace
// (scripts/verify-achievements.mjs checks this against the game's timings).
const SPEED_TIERS = Object.freeze([
  Object.freeze({ tier: 1, secondsPerPair: 5, boards: BOARDS }),
  Object.freeze({ tier: 2, secondsPerPair: 3.5, boards: BOARDS }),
  Object.freeze({ tier: 3, secondsPerPair: 2.5, boards: Object.freeze(['advanced', 'insane']) }),
]);

const WIN_MILESTONES = [
  [1, 'First Flicker'],
  [3, 'Familiar Feeling'],
  [5, "Haven't We Met?"],
  [10, 'Echo Chamber'],
  [20, 'Recurring Dream'],
  [30, 'Loop Walker'],
  [50, 'Memory Lane Regular'],
  [75, 'Glitch in the Loop'],
  [100, 'Centennial Recall'],
  [150, 'Time-Loop Tenant'],
  [200, 'Old Friend of the Grid'],
  [300, 'Eternal Return'],
  [500, 'Living Echo'],
  [750, 'Endless Encore'],
  [1000, 'The Thousandth Deja Vu'],
];

const DIFFICULTY_MILESTONES = [1, 5, 10, 25, 50];
const DIFFICULTY_NAMES = {
  easy: ['Small Room, Clear View', 'Easy Street Echo', 'Warm-Up Ritual', 'Comfort Zone Cartographer', 'Master of the Small Hours'],
  intermediate: ['Into the Middle Distance', 'Steady Echo', 'Familiar Corridors', 'Corridor Keeper', 'Echo Architect'],
  advanced: ['Through the Looking Grid', 'Mirror Hall Regular', 'Hall of Mirrors', 'Mirror Mason', 'Reflection Sovereign'],
  insane: ['Into the Vortex', 'Vortex Veteran', 'Storm of Familiar Faces', 'Eye of the Storm', 'Insanity Is Repetition'],
};

const PERFECT_MILESTONES = [
  [1, 'Flawless Recollection'],
  [2, 'Not a Single Slip'],
  [3, 'Clean Slate Trilogy'],
  [5, 'Crystal Recall'],
  [10, 'Picture-Perfect Ten'],
  [20, 'Seamless Memory'],
  [35, 'Untouched by Doubt'],
  [50, 'Golden Recollection'],
  [75, 'Immaculate Archive'],
  [100, 'A Hundred Flawless Faces'],
];

const PAIR_MILESTONES = [
  [25, 'Pair Spotter'],
  [50, 'Twin Finder'],
  [100, 'Hundred Reunions'],
  [250, 'Matchmaker of Memories'],
  [500, 'Doubles Detective'],
  [1000, 'Thousand Twins'],
  [2000, 'Mirror Image Collector'],
  [3500, 'Doppelganger Hunter'],
  [5000, 'Constellation of Pairs'],
  [10000, 'Ten Thousand Reflections'],
];

const SPEED_NAMES = {
  easy: ['Quick Glance', 'Blink and Remember'],
  intermediate: ['Brisk Recollection', 'Snap Judgment'],
  advanced: ['Mirror Sprint', 'Fast Forward', 'Flash of Recognition'],
  insane: ['Storm Chaser', 'Lightning Loop', 'Faster Than Deja Vu'],
};

const EXCELLENT_NAMES = {
  easy: 'Bright Echo',
  intermediate: 'Clear Echo',
  advanced: 'True Reflection',
  insane: 'Calm in the Storm',
};

// Single-game score goals: the score of these games, by the game's scoring.
const SCORE_REFERENCES = [
  { id: 'score-1', name: 'Vivid Memory', difficulty: 'easy', mistakes: 2, seconds: 60 },
  { id: 'score-2', name: 'Total Clarity', difficulty: 'insane', mistakes: 10, seconds: 300 },
  { id: 'score-3', name: 'Crystal Vision', difficulty: 'insane', mistakes: 0, seconds: 200 },
];
const NEAR_PERFECT_PERCENT = 95;
const EARNED_MILESTONES = [
  { id: 'earned-1', name: 'Memory Bank', threshold: 100000 },
  { id: 'earned-2', name: 'Vault of Memories', threshold: 500000 },
];

const PERFECT_STREAK_MILESTONES = [
  [2, 'Double Take'],
  [3, 'Third Time, Same Again'],
  [4, 'Four-Leaf Recall'],
  [5, 'Unbroken Five'],
  [6, 'Sixth Sense'],
  [8, 'Infinite Eight'],
  [10, 'Perfect Loop'],
  [15, 'Spotless Spiral'],
  [20, 'Twenty-Twenty Recall'],
  [25, 'The Loop That Never Breaks'],
];

const DAILY_STREAK_MILESTONES = [
  [2, 'Same Time Tomorrow'],
  [3, 'Yesterday, Again'],
  [5, 'Five-Day Familiar'],
  [7, 'A Week of Deja Vu'],
  [10, 'Ten Mornings, One Feeling'],
  [14, 'Fortnight Flashback'],
  [21, 'Habit of Memory'],
  [30, 'A Month on Repeat'],
  [50, 'Fifty Days Familiar'],
  [100, 'Hundred-Day Loop'],
];

// A chain longer than every board but the largest can hold.
const LONG_CHAIN = 12;
// Lightning Recall's budget: a perfect Advanced board at this pace.
const LIGHTNING_SECONDS_PER_PAIR = 3;

const grouped = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const games = (count) => (count === 1 ? 'a game' : `${grouped(count)} games`);
const article = (word) => (/^[AEIOU]/.test(word) ? 'an' : 'a');

function entry(fields) {
  return Object.freeze({ difficulty: null, comparison: 'atLeast', ...fields });
}

/**
 * The 100 achievements for this runtime's boards and scoring, in display
 * order. Each: { id, name, requirement, category, metric, difficulty,
 * comparison ('atLeast' | 'atMost'), threshold, unit }, plus `mistakeLimit`
 * on speed goals and `reference` on the score goals derived from one.
 */
export function buildAchievementCatalog(runtime) {
  const { difficulties, performanceBands, calculateScore } = runtime;
  const label = (key) => difficulties[key].label;
  const list = [];

  for (const [threshold, name] of WIN_MILESTONES) {
    list.push(entry({
      id: `wins-${threshold}`, name, category: 'wins', metric: 'wins', threshold, unit: 'games',
      requirement: `Win ${games(threshold)}.`,
    }));
  }

  for (const key of BOARDS) {
    DIFFICULTY_MILESTONES.forEach((threshold, index) => {
      list.push(entry({
        id: `${key}-wins-${threshold}`, name: DIFFICULTY_NAMES[key][index], category: 'difficulty',
        metric: 'wins', difficulty: key, threshold, unit: 'games',
        requirement: threshold === 1
          ? `Win ${article(label(key))} ${label(key)} game.`
          : `Win ${grouped(threshold)} ${label(key)} games.`,
      }));
    });
  }

  for (const [threshold, name] of PERFECT_MILESTONES) {
    list.push(entry({
      id: `perfect-${threshold}`, name, category: 'perfect', metric: 'perfectWins', threshold, unit: 'games',
      requirement: `Win ${games(threshold)} without a mistake.`,
    }));
  }

  for (const [threshold, name] of PAIR_MILESTONES) {
    list.push(entry({
      id: `pairs-${threshold}`, name, category: 'pairs', metric: 'matchedPairs', threshold, unit: 'pairs',
      requirement: `Match ${grouped(threshold)} pairs in games you win.`,
    }));
  }

  for (const key of BOARDS) {
    const { pairs } = difficulties[key];
    const mistakeLimit = speedMistakeLimit(pairs);
    SPEED_TIERS.filter((tier) => tier.boards.includes(key)).forEach((tier, index) => {
      const threshold = Math.floor(pairs * tier.secondsPerPair);
      list.push(entry({
        id: `speed-${key}-${tier.tier}`, name: SPEED_NAMES[key][index], category: 'speed',
        metric: 'fastestSharpWin', difficulty: key, comparison: 'atMost', threshold, unit: 'seconds', mistakeLimit,
        requirement: `Win ${article(label(key))} ${label(key)} game in ${threshold} seconds or less with no more than ${mistakeLimit} mistake${mistakeLimit === 1 ? '' : 's'}.`,
      }));
    });
  }

  const excellent = performanceBands.find((band) => band.rating === 'EXCELLENT').minimum;
  for (const key of BOARDS) {
    list.push(entry({
      id: `excellent-${key}`, name: EXCELLENT_NAMES[key], category: 'score',
      metric: 'topPerformance', difficulty: key, threshold: excellent, unit: 'percent',
      requirement: `Earn an EXCELLENT rating (${excellent}% or more) on ${article(label(key))} ${label(key)} game.`,
    }));
  }
  list.push(entry({
    id: 'performance-95', name: 'Near-Perfect Premonition', category: 'score',
    metric: 'topPerformance', threshold: NEAR_PERFECT_PERCENT, unit: 'percent',
    requirement: `Earn a performance of ${NEAR_PERFECT_PERCENT}% or more in one game.`,
  }));
  for (const { id, name, ...reference } of SCORE_REFERENCES) {
    const threshold = calculateScore(reference.difficulty, reference.mistakes, reference.seconds);
    list.push(entry({
      id, name, category: 'score', metric: 'topScore', threshold, unit: 'points', reference: Object.freeze(reference),
      requirement: `Score ${grouped(threshold)} points or more in one game.`,
    }));
  }
  for (const { id, name, threshold } of EARNED_MILESTONES) {
    list.push(entry({
      id, name, category: 'score', metric: 'earnedScore', threshold, unit: 'points',
      requirement: `Earn ${grouped(threshold)} points in total across the games you win.`,
    }));
  }

  for (const [threshold, name] of PERFECT_STREAK_MILESTONES) {
    list.push(entry({
      id: `perfect-streak-${threshold}`, name, category: 'perfect-streak', metric: 'bestPerfectStreak', threshold, unit: 'games',
      requirement: `Win ${threshold} games in a row without a mistake.`,
    }));
  }

  for (const [threshold, name] of DAILY_STREAK_MILESTONES) {
    list.push(entry({
      id: `daily-streak-${threshold}`, name, category: 'daily-streak', metric: 'bestDailyStreak', threshold, unit: 'days',
      requirement: `Win at least one game on ${threshold} days in a row.`,
    }));
  }

  list.push(entry({
    id: 'flawless-insanity', name: 'Flawless Insanity', category: 'challenge',
    metric: 'fewestMistakes', difficulty: 'insane', comparison: 'atMost', threshold: 0, unit: 'mistakes',
    requirement: `Win ${article(label('insane'))} ${label('insane')} game without a mistake.`,
  }));
  list.push(entry({
    id: 'unbroken-thread', name: 'Unbroken Thread', category: 'challenge',
    metric: 'bestMatchChain', threshold: LONG_CHAIN, unit: 'matches',
    requirement: `Match ${LONG_CHAIN} pairs in a row, with no mistake between them, in a game you win.`,
  }));
  list.push(entry({
    id: 'perfect-prism', name: 'Perfect Prism', category: 'challenge',
    metric: 'perfectDifficulties', threshold: BOARDS.length, unit: 'difficulties',
    requirement: 'Win a game without a mistake on every difficulty.',
  }));
  list.push(entry({
    id: 'four-rooms-one-day', name: 'Four Rooms, One Day', category: 'challenge',
    metric: 'difficultiesInOneDay', threshold: BOARDS.length, unit: 'difficulties',
    requirement: 'Win a game on every difficulty on the same day.',
  }));
  const lightning = Math.floor(difficulties.advanced.pairs * LIGHTNING_SECONDS_PER_PAIR);
  list.push(entry({
    id: 'lightning-recall', name: 'Lightning Recall', category: 'challenge',
    metric: 'fastestPerfectWin', difficulty: 'advanced', comparison: 'atMost', threshold: lightning, unit: 'seconds',
    requirement: `Win ${article(label('advanced'))} ${label('advanced')} game without a mistake in ${lightning} seconds or less.`,
  }));

  return Object.freeze(list);
}
