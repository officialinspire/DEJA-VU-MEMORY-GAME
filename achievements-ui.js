// DEJA VU achievements presentation: the Achievements screen, unlock notices
// and the completion highlight.
//
// It only shows what progress-tracker.js reports (getAchievements and its
// events) and never records or evaluates anything itself. index.html loads
// it as a module of its own, so if it ever fails to load, the game still
// plays and progress is still tracked.
//
// Notices never take focus and never cover the board or a result:
//  - they wait while the game, start or intro screen, any dialog, or a hidden
//    page is showing; one on screen when that changes is withdrawn and shown
//    again later in full;
//  - unlocks shown in the completion dialog are not repeated as a notice;
//  - simultaneous unlocks are one notice, and at most QUEUE_LIMIT wait: any
//    more merge into the last one waiting, so none is lost or piles up.

import { ACHIEVEMENT_CATEGORIES } from './achievement-catalog.js';
import { getAchievements, getProgress, getProgressStatus, getSessionBackfill } from './progress-tracker.js';

const QUEUE_LIMIT = 3;
const NOTICE_MS = 5000;
const NOTICE_GAP_MS = 350;
const HELD_SCREENS = new Set(['game', 'start', 'intro']);
const STATE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unlocked', label: 'Unlocked' },
  { key: 'locked', label: 'Locked' },
];

const screen = document.querySelector('#screen-achievements');
const list = document.querySelector('#achievement-list');
const categoryHost = screen.querySelector('.achievement-filters');
const stateHost = screen.querySelector('.achievement-state-filters');
const filterStatus = document.querySelector('#achievements-filter-status');
const unlockedCount = document.querySelector('#achievements-unlocked');
const totalCount = document.querySelector('#achievements-total');
const ring = document.querySelector('#achievements-ring');
const note = document.querySelector('#achievements-note');
const resetButton = document.querySelector('#btn-reset-achievements');
const resetDialog = document.querySelector('#reset-achievements-dialog');
const resetMessage = document.querySelector('#reset-achievements-message');
const completeDialog = document.querySelector('#complete-dialog');
const highlight = document.querySelector('#complete-achievements');
const noticeHost = document.querySelector('#achievement-toasts');
const live = document.querySelector('#achievement-live');

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const grouped = (value) => Number(value).toLocaleString();
const categoryLabel = Object.fromEntries(ACHIEVEMENT_CATEGORIES.map((category) => [category.key, category.label]));

// ------------------------------------------------------------------ badges ---

// One inline sprite: a badge frame, a glyph per category, and a lock.
const GLYPHS = {
  wins: '<path d="M24 13.5 33 24l-9 10.5L15 24z"/>',
  difficulty: '<rect x="15" y="15" width="7.5" height="7.5" rx="1.5"/><rect x="25.5" y="15" width="7.5" height="7.5" rx="1.5"/><rect x="15" y="25.5" width="7.5" height="7.5" rx="1.5"/><rect x="25.5" y="25.5" width="7.5" height="7.5" rx="1.5"/>',
  perfect: '<path d="m24 13 3.2 6.6 7.3 1-5.3 5.1 1.3 7.2L24 29.5l-6.5 3.4 1.3-7.2-5.3-5.1 7.3-1z"/>',
  pairs: '<rect x="13.5" y="16" width="12" height="17" rx="2.5" transform="rotate(-10 19.5 24.5)"/><rect x="22.5" y="15" width="12" height="17" rx="2.5" fill-opacity="0.65" transform="rotate(10 28.5 23.5)"/>',
  speed: '<path d="M26.5 12 16 26.5h7L21 36l11-15h-7.2z"/>',
  score: '<circle cx="24" cy="24" r="10" fill="none" stroke="currentColor" stroke-width="2.6"/><circle cx="24" cy="24" r="4.2"/>',
  'perfect-streak': '<path d="M14 18.5 20 24l-6 5.5M21.5 18.5l6 5.5-6 5.5M29 18.5l6 5.5-6 5.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
  'daily-streak': '<rect x="14.5" y="16.5" width="19" height="17" rx="3" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M14.5 21.5h19M19 13.5v5M29 13.5v5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="24" cy="27.5" r="2.6"/>',
  challenge: '<path d="m14 31-1.5-12 6.5 5.5 5-8.5 5 8.5 6.5-5.5L34 31z"/><rect x="14" y="32.5" width="20" height="3" rx="1.2"/>',
};

