# DEJA VU — Memory Game by INSPIRE

DEJA VU is a mobile-first card-matching and pattern-recognition game. Flip two cards, remember their positions, and clear the board with the fewest mistakes possible.

## Play

Open `index.html` through any static web server, or enable GitHub Pages for the repository. The app uses only relative paths and has no runtime dependencies.

## Build hosted output

The root web files are the source of truth. The hosted Site serves `dist/`, which is generated and should not be edited by hand.

```sh
npm run build
npm test
npm run dev
```

Run the build after changing any root HTML, JavaScript, CSS, manifest, icon, image, audio, or video asset. `npm test` runs responsive/gameplay checks, release-candidate audio/scoring/app-shell checks, and the `dist/` parity check. `npm run dev` serves the built app at `http://127.0.0.1:4173` for browser testing.

## Offline install

**First-online-load requirement: the app must be opened once over the network before it can run offline.** That first load registers `sw.js`, which precaches the entire app shell — HTML, CSS, JavaScript, the card sprite, the logo, every icon, the intro video, and both music tracks — into one versioned cache. Offline play is available as soon as that install finishes; the worker claims the first page, so no second visit and no reload are needed. If the connection drops mid-install, nothing is activated and the next online load starts over.

After that, everything works with no network: navigation returns the cached shell for any same-origin path or query string under the app's scope, and the cached MP4 and MP3s answer byte-range requests out of the cache, so media seeks and mobile playback work offline too.

Other behavior worth knowing:

- **Updates apply on the next cold start.** A new `sw.js` precaches into a new cache and then waits, so one page session is always served by a single cache generation and never mixes old and new assets. Close the app (or all tabs) and reopen it to pick up a new version; reloading a tab deliberately does not hand over.
- **Bump `CACHE_VERSION` in `sw.js` for every deploy.** The cache name derives from it, and old `deja-vu-*` caches are deleted on activate. `npm test` pins the current value so a release cannot forget it.
- **A missing optional asset does not break the install.** Media and artwork are precached, but a failure there is reported and retried on demand instead of aborting; only the HTML, CSS, JavaScript, and manifest are treated as required. The game stays playable when media fails: audio errors are swallowed and a failed intro video is simply skipped.
- **Failures are visible in development.** A failed registration logs to the page console, and the worker reports precache problems both to its own console and as a message to any open page.

## Features

- Four board sizes: Easy, Intermediate, Advanced, and Insane
- Original geometric card art from `card-flip-sprite-sheet.png`
- Touch, mouse, and full keyboard controls
- Timer, moves, mistakes, and difficulty-relative scoring (`pairs × 1,000 − mistakes × 350 − gameplay seconds × 5`)
- Working-memory board ratings: EXCELLENT 85–100%, GOOD 70–84%, AVERAGE 50–69%, and POOR 0–49%
- Local autosave with Continue Game
- Persistent statistics and personal bests
- Cyber, Woodgrain, Paper, and Light themes
- Scene-aware menu/gameplay music with smooth crossfades and persistent volume controls
- Restrained synthesized selection, match, mistake, menu, start, and completion feedback
- Independent, persistent SFX and best-effort haptic controls; vibration availability depends on the mobile browser
- Persistent theme and reduced-motion controls
- Installable PWA that plays fully offline after one online load
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
- `scripts/serve-dist.mjs` — dependency-free local static server with media range support
- `scripts/verify-responsive.mjs` — dependency-free viewport, input-flow, and accessibility regression checks
- `scripts/verify-release-candidate.mjs` — dependency-free scoring, audio, haptics, and app-shell audit

Built by [INSPIRE](https://www.inspireclothing.art).
