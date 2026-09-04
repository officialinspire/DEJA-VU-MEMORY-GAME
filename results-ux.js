// Completion/results and statistics presentation.
// This module never writes statistics. index.js remains the single authority for
// wins, perfect games, and best-metric persistence.

const STATS_KEY = 'inspireDejaVu:v1:statistics';
const completeDialog = document.querySelector('#complete-dialog');
const bestList = document.querySelector('#best-list');
const metricLabels = Object.freeze({
  mistakes: document.querySelector('#complete-mistakes-label'),
  time: document.querySelector('#complete-time-label'),
  score: document.querySelector('#complete-score-label'),
});

let lastRenderedResultSignature = '';

function installStatsSemantics() {
  const screen = document.querySelector('#screen-statistics');
  if (!screen) return;
  const heading = [...screen.querySelectorAll('h2')].find((node) => ['Personal Bests', 'Best Metrics'].includes(node.textContent.trim()));
  if (heading) heading.textContent = 'Best Metrics';
  if (!bestList || document.querySelector('#best-metrics-note')) return;
  const note = document.createElement('p');
  note.id = 'best-metrics-note';
  note.className = 'stats-note';
  note.textContent = 'Fastest time, fewest mistakes, and highest score are tracked independently for each difficulty.';
  bestList.before(note);
}

function readStats() {
  try {
    const value = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const remainder = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function setMetricLabel(element, label, isBest) {
  if (!element) return;
  element.textContent = label;
  if (!isBest) return;
  const badge = document.createElement('span');
  badge.className = 'new-best-badge';
  badge.textContent = 'NEW BEST';
  element.append(' ', badge);
}

function renderCompletionResult(event) {
  const result = event.detail;
  if (!result?.newBests) return;
  const signature = `${result.difficultyKey}|${result.score}|${result.performancePercent}|${result.rating}|${result.newBests.time}|${result.newBests.mistakes}|${result.newBests.score}`;
  if (signature === lastRenderedResultSignature) return;
  lastRenderedResultSignature = signature;
  setMetricLabel(metricLabels.mistakes, 'Mistakes', result.newBests.mistakes);
  setMetricLabel(metricLabels.time, 'Time', result.newBests.time);
  setMetricLabel(metricLabels.score, 'Score', result.newBests.score);
}

function renderStatisticsRows() {
  if (!bestList) return;
  const rows = [...bestList.querySelectorAll('.best-row')];
  if (!rows.length) return;

  const stats = readStats();
  const entries = Object.entries(window.DEJA_VU_RUNTIME?.difficulties || {});
  rows.forEach((row, index) => {
    const [key, difficulty] = entries[index] || [];
    if (!key || !difficulty) return;
    const best = stats.bests?.[key];
    const signature = best ? `${best.time}|${best.mistakes}|${best.score}` : 'none';
    if (row.dataset.metricsSignature === signature) return;
    row.dataset.metricsSignature = signature;
    row.classList.add('best-metrics-row');
    row.innerHTML = `
      <strong>${difficulty.label}</strong>
      <span class="best-metric"><small>Fastest</small>${best ? formatTime(best.time) : '—'}</span>
      <span class="best-metric"><small>Fewest mistakes</small>${best ? Number(best.mistakes) : '—'}</span>
      <span class="best-metric"><small>High score</small>${best ? Number(best.score).toLocaleString() : '—'}</span>`;
  });
}

installStatsSemantics();

completeDialog?.addEventListener('close', () => {
  lastRenderedResultSignature = '';
});

window.addEventListener('deja-vu:completion', renderCompletionResult);
window.addEventListener('deja-vu:statistics-rendered', renderStatisticsRows);