function installSprite() {
  if (document.querySelector('#achievement-badge-sprite')) return;
  const symbols = Object.entries(GLYPHS)
    .map(([key, shape]) => `<symbol id="ach-glyph-${key}" viewBox="0 0 48 48">${shape}</symbol>`)
    .join('');
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.id = 'achievement-badge-sprite';
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('focusable', 'false');
  sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  // Instances are styled through inherited custom properties (set on each
  // badge by achievements-ui.css), since a <use> copy cannot be selected.
  sprite.innerHTML = `<symbol id="ach-frame" viewBox="0 0 48 48"><path d="M24 3.5 41.8 13.75v20.5L24 44.5 6.2 34.25v-20.5z" style="fill: var(--badge-fill); stroke: var(--badge-stroke); stroke-width: 2; stroke-linejoin: round"/></symbol>${symbols}`
    + '<symbol id="ach-lock" viewBox="0 0 48 48"><circle cx="37" cy="37" r="9" style="fill: var(--badge-lock-disc)"/>'
    + '<rect x="33" y="36" width="8" height="6.2" rx="1.4" style="fill: var(--badge-lock-ink)"/>'
    + '<path d="M34.7 36v-2.1a2.3 2.3 0 0 1 4.6 0V36" style="fill: none; stroke: var(--badge-lock-ink); stroke-width: 1.8"/></symbol>';
  document.body.prepend(sprite);
}

function badge(category, extraClass = '') {
  return `<svg class="achievement-badge ${extraClass}" data-category="${category}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">`
    + `<use href="#ach-frame"></use><use class="badge-glyph" href="#ach-glyph-${category}"></use><use class="badge-lock" href="#ach-lock"></use></svg>`;
}

// ------------------------------------------------------------------ screen ---

const filter = { category: 'all', state: 'all' };
const rows = new Map();
const groups = new Map();
let built = false;
let emptyMessage = null;

function readAchievements() {
  try {
    return getAchievements();
  } catch (_) {
    return [];
  }
}

function progressText(item) {
  const { value, threshold } = item;
  if (item.comparison === 'atMost') {
    if (item.unit === 'mistakes') return value === null ? 'No win on this board yet' : `Fewest mistakes ${value} · goal ${threshold}`;
    return value === null ? 'No qualifying win yet' : `Best ${value} s · goal ${threshold} s`;
  }
  const shown = value ?? 0;
  switch (item.unit) {
    case 'pairs': return `${grouped(shown)} of ${grouped(threshold)} pairs`;
    case 'points': return value === null ? 'No score yet' : `${grouped(shown)} of ${grouped(threshold)} points`;
    case 'percent': return value === null ? 'Not rated yet' : `Best ${shown}% · goal ${threshold}%`;
    case 'days': return `Best run ${shown} of ${threshold} days`;
    case 'matches': return `Best chain ${shown} of ${threshold}`;
    case 'difficulties': return `${shown} of ${threshold} difficulties`;
    default:
      if (item.category === 'perfect-streak') return `Best run ${shown} of ${threshold}`;
      if (item.category === 'perfect') return `${grouped(shown)} of ${grouped(threshold)} perfect`;
      return `${grouped(shown)} of ${grouped(threshold)} won`;
  }
}

function unlockText(item) {
  const when = item.unlockedAt === null ? '' : dateFormat.format(item.unlockedAt);
  if (item.backfilled) return when ? `From earlier games · recorded ${when}` : 'From earlier games';
  return when;
}

function chip(group, key, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'filter-chip';
  button.dataset[group] = key;
  button.setAttribute('aria-pressed', String(filter[group] === key));
  button.innerHTML = `<span class="filter-chip-label">${label}</span><span class="filter-chip-count" aria-hidden="true"></span>`;
  button.addEventListener('click', () => {
    if (filter[group] === key) return;
    filter[group] = key;
    applyFilter(true);
  });
  return button;
}

// Arrow keys move along a row of filters; Tab still reaches every one.
function arrowNavigation(host) {
  host.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...host.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
}

