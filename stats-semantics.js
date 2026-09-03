(function () {
  const screen = document.querySelector('#screen-statistics');
  if (!screen) return;
  const heading = [...screen.querySelectorAll('h2')].find((node) => node.textContent.trim() === 'Personal Bests');
  if (heading) heading.textContent = 'Best Metrics';
  const bestList = document.querySelector('#best-list');
  if (!bestList || document.querySelector('#best-metrics-note')) return;
  const note = document.createElement('p');
  note.id = 'best-metrics-note';
  note.className = 'stats-note';
  note.textContent = 'Fastest time, fewest mistakes, and highest score are tracked independently for each difficulty.';
  bestList.before(note);
})();