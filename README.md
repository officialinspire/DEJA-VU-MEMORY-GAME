# DEJA VU — Memory Game by INSPIRE

DEJA VU is a mobile-first card-matching and pattern-recognition game. Flip two cards, remember their positions, and clear the board with the fewest mistakes possible.

## Play

Open `index.html` through any static web server, or enable GitHub Pages for the repository. The app uses only relative paths and has no runtime dependencies.

## Build hosted output

The root web files are the source of truth. The hosted Site serves `dist/`, which is generated and should not be edited by hand.

```sh
node scripts/build-dist.mjs
node scripts/build-dist.mjs --check
node scripts/verify-responsive.mjs
```

Run the build after changing any root HTML, JavaScript, CSS, manifest, icon, image, audio, or video asset. The check command fails if `dist/` is missing files, contains obsolete files, or differs from the root source.

## Features

- Four board sizes: Easy, Intermediate, Advanced, and Insane
- Original geometric card art from `card-flip-sprite-sheet.png`
- Touch, mouse, and full keyboard controls
- Timer, moves, mistakes, difficulty-relative working-memory ratings, and scoring
- Local autosave with Continue Game
- Persistent statistics and personal bests
- Cyber, Woodgrain, Paper, and Light themes
- Scene-aware music, restrained synthesized feedback, optional mobile haptics, and reduced-motion controls
- Installable, offline-capable PWA
- INSPIRE click-to-start and skippable intro sequence

## Keyboard controls

- Arrow keys: move between cards
- Enter or Space: flip the focused card
- Escape: pause

## Project structure

- `index.html` — app screens and accessible interface
- `styles.css` — responsive design, themes, card sprite rendering, and animation
- `index.js` — game rules, screen flow, persistence, statistics, and controls
- `audio-manager.js` — reusable scene music, crossfades, and mobile audio unlock
- `feedback-manager.js` — synthesized UI cues and guarded mobile vibration feedback
- `sw.js` / `manifest.webmanifest` — offline and installable web app support
- `scripts/build-dist.mjs` — deterministic `dist/` build and parity validation
- `scripts/verify-responsive.mjs` — dependency-free viewport, input-flow, and accessibility regression checks

Built by [INSPIRE](https://www.inspireclothing.art).