function build(achievements) {
  categoryHost.replaceChildren(
    chip('category', 'all', 'All'),
    ...ACHIEVEMENT_CATEGORIES.map((category) => chip('category', category.key, category.label)),
  );
  stateHost.replaceChildren(...STATE_FILTERS.map((state) => chip('state', state.key, state.label)));

  const fragment = document.createDocumentFragment();
  for (const category of ACHIEVEMENT_CATEGORIES) {
    const section = document.createElement('section');
    section.className = 'achievement-group';
    section.dataset.category = category.key;
    section.setAttribute('aria-labelledby', `achievement-group-${category.key}`);
    section.innerHTML = `<h2 id="achievement-group-${category.key}"><span>${category.label}</span> <span class="achievement-group-count"></span></h2><ul class="achievement-items"></ul>`;
    const itemsHost = section.querySelector('ul');
    for (const item of achievements.filter((entry) => entry.category === category.key)) {
      const row = document.createElement('li');
      row.className = 'achievement';
      row.dataset.id = item.id;
      row.dataset.category = item.category;
      row.innerHTML = `${badge(item.category)}<div class="achievement-text">`
        + `<strong class="achievement-name"></strong><p class="achievement-requirement"></p>`
        + '<p class="achievement-status"><span class="achievement-state"></span> <span class="achievement-detail"></span></p>'
        + '<span class="achievement-meter" aria-hidden="true"><span></span></span></div>';
      itemsHost.append(row);
      rows.set(item.id, {
        row,
        name: row.querySelector('.achievement-name'),
        requirement: row.querySelector('.achievement-requirement'),
        state: row.querySelector('.achievement-state'),
        detail: row.querySelector('.achievement-detail'),
        meter: row.querySelector('.achievement-meter > span'),
      });
    }
    groups.set(category.key, { section, count: section.querySelector('.achievement-group-count') });
    fragment.append(section);
  }
  emptyMessage = document.createElement('p');
  emptyMessage.className = 'achievement-empty';
  emptyMessage.textContent = 'No achievements match these filters.';
  emptyMessage.hidden = true;
  fragment.append(emptyMessage);
  list.replaceChildren(fragment);
  built = true;
}

function renderScreen() {
  const achievements = readAchievements();
  if (!achievements.length) {
    list.innerHTML = '<p class="achievement-empty">Achievements are unavailable right now.</p>';
    built = false;
    return;
  }
  if (!built) build(achievements);

  for (const item of achievements) {
    const view = rows.get(item.id);
    if (!view) continue;
    const state = item.unlocked ? 'unlocked' : 'locked';
    view.row.dataset.state = state;
    view.row.classList.toggle('is-backfilled', item.backfilled);
    view.name.textContent = item.name;
    view.requirement.textContent = item.requirement;
    view.state.textContent = item.unlocked ? 'Unlocked' : 'Locked';
    if (item.unlocked) {
      const text = unlockText(item);
      if (item.unlockedAt === null) view.detail.textContent = text;
      else {
        const time = document.createElement('time');
        time.dateTime = new Date(item.unlockedAt).toISOString();
        time.textContent = text;
        view.detail.replaceChildren(time);
      }
    } else {
      view.detail.textContent = progressText(item);
    }
    view.meter.style.width = `${Math.round(item.progress * 100)}%`;
  }

  const unlocked = achievements.filter((item) => item.unlocked).length;
  unlockedCount.textContent = String(unlocked);
  totalCount.textContent = String(achievements.length);
  const percent = Math.round((unlocked / achievements.length) * 100);
  ring.setAttribute('stroke-dasharray', `${percent} ${100 - percent}`);

  for (const [key, group] of groups) {
    const inGroup = achievements.filter((item) => item.category === key);
    const done = inGroup.filter((item) => item.unlocked).length;
    group.count.innerHTML = `<span aria-hidden="true">${done}/${inGroup.length}</span><span class="visually-hidden">${done} of ${inGroup.length} unlocked</span>`;
  }
  for (const button of categoryHost.querySelectorAll('button')) {
    const key = button.dataset.category;
    const scope = key === 'all' ? achievements : achievements.filter((item) => item.category === key);
    button.querySelector('.filter-chip-count').textContent = `${scope.filter((item) => item.unlocked).length}/${scope.length}`;
  }

  const status = getProgressStatus();
  const resetAt = readResetAt();
  if (status.persistent === false) note.textContent = 'Progress cannot be saved on this device right now, so achievements count for this visit only.';
  else if (resetAt !== null) note.textContent = `Counting since you reset achievements on ${dateFormat.format(resetAt)}.`;
  else if (!unlocked) note.textContent = 'Win games to unlock achievements.';
  else note.textContent = `${achievements.length - unlocked} still to discover.`;
  applyFilter(false);
}

