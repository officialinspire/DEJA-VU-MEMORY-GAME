# DEJA VU — Memory Game by INSPIRE

DEJA VU is a mobile-first card-matching and pattern-recognition game. Flip two cards, remember their positions, and clear the board with the fewest mistakes possible.

## Play

Open `index.html` through any static web server, or enable GitHub Pages for the repository. The app uses only relative paths and has no runtime dependencies.

## Features

- Four board sizes: Easy, Intermediate, Advanced, and Insane
- Original geometric card art from `card-flip-sprite-sheet.png`
- Touch, mouse, and full keyboard controls
- Timer, moves, mistakes, completion grades, and scoring
- Local autosave with Continue Game
- Persistent statistics and personal bests
- Cyber, Woodgrain, Paper, and Light themes
- Background music, synthesized UI sounds, and reduced-motion controls
- Installable, offline-capable PWA
- INSPIRE click-to-start and skippable intro sequence

## Keyboard controls

- Arrow keys: move between cards
- Enter or Space: flip the focused card
- Escape: pause

## Project structure

- `index.html` — app screens and accessible interface
- `styles.css` — responsive design, themes, card sprite rendering, and animation
- `index.js` — game rules, screen flow, persistence, statistics, controls, and audio
- `sw.js` / `manifest.webmanifest` — offline and installable web app support

Built by [INSPIRE](https://www.inspireclothing.art).
