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

Run the build after changing any root HTML, JavaScript, CSS, manifest, icon, image, audio, or video asset. `npm test` runs the source-level checks (responsive/gameplay, release-candidate audio/scoring/app-shell, `dist/` parity) and then the rendered-behavior suite described below. `npm run dev` serves the built app at `http://127.0.0.1:4173` for browser testing.

## Rendered-behavior tests

`npm run test:browser` drives the built app in real Chromium and measures what a player would see, rather than matching source text or recomputing board maths. It serves `dist/` from a GitHub Pages-shaped subpath (`/DEJA-VU-MEMORY-GAME/`) so relative paths, manifest scope, and service-worker scope are exercised the way the hosted site uses them.

It covers:

- **No horizontal overflow** on any screen or dialog, checked on the document, `body`, `#app`, and the active view.
- **Essential text and controls reachable.** Each view declares the elements a player must be able to read or press; every one must be rendered, inside the available width without horizontal scrolling, reachable by vertical scrolling, and not covered by anything else. Buttons and inputs additionally have to be hit-testable and inside the viewport once scrolled to.
- **Views that must fit outright.** The start and intro screens have no scroll container, and on desktop the board and all three modals must fit the window without scrolling; only the long-form panels (statistics, help, settings) may scroll.
- **Intro aspect ratio.** The `<video>` box must not exceed its screen, and the painted frame's ratio must match the encoded one — no stretching, no cover-crop.
- **Desktop viewports** 1280x720, 1366x768, 1440x900 and 1920x1080, each at 100%, 125% and 150% browser zoom (zoom modelled as a smaller CSS viewport at a higher device pixel ratio).
- **Mobile layout stability.** Board, menu, dialog and intro geometry on seven phone and tablet viewports is compared against `scripts/mobile-layout-baseline.json`, and the desktop-only media queries must never match on a touch device. Intentional mobile changes are recorded with `npm run test:browser -- --update-baseline`.
- **Offline play.** After one online load and service-worker activation the network is switched off, and the suite then requires a served reload, shell-backed navigation for subpath/query/hash URLs, every asset and both music tracks fetching, byte-range requests answering 206 with correct `Content-Range` (probe, open, mid-file seek and suffix forms), audio decoding, and a complete Easy game played to the completion dialog.

Narrow a run while iterating with `--suite=desktop,intro,mobile,offline`.

The suite needs a Chromium build. `npx playwright install chromium` provides one; an existing binary works via `DEJA_VU_CHROMIUM=/path/to/chrome`. `DEJA_VU_SKIP_BROWSER_TESTS=1` skips it, which leaves rendered layout and offline behavior unverified — not a substitute for running it before a release.

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
- `scripts/verify-browser.mjs` — rendered layout, viewport-fit, and offline regression suite
- `scripts/browser-harness.mjs` / `scripts/browser-probes.js` — Chromium discovery, subpath test server, and the in-page measurement helpers
- `scripts/mobile-layout-baseline.json` — recorded phone and tablet geometry the suite guards

Built by [INSPIRE](https://www.inspireclothing.art).