function readResetAt() {
  try {
    const at = getProgress().achievements?.resetAt;
    return Number.isSafeInteger(at) ? at : null;
  } catch (_) {
    return null;
  }
}

function applyFilter(announceChange) {
  if (!built) return;
  for (const button of screen.querySelectorAll('.filter-chip')) {
    const group = button.dataset.category !== undefined ? 'category' : 'state';
    button.setAttribute('aria-pressed', String(filter[group] === button.dataset[group]));
  }
  let shown = 0;
  for (const [key, group] of groups) {
    const categoryShown = filter.category === 'all' || filter.category === key;
    let visible = 0;
    for (const item of group.section.querySelectorAll('.achievement')) {
      const match = categoryShown && (filter.state === 'all' || item.dataset.state === filter.state);
      item.hidden = !match;
      if (match) visible += 1;
    }
    group.section.hidden = visible === 0;
    shown += visible;
  }
  emptyMessage.hidden = shown > 0;
  if (announceChange) {
    const what = filter.category === 'all' ? '' : ` ${categoryLabel[filter.category]}`;
    const which = filter.state === 'all' ? '' : ` ${filter.state}`;
    filterStatus.textContent = `Showing ${shown}${which}${what} achievement${shown === 1 ? '' : 's'}.`;
  }
}

// ------------------------------------------------------------------- reset ---

resetButton.addEventListener('click', () => {
  const unlocked = readAchievements().filter((item) => item.unlocked).length;
  resetMessage.textContent = `This locks ${unlocked === 1 ? 'your 1 unlocked achievement' : `all ${unlocked} unlocked achievements`} again and clears all progress toward every achievement: the win, pair and streak counts and the best times and scores they track. It cannot be undone.`;
  resetDialog.returnValue = '';
  resetDialog.showModal();
});

resetDialog.addEventListener('close', () => {
  if (resetDialog.returnValue === 'reset') {
    window.dispatchEvent(new CustomEvent('deja-vu:achievements-reset', { detail: { at: Date.now() } }));
    // Notices for achievements that are locked again would now be wrong.
    queue.length = 0;
    withdraw(false);
    say('Achievements reset. Your statistics are unchanged.');
    renderScreen();
  }
  requestAnimationFrame(() => {
    if (screen.classList.contains('is-active')) resetButton.focus({ preventScroll: true });
  });
});

// ----------------------------------------------------------------- notices ---

const queue = [];
let current = null;
let pumpTimer = 0;

