// Prompt 15: completion/results and statistics presentation.
// This module never writes statistics. index.js remains the single authority for
// wins, perfect games, and best-metric persistence.

const STATS_KEY = 'inspireDejaVu:v1:statistics';
const cardGrid = document.querySelector('#card-grid');
const completeDialog = document.querySelector('#complete-dialog');
const completeSummary = document.querySelector('#complete-summary');
const completeScore = document.querySelector('#complete-score');
const completeGrade = document.querySelector('#complete-grade');
const difficultyLabel = document.querySelector('#game-difficulty');
const bestList = document.querySelector('#best-list');

let runBaseline = null;
let lastRenderedResultSignature = '';
let statsRendering = false;

function readStats() {
  try {
    const value = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function difficultyKeyFromBoard() {
  const rows = Number(cardGrid?.getAttribute('aria-rowcount'));
  const cols = Number(cardGrid?.getAttribute('aria-colcount'));
  const table = window.DEJA_VU_BALANCE?.difficulties || {};
  return Object.entries(table).find(([, item]) => item.rows === rows && item.cols === cols)?.[0] || 'easy';
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const remainder = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function snapshotRunBaseline() {
  const key = difficultyKeyFromBoard();
  const stats = readStats();
  const previous = stats.bests?.[key];
  runBaseline = {
    key,
    best: previous ? {
      time: Number(previous.time),
      mistakes: Number(previous.mistakes),
      score: Number(previous.score),
    } : null,
  };
  lastRenderedResultSignature = '';
}

function parseCompletionSummary() {
  const text = completeSummary?.textContent || '';
  const match = text.match(/(\d+)\s+moves\s+·\s+(\d+)\s+mistakes\s+·\s+(\d{2}):(\d{2})/i);
  if (!match) return null;
  return {
    moves: Number(match[1]),
    mistakes: Number(match[2]),
    elapsed: Number(match[3]) * 60 + Number(match[4]),
  };
}

function ensureCompletionDetails() {
  let details = document.querySelector('#completion-details');
  if (details) return details;

  details = document.createElement('div');
  details.id = 'completion-details';
  details.className = 'completion-details';
  completeSummary?.after(details);
  return details;
}

function bestBadge(isBest) {
  return isBest ? '<span class="new-best-badge">NEW BEST</span>' : '';
}

function renderCompletionResult() {
  if (!completeDialog?.open) return;
  const result = parseCompletionSummary();
  if (!result) return;

  const key = runBaseline?.key || difficultyKeyFromBoard();
  const score = Number(String(completeScore?.textContent || '0').replace(/,/g, '')) || 0;
  const previous = runBaseline?.best || null;
  const firstRecord = !previous;
  const newTime = firstRecord || result.elapsed < previous.time;
  const newMistakes = firstRecord || result.mistakes < previous.mistakes;
  const newScore = firstRecord || score > previous.score;
  const signature = `${key}|${result.moves}|${result.mistakes}|${result.elapsed}|${score}|${newTime}|${newMistakes}|${newScore}`;
  if (signature === lastRenderedResultSignature) return;
  lastRenderedResultSignature = signature;

  const label = window.DEJA_VU_BALANCE?.difficulties?.[key]?.label || difficultyLabel?.textContent || key;
  const details = ensureCompletionDetails();
  details.innerHTML = `
    <p class="completion-difficulty">${label}</p>
    <div class="completion-metrics" aria-label="Game results">
      <div><span>Moves</span><strong>${result.moves}</strong></div>
      <div><span>Mistakes ${bestBadge(newMistakes)}</span><strong>${result.mistakes}</strong></div>
      <div><span>Time ${bestBadge(newTime)}</span><strong>${formatTime(result.elapsed)}</strong></div>
      <div><span>Score ${bestBadge(newScore)}</span><strong>${score.toLocaleString()}</strong></div>
    </div>`;

  if (completeSummary) completeSummary.hidden = true;
  if (completeGrade) completeGrade.setAttribute('aria-describedby', 'completion-details');
}

function renderStatisticsRows() {
  if (!bestList || statsRendering) return;
  const rows = [...bestList.querySelectorAll('.best-row')];
  if (!rows.length) return;

  statsRendering = true;
  const stats = readStats();
  const entries = Object.entries(window.DEJA_VU_BALANCE?.difficulties || {});

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
  statsRendering = false;
}

if (cardGrid) {
  const gridObserver = new MutationObserver(() => {
    if (cardGrid.querySelector('.memory-card')) snapshotRunBaseline();
  });
  gridObserver.observe(cardGrid, { childList: true });
}

completeDialog?.addEventListener('close', () => {
  if (completeSummary) completeSummary.hidden = false;
  lastRenderedResultSignature = '';
});

const completionObserver = completeDialog ? new MutationObserver(renderCompletionResult) : null;
completionObserver?.observe(completeDialog, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });

const statsObserver = bestList ? new MutationObserver(renderStatisticsRows) : null;
statsObserver?.observe(bestList, { childList: true });

renderStatisticsRows();
