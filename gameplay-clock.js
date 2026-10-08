// DEJA VU gameplay time.
//
// Turn resolution, the memorize preview and the score clock all measure the
// same thing: time in which a player can actually play. This one clock owns
// it. While anything suspends play (the pause dialog, the page being hidden)
// every pending gameplay timer is frozen with its remaining time and the score
// clock stops; when the last suspension lifts they carry on where they were.
// Frozen work holds no native timer, so nothing runs in the background.
//
// The score clock is accumulated from timestamps rather than counted in
// interval ticks, so it neither drifts nor loses the part-second either side
// of a pause. It also skips excluded spans, such as the memorize preview.

export function createGameplayClock({
  now = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (id) => window.clearTimeout(id),
} = {}) {
  const suspensions = new Set();
  const exclusions = new Set();
  const tasks = new Set();

  // Gameplay time: advances only while nothing suspends play.
  let activeTotal = 0;
  let activeSince = now();

  // Score clock: gameplay time while a game is being played and nothing is
  // excluded.
  let counting = false;
  let scoreTotal = 0;
  let scoreSince = null;
  let secondTimer = 0;
  let lastSecond = 0;
  const secondListeners = new Set();

  const running = () => suspensions.size === 0;
  const gameplayNow = () => activeTotal + (activeSince === null ? 0 : now() - activeSince);
  const scoreMs = () => scoreTotal + (scoreSince === null ? 0 : now() - scoreSince);

  function arm(task) {
    task.timer = setTimer(() => {
      task.timer = 0;
      tasks.delete(task);
      task.callback();
    }, Math.max(0, task.due - gameplayNow()));
  }

  function disarm(task) {
    if (!task.timer) return;
    clearTimer(task.timer);
    task.timer = 0;
  }

  // Every whole second passed is reported once, in order, even when a timer
  // fires late or the clock stops right on a boundary.
  function reportSeconds() {
    const second = Math.floor(scoreMs() / 1000);
    while (lastSecond < second) {
      lastSecond += 1;
      secondListeners.forEach((listener) => listener(lastSecond));
    }
  }

  function armSecond() {
    clearTimer(secondTimer);
    // Wake just after the next whole second of score time, never on a fixed
    // beat, so the shown time is always floor(elapsed).
    secondTimer = setTimer(() => {
      secondTimer = 0;
      if (scoreSince === null) return;
      reportSeconds();
      armSecond();
    }, 1000 - (scoreMs() % 1000) + 1);
  }

  function syncScoreClock() {
    const shouldRun = counting && running() && exclusions.size === 0;
    if (shouldRun && scoreSince === null) {
      scoreSince = now();
      armSecond();
    } else if (!shouldRun && scoreSince !== null) {
      scoreTotal += now() - scoreSince;
      scoreSince = null;
      clearTimer(secondTimer);
      secondTimer = 0;
      reportSeconds();
    }
  }

  return {
    /**
     * Runs `callback` after `delay` ms of gameplay time. Returns a function
     * that cancels it.
     */
    schedule(callback, delay) {
      const task = { callback, due: gameplayNow() + Math.max(0, Number(delay) || 0), timer: 0 };
      tasks.add(task);
      if (running()) arm(task);
      return () => {
        disarm(task);
        tasks.delete(task);
      };
    },

    /** Cancels every pending gameplay timer. */
    cancelAll() {
      tasks.forEach(disarm);
      tasks.clear();
    },

    /** Gameplay time in ms: frozen while play is suspended. */
    now: gameplayNow,

    /** Freezes gameplay for `reason` until resume(reason). */
    suspend(reason) {
      if (suspensions.has(reason)) return;
      const wasRunning = running();
      suspensions.add(reason);
      if (wasRunning) {
        activeTotal = gameplayNow();
        activeSince = null;
        tasks.forEach(disarm);
      }
      syncScoreClock();
    },

    resume(reason) {
      if (!suspensions.delete(reason)) return;
      if (running()) {
        activeSince = now();
        tasks.forEach((task) => {
          if (!task.timer) arm(task);
        });
      }
      syncScoreClock();
    },

    isSuspended: () => !running(),
    pendingTasks: () => tasks.size,

    /** Whether a game is being played; the score clock runs only then. */
    setCounting(value) {
      counting = Boolean(value);
      syncScoreClock();
    },

    /** Keeps `reason` (e.g. the memorize preview) out of the score clock. */
    exclude(reason) {
      exclusions.add(reason);
      syncScoreClock();
    },

    include(reason) {
      exclusions.delete(reason);
      syncScoreClock();
    },

    /** Score time in ms. */
    elapsedMs: scoreMs,

    resetElapsed(ms = 0) {
      scoreTotal = Math.max(0, Number(ms) || 0);
      if (scoreSince !== null) scoreSince = now();
      lastSecond = Math.floor(scoreTotal / 1000);
      if (scoreSince !== null) armSecond();
    },

    /** Calls `listener(seconds)` each time the score clock passes a whole second. */
    onSecond(listener) {
      secondListeners.add(listener);
      return () => secondListeners.delete(listener);
    },
  };
}

export const gameplayClock = createGameplayClock();