function say(text) {
  live.textContent = '';
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

function activeScreen() {
  return document.querySelector('.screen.is-active')?.id.replace(/^screen-/, '') || '';
}

function held() {
  return document.hidden || HELD_SCREENS.has(activeScreen()) || Boolean(document.querySelector('dialog[open]'));
}

function names(achievements, limit) {
  const shown = achievements.slice(0, limit).map((item) => item.name);
  const more = achievements.length - shown.length;
  if (!more) return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  return `${shown.join(', ')} and ${more} more`;
}

function enqueue(batch) {
  if (!batch.achievements.length) return;
  if (queue.length >= QUEUE_LIMIT) {
    const last = queue[queue.length - 1];
    const known = new Set(last.achievements.map((item) => item.id));
    last.achievements.push(...batch.achievements.filter((item) => !known.has(item.id)));
    if (batch.source !== last.source) last.source = 'mixed';
  } else {
    queue.push(batch);
  }
  pump();
}

function pump() {
  clearTimeout(pumpTimer);
  if (current || held() || !queue.length) return;
  show(queue.shift());
}

function noticeText(batch) {
  const count = batch.achievements.length;
  if (batch.source === 'history') {
    return {
      eyebrow: 'From your earlier games',
      title: count === 1 ? batch.achievements[0].name : `${count} achievements unlocked`,
      detail: count === 1 ? batch.achievements[0].requirement : names(batch.achievements, 2),
      spoken: `${count} achievement${count === 1 ? '' : 's'} unlocked from your earlier games: ${names(batch.achievements, 5)}.`,
    };
  }
  if (count === 1) {
    const [item] = batch.achievements;
    return { eyebrow: 'Achievement unlocked', title: item.name, detail: item.requirement, spoken: `Achievement unlocked: ${item.name}. ${item.requirement}` };
  }
  return {
    eyebrow: `${count} achievements unlocked`,
    title: names(batch.achievements, 2),
    detail: 'Open Achievements to see them all.',
    spoken: `${count} achievements unlocked: ${names(batch.achievements, 5)}.`,
  };
}

function show(batch) {
  const text = noticeText(batch);
  const element = document.createElement('div');
  element.className = 'achievement-toast';
  element.dataset.source = batch.source;
  element.dataset.count = String(batch.achievements.length);
  element.innerHTML = `${badge(batch.achievements[0].category, 'is-unlocked')}<div class="achievement-toast-text">`
    + '<p class="achievement-toast-eyebrow"></p><p class="achievement-toast-title"></p><p class="achievement-toast-detail"></p></div>'
    + '<div class="achievement-toast-actions"><button type="button" class="achievement-toast-view">View</button>'
    + '<button type="button" class="achievement-toast-close" aria-label="Dismiss notice">×</button></div>';
  element.querySelector('.achievement-toast-eyebrow').textContent = text.eyebrow;
  element.querySelector('.achievement-toast-title').textContent = text.title;
  element.querySelector('.achievement-toast-detail').textContent = text.detail;
  element.querySelector('.achievement-toast-close').addEventListener('click', () => dismiss());
  element.querySelector('.achievement-toast-view').addEventListener('click', () => {
    dismiss();
    window.dispatchEvent(new CustomEvent('deja-vu:open-achievements'));
  });

  noticeHost.append(element);
  placeNotices();
  current = { batch, element, timer: 0, remaining: NOTICE_MS, since: 0, paused: 0 };
  say(text.spoken);
  // Hovering or focusing a notice holds it on screen.
  element.addEventListener('pointerenter', () => pauseNotice(true));
  element.addEventListener('pointerleave', () => pauseNotice(false));
  element.addEventListener('focusin', () => pauseNotice(true));
  element.addEventListener('focusout', (event) => {
    if (!element.contains(event.relatedTarget)) pauseNotice(false);
  });
  requestAnimationFrame(() => element.classList.add('is-shown'));
  runTimer();
}

// A notice goes at the top or the bottom edge, whichever covers less of the
// screen's controls as it is scrolled right now. Ties go to the brand's space
// at the top of the menu, and to the bottom of the panels, clear of their
// headers and Back buttons.
function placeNotices() {
  const name = activeScreen();
  const preferred = name === 'menu' ? 'top' : 'bottom';
  const toast = noticeHost.querySelector('.achievement-toast');
  const container = document.querySelector('.screen.is-active');
  if (!toast || !container) {
    noticeHost.dataset.placement = preferred;
    return;
  }
  const covered = (placement) => {
    noticeHost.dataset.placement = placement;
    const box = toast.getBoundingClientRect();
    let area = 0;
    for (const control of container.querySelectorAll('button, a[href], input, select')) {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const width = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
      const height = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
      if (width > 0 && height > 0) area += width * height;
    }
    return area;
  };
  const other = preferred === 'top' ? 'bottom' : 'top';
  const costs = { [preferred]: covered(preferred), [other]: covered(other) };
  noticeHost.dataset.placement = costs[other] < costs[preferred] ? other : preferred;
}

function runTimer() {
  if (!current || current.paused) return;
  clearTimeout(current.timer);
  current.since = performance.now();
  current.timer = setTimeout(() => dismiss(), current.remaining);
}

function pauseNotice(pause) {
  if (!current) return;
  current.paused += pause ? 1 : -1;
  current.paused = Math.max(0, current.paused);
  if (current.paused) {
    clearTimeout(current.timer);
    current.remaining = Math.max(1000, current.remaining - (performance.now() - current.since));
  } else {
    runTimer();
  }
}

function dismiss() {
  if (!current) return;
  const { element } = current;
  clearTimeout(current.timer);
  current = null;
  const hadFocus = element.contains(document.activeElement);
  element.classList.remove('is-shown');
  element.classList.add('is-leaving');
  const reduced = document.documentElement.classList.contains('reduced-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => element.remove(), reduced ? 0 : 220);
  // Keyboard users who dismissed it land back on the screen, not on nothing.
  if (hadFocus) document.querySelector('.screen.is-active')?.focus({ preventScroll: true });
  pumpTimer = setTimeout(pump, NOTICE_GAP_MS);
}

// A notice on screen when the board, a result or another dialog comes up is
// taken down at once and shown again later in full.
function withdraw(requeue = true) {
  if (!current) return;
  const { batch, element } = current;
  clearTimeout(current.timer);
  current = null;
  element.remove();
  if (!requeue) return;
  if (queue.length >= QUEUE_LIMIT) {
    const first = queue[0];
    const known = new Set(first.achievements.map((item) => item.id));
    first.achievements.unshift(...batch.achievements.filter((item) => !known.has(item.id)));
  } else {
    queue.unshift(batch);
  }
}

// ------------------------------------------------------ completion results ---

let highlighted = null;
// The highlight the open results dialog is showing: closing it clears that
// one only, never a newer one rendered before the close event arrives.
let presented = null;

function renderHighlight(batch) {
  const count = batch.achievements.length;
  highlight.innerHTML = `<span class="completion-achievement-badges" aria-hidden="true">${batch.achievements.slice(0, 3).map((item) => badge(item.category, 'is-unlocked')).join('')}</span>`
    + '<span class="completion-achievement-text"><strong></strong> <span class="completion-achievement-names"></span></span>';
  highlight.querySelector('strong').textContent = count === 1 ? 'Achievement unlocked:' : `${count} achievements unlocked:`;
  highlight.querySelector('.completion-achievement-names').textContent = names(batch.achievements, count);
  highlight.hidden = false;
  highlighted = batch;
}

function clearHighlight() {
  highlight.hidden = true;
  highlight.replaceChildren();
  highlighted = null;
}

window.addEventListener('deja-vu:achievements-unlocked', (event) => {
  const achievements = (event.detail?.achievements || []).filter((item) => item?.id && item.name);
  if (!achievements.length) return;
  const batch = { source: 'run', runId: event.detail.runId ?? null, achievements };
  if (event.detail.cause === 'completion') renderHighlight(batch);
  enqueue(batch);
});

// A new board, the menu or a finished game retires a highlight whose results
// were never shown; its notice still waits in the queue.
window.addEventListener('deja-vu:game-generation', () => {
  if (!completeDialog.open) clearHighlight();
});

// 'close' arrives a task after the dialog shut; if it has been opened again
// since, this event belongs to the earlier showing and changes nothing.
completeDialog.addEventListener('close', () => {
  if (completeDialog.open) return;
  if (highlighted === presented) clearHighlight();
  presented = null;
});

function onCompleteDialogOpen() {
  presented = highlighted;
  if (!highlighted) return;
  // The results dialog itself presents these: no notice repeats them.
  const index = queue.indexOf(highlighted);
  if (index >= 0) queue.splice(index, 1);
}

// --------------------------------------------------------------- watching ---

let completeWasOpen = completeDialog.open;
const observer = new MutationObserver(() => {
  if (completeDialog.open && !completeWasOpen) onCompleteDialogOpen();
  completeWasOpen = completeDialog.open;
  if (screen.classList.contains('is-active')) renderScreen();
  if (held()) withdraw();
  else if (current) placeNotices();
  else pump();
});
document.querySelectorAll('.screen').forEach((node) => observer.observe(node, { attributes: true, attributeFilter: ['class'] }));
document.querySelectorAll('dialog').forEach((node) => observer.observe(node, { attributes: true, attributeFilter: ['open'] }));
document.addEventListener('visibilitychange', () => {
  if (held()) withdraw();
  else pump();
});

// A hidden screen is brought up to date when it is shown, not on every win.
window.addEventListener('deja-vu:progress-updated', () => {
  if (screen.classList.contains('is-active')) renderScreen();
});

installSprite();
arrowNavigation(categoryHost);
arrowNavigation(stateHost);
// The list is built the first time the screen is shown, not at startup.
if (screen.classList.contains('is-active')) renderScreen();

// Achievements an upgrade's first load proved from earlier games, said once.
{
  const backfilled = new Set(getSessionBackfill());
  if (backfilled.size) {
    enqueue({ source: 'history', runId: null, achievements: readAchievements().filter((item) => backfilled.has(item.id)) });
  }
}
