## Offline install

**First-online-load requirement: the app must be opened once over the network before it can run offline.** That first load registers `sw.js` (as soon as the card art has arrived, so the two never compete for a slow connection), which precaches the entire app shell — HTML, CSS, JavaScript, the card sprite, the logo, every icon, the intro video, and both music tracks — into one versioned cache. Offline play is available as soon as that install finishes; the worker claims the first page, so no second visit and no reload are needed. If the connection drops mid-install, nothing is activated and the next online load starts over.

### Installing for offline play

1. Open the site once with a working connection and let it finish loading. The precache is 29 entries, about 8.2 MB, most of it the two music tracks and the card sprite.
2. Wait a moment for the install to complete. In DevTools this is Application → Service Workers showing **activated**, and Application → Cache Storage holding a `deja-vu-<version>@/DEJA-VU-MEMORY-GAME/` cache with 29 entries. On a local network this takes well under a second; on a slow connection it is bounded by downloading those 8.2 MB.
3. Install the app if you want a standalone window: **Chrome/Edge desktop** — the install icon in the address bar, or ⋮ → Cast, save and share → Install. **Android Chrome** — ⋮ → Add to Home screen. **iOS Safari** — Share → Add to Home Screen (Safari has no install prompt; this is the only route).
4. You can now go fully offline. Launching from the home screen or the installed window works with no network, as does reloading the tab.

### Updating

Updates apply on the **next cold start**, not on reload. A new `sw.js` precaches into a new cache and then waits, so one page session is always served by a single cache generation and never mixes old and new assets. Close the app or all its tabs and reopen to pick it up; the old cache is deleted at that point. Reloading a tab deliberately does not hand over.

Bump `CACHE_VERSION` in `sw.js` for every deploy — the cache name derives from it, and `npm test` pins the current value so a release cannot forget it.

### Limitations

- **One online load is mandatory.** There is no way to seed the cache offline. A visitor who is offline on their very first visit gets nothing.
- **Updates need a cold start.** A player who never fully closes the app stays on the version they installed. This is deliberate: it is what guarantees a session never mixes asset versions. There is no in-app "update available" prompt.
- **The intro video needs H.264/AAC.** `inspiresoftwareintro.mp4` is H.264 video with AAC audio, and no alternative encoding ships. Browsers built without those proprietary codecs — Chromium built from source, and some Linux distribution builds of Chromium and Firefox — cannot decode it. The app handles this correctly rather than hanging: the video reports an error and the intro is skipped straight to the menu, with everything else unaffected. The music is MP3 and is not affected. If the intro matters on those browsers, a WebM/VP9 copy would need to be added as a second `<source>`.
- **Media failure is survivable but silent.** If the tracks or the video fail to download, install still succeeds and the game stays fully playable; there is no in-app notice that audio is unavailable, only a console warning from the worker.
- **The card art is not optional.** If the sprite sheet cannot be precached, the install fails and no worker activates, so the app never claims to work offline without its cards; the next online load retries.
- **Storage is not guaranteed.** The precache is about 8.2 MB and the app does not request persistent storage, so a browser under storage pressure may evict it; the next online load simply re-installs. Safari in particular applies its own eviction policy to storage for sites that have not been used recently, which can drop the offline copy of a site that was only visited in a tab rather than added to the Home Screen.
- **`file://` is not supported.** Service workers require a secure context, so registration is skipped when the page is opened directly from disk. Use a local server (`npm run dev`) or a hosted origin.

# DEJA VU — Memory Game by INSPIRE

DEJA VU is a mobile-first card-matching and pattern-recognition game. Flip two cards, remember their positions, and clear the board with the fewest mistakes possible.

## Play

Open `index.html` through any static web server, or enable GitHub Pages for the repository. The app uses only relative paths and has no runtime dependencies.

## Social link previews

`index.html` carries Open Graph and Twitter Card tags so the GitHub Pages link
unfurls with the banner on Facebook, LinkedIn, Reddit, X, Discord, Slack, and
iMessage. The image is `Deja-Vu-Banner.png` (1942x809), referenced by absolute
URL because crawlers never resolve relative paths:

```
https://officialinspire.github.io/DEJA-VU-MEMORY-GAME/Deja-Vu-Banner.png
```

If the site ever moves to a custom domain, update the absolute `og:url`,
`og:image`, `og:image:secure_url`, `twitter:image`, and `rel="canonical"` values
in `index.html`, then run `npm run build`. If the banner itself is replaced,
update `og:image:width` / `og:image:height` to the new pixel dimensions.

Social networks cache the first preview they scrape, so after changing these
tags force a refresh:

- Facebook — [Sharing Debugger](https://developers.facebook.com/tools/debug/) → *Scrape Again*
- LinkedIn — [Post Inspector](https://www.linkedin.com/post-inspector/)
- X — [Card Validator](https://cards-dev.twitter.com/validator)

The image shown on the repository page itself (rather than the Pages link) is a
separate setting: GitHub → *Settings* → *General* → *Social preview*.

## Build hosted output

The root web files are the source of truth. The hosted Site serves `dist/`, which is generated and should not be edited by hand.

```sh
npm run build
npm test
npm run dev
```

Run the build after changing any root HTML, JavaScript, CSS, manifest, icon, image, audio, or video asset.

The build also audits every reference the hosted files make, resolving each the way a browser does on the GitHub Pages project subpath: HTML `src`/`href`/`poster` and the absolute social-preview URLs, CSS `url()` and `@import`, JavaScript imports and relative path strings (`new URL(…, import.meta.url)`, image sources, the worker's precache list, its registration), and the manifest's icons, `start_url` and `scope`. It fails on a missing file, a filename whose case differs from the file on disk (Pages is case-sensitive even where a dev machine is not), a path that escapes the subpath (`/logo.png`, `../`), a malformed or double percent-encoding (spaces may be written raw or as `%20`, but not `%2520`), an unquoted CSS `url()` with a space, and any asset the running app requests that is missing from the `sw.js` precache. Hosted files nothing references (`Deja-Vu-Instagram.png`, the legacy `deja-vu-theme.mp3`) are listed, not failed.

## Gameplay timing

All gameplay timing runs on one clock, `gameplay-clock.js`. Turn resolution (match 460 ms, mismatch study per difficulty: 1,050 / 950 / 850 / 750 ms, flip-back, completion dialog), the memorize preview and its countdown are scheduled on it explicitly. The global `setTimeout`/`setInterval` overrides that used to do this by matching magic delays are gone.

- **Pausing freezes play.** While the pause dialog is open or the page is hidden, every pending gameplay timer is frozen with its remaining time and holds no native timer, so nothing runs or polls in the background. Resuming continues each one where it stopped: a mismatch keeps the rest of its study time, and the preview keeps the rest of its countdown, whether paused by button, Escape or hiding the page. Coming back to a hidden game opens the pause dialog as before.
- **Stale work is cancelled.** A new board, a resumed board, the menu and completion cancel everything the old board had pending, the preview included. The session, turn and generation guards still drop anything that slips through.
- **Score time is measured, not counted.** The clock accumulates play time from timestamps while a game is actually being played: not paused, hidden, previewing or finished. The shown time is updated as each whole second passes, with no interval to drift, and is exactly the time scored. Saves keep whole seconds in `elapsed` as before, plus `elapsedMs` for a precise resume.

Music elements are unlocked one by one. A `play()` the browser refuses for want of a gesture is retried inside the next real (trusted) tap or key press. Element errors, such as a dropped connection or a decode failure, are retried three times with backoff (1 s, 2 s, 4 s), and again when the network comes back. Nothing plays while the page is hidden.

## Asset loading

The card sprite sheet is the one download play cannot start without, so it goes first and everything else waits on it:

- `index.html` preloads the sheet at high priority. `sprite-atlas.js` loads it once through that preload (one request), decodes it off the main thread, and checks a pixel of the card back before calling it ready, so a truncated or wrong file counts as a failure rather than an invisible board.
- Music is created with `preload="none"` and starts buffering once the sheet has settled. The first tap still unlocks audio as before: `play()` inside the gesture loads a track just as well.
- The service worker registers once the sheet has settled (10 s at most), so its 8 MB precache never shares a cold connection with it.
- Starting a game (New Game, Play Again, Continue) waits for the art. If it is ready, as it is on every warm visit, the board starts immediately. If not, a small **Loading cards** dialog appears; after 12 s it offers **Try again** alongside waiting. If the sheet fails (missing, unreachable or undecodable) it says so, and says when the device is offline, and offers **Try again**. **Cancel** or Escape backs out to the picker, and a sheet arriving afterwards starts nothing. The board, its clock and the memorize preview start only once the art can be drawn, so no memorize time is spent looking at blank cards.

The sheet ships as the original PNG. A lossless WebP of it is 28% smaller (1.44 MB) and pixel-identical, but producing it needs libwebp's `cwebp` (Chromium's own lossless encoder only reaches 1.90 MB), and the build has no way to check a derivative still matches the PNG. Lossy WebP changes pixels. So no derivative is shipped. `npm test` runs the source-level checks (responsive/gameplay, release-candidate audio/scoring/app-shell, `dist/` parity) and then the rendered-behavior suite described below. `npm run dev` serves the built app at `http://127.0.0.1:4173` for browser testing.

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
- **Card sprites.** The measured rectangles in `sprite-atlas.js` are checked against the shipped PNG: each is tight around its sprite, its padded crop holds every visible pixel and overlaps no other sprite. Then every side of every board, on phones at 2x, 3x and 4x and desktop at 1x and 150%, must be painted with the dealt sprite into a bitmap the size of its card box at the device pixel ratio (capped at 3x), with nothing outside the crop or on the bitmap edge, the visible extent matching the sprite's extent in the sheet, pixels equal to a direct render of the crop, and close to the old fixed 600x775 render. Repeated new games must paint each side exactly once, resample the sheet only for crops not cached yet, release the replaced board's bitmaps immediately and never repaint on their own; resizes and pixel-ratio changes repaint at the new size; the crop cache stays bounded; and boards replaced while the sheet is still downloading are not painted when it arrives.

- **Asset loading.** A cold-cache first visit on a phone and a desktop must fetch the sheet once, start music and register the worker only after it arrives, deal a fully painted board, and end with the sheet in the worker's cache. The first tap must still start the intro and request both music loops while the sheet is held back. With the sheet delayed, a start must show the loading dialog (checked for fit on a small phone and a zoomed desktop) with no board, clock or preview, then deal a painted board with its full memorize time, counted once. A stalled sheet must offer a retry that starts the board. Escape and Cancel must back out without a game starting later. Continue must wait the same way and resume without a preview. A missing (404), unreachable, truncated or blank sheet must show the failure dialog with Try again focused, report the failure in the console, and recover on retry. An offline first visit must say it is offline. And a deploy missing the sheet must fail its worker install, naming the sheet, and leave the page uncontrolled. The offline suite additionally requires the offline board to show its card art.

- **Lifecycle.** In a real browser, with page visibility under the suite's control and every timer callback counted:
  - Pausing with Escape during the memorize preview freezes its countdown, keeps the full memorize time and scores none of it.
  - Pausing during a match, or during a mismatch's study time, freezes the turn; resuming continues the study time rather than skipping it.
  - A hidden page freezes the turn and the score clock, and coming back opens the pause dialog.
  - No timer fires at all while the game is paused or hidden.
  - Score time is accurate to the second, excludes paused time, and is exactly the time scored at completion.
  - Rapid taps open one card, a third and fourth card are refused while a pair resolves, and rapid pause toggling ends consistent.
  - Restarting mid-turn or mid-preview leaves nothing behind for the old board.
- **Service worker.** The cache is named for its scope. Requests outside the scope are not answered by the worker. An uncached track is range-served and warmed into the cache with exactly one full download for several racing range requests. Offline, the track answers every spelling of its name, and 416 for an unsatisfiable range. A new version installs and waits, survives a reload, and activates on a cold start. Activation clears this app's older and legacy caches but not another scope's.

Narrow a run while iterating with `--suite=desktop,intro,mobile,offline,sprites,loading,lifecycle`.

### Checking loading by hand

The `loading` suite automates these; to see them in a browser, serve the build with `npm run dev` and open DevTools:

- **Cold cache.** Application → Storage → *Clear site data*, then reload with Network → *Disable cache*. The sheet should be one of the first requests; the two MP3s and `sw.js` should start only after it finishes.
- **Slow network.** Keep the cache disabled, set Network throttling to *Slow 4G* or *3G*, reload, and start a game at once. The **Loading cards** dialog appears and the board, clock and memorize countdown start only when it closes; leave it over 12 s and **Try again** appears.
- **Missing sheet.** Network → right-click the sheet → *Block request URL*, reload, start a game: the failure dialog appears with **Try again**. Unblock and press it, and the board starts.
- **Offline launch.** Load once online and wait for Application → Service Workers to show *activated*, then tick *Offline* and reload. A game starts with no dialog and every card painted. To check the honest-failure path, block the sheet before the first load: the worker install fails (`[DEJA VU] precache install-failed` in the console) and nothing is activated.

`npm run measure:sprites` reports Insane-board creation time (cold and warm, Chromium's main-thread task time) and canvas memory for a phone and two desktop profiles. `--dist=<other checkout>/dist` measures another build with the same harness, `--runs=N` sets the sample count, `--cpu=4` adds CPU throttling. It runs in headless desktop Chromium: the phone profile reproduces a phone's viewport and pixel ratio, not a phone's CPU, GPU or memory.

The suite needs a Chromium build. `npx playwright install chromium` provides one; an existing binary works via `DEJA_VU_CHROMIUM=/path/to/chrome`. `DEJA_VU_SKIP_BROWSER_TESTS=1` skips it, which leaves rendered layout and offline behavior unverified — not a substitute for running it before a release.

## Offline install

**First-online-load requirement: the app must be opened once over the network before it can run offline.** That first load registers `sw.js` (as soon as the card art has arrived, so the two never compete for a slow connection), which precaches the entire app shell — HTML, CSS, JavaScript, the card sprite, the logo, every icon, the intro video, and both music tracks — into one versioned cache. Offline play is available as soon as that install finishes; the worker claims the first page, so no second visit and no reload are needed. If the connection drops mid-install, nothing is activated and the next online load starts over.

After that, everything works with no network: navigation returns the cached shell for any same-origin path or query string under the app's scope, and the cached MP4 and MP3s answer byte-range requests out of the cache, so media seeks and mobile playback work offline too.

Other behavior worth knowing:

- **Updates apply on the next cold start.** A new `sw.js` precaches into a new cache and then waits, so one page session is always served by a single cache generation and never mixes old and new assets. Close the app (or all tabs) and reopen it to pick up a new version; reloading a tab deliberately does not hand over.
- **Bump `CACHE_VERSION` in `sw.js` for every deploy.** The cache name derives from it and from the worker's scope (`deja-vu-<version>@/DEJA-VU-MEMORY-GAME/`), and on activate this app's older generations are deleted: same-scope names, plus the unscoped `deja-vu-v1.x.x` names used before v1.5.0. `npm test` pins the current value so a release cannot forget it.
- **Scope isolation.** Every GitHub Pages project site of an account shares one origin and one Cache Storage. The worker only answers requests inside its own scope, and only ever deletes its own caches, so another site on the same origin is untouched.
- **Media warming.** A track that is not cached yet (say its precache failed) is range-served from the network while one full copy is downloaded into the cache for next time. That download happens once per file, however many range requests a media element makes, and `event.waitUntil` keeps the worker alive until it is stored. Cached tracks answer every spelling of their name (`%20` or a space, `%28` or `(`), and unsatisfiable ranges answer 416.
- **A missing optional asset does not break the install.** Media and decorative artwork are precached, but a failure there is reported and retried on demand instead of aborting. Required are the HTML, CSS, JavaScript, manifest, and the card sprite sheet, since no board can be drawn without it. Required entries are fetched first and the media only once they are secured. The game stays playable when media fails: audio errors are swallowed and a failed intro video is simply skipped.
- **The precache revalidates rather than re-downloads.** Entries are fetched with `cache: 'no-cache'`: a new generation never stores a stale copy, and on a host that sends `ETag`/`Last-Modified` validators, as GitHub Pages does, a file the page has just downloaded (the sprite sheet on a first visit) comes back as a 304 instead of a second download.
- **Failures are visible in development.** A failed registration logs to the page console, and the worker reports precache problems both to its own console and as a message to any open page.

## Features

- Four board sizes: Easy, Intermediate, Advanced, and Insane
- Original geometric card art from `card-flip-sprite-sheet.png`
- Touch, mouse, and full keyboard controls
- Timer, moves, mistakes, and difficulty-relative scoring (`pairs × 1,000 − mistakes × 350 − gameplay seconds × 5`)
- Working-memory board ratings: EXCELLENT 85–100%, GOOD 70–84%, AVERAGE 50–69%, and POOR 0–49%
- Local autosave with Continue Game
- Persistent statistics and personal bests
- Scene-aware menu/gameplay music with smooth crossfades and persistent volume controls
- Restrained synthesized selection, match, mistake, menu, start, and completion feedback
- Independent, persistent SFX and best-effort haptic controls; vibration availability depends on the mobile browser
- One fixed DEJA VU palette across every screen, with a persistent reduced-motion control
- Installable PWA that plays fully offline after one online load
- INSPIRE click-to-start and skippable intro sequence

## Keyboard controls

- Arrow keys: move between cards
- Enter or Space: flip the focused card
- Escape: pause

## Project structure

- `index.html` — app screens, accessible interface, and social link-preview tags
- `styles.css` — the single colour palette, responsive design, card sprite rendering, and animation
- `index.js` — game rules, screen flow, persistence, statistics, and controls
- `audio-manager.js` — reusable scene music, crossfades, and mobile audio unlock
- `feedback-manager.js` — synthesized UI cues and guarded mobile vibration feedback
- `gameplay-clock.js` — pausable gameplay time: turn and preview timers that freeze with the game, and the score clock
- `sprite-atlas.js` — measured card rectangles in the sprite sheet, and each card side's canvas, painted at the card's real pixel size from a bounded cache of sized crops
- `sw.js` / `manifest.webmanifest` — offline and installable web app support
- `scripts/build-dist.mjs` — deterministic `dist/` build and parity validation
- `scripts/serve-dist.mjs` — dependency-free local static server with media range support
- `scripts/verify-responsive.mjs` — dependency-free viewport, input-flow, and accessibility regression checks
- `scripts/verify-release-candidate.mjs` — dependency-free scoring, audio, haptics, and app-shell audit
- `scripts/verify-browser.mjs` — rendered layout, viewport-fit, offline and service-worker, card sprite, asset loading, and gameplay lifecycle regression suite
- `scripts/generate-icons.mjs` — regenerates the PWA icons from the card back in the sprite sheet
- `scripts/browser-harness.mjs` / `scripts/browser-probes.js` — Chromium discovery, subpath test server, and the in-page measurement helpers
- `scripts/sprite-probes.js` / `scripts/measure-sprite-atlas.mjs` — canvas instrumentation and sprite crop checks for the browser suite, and the sprite cost meter
- `scripts/mobile-layout-baseline.json` — recorded phone and tablet geometry the suite guards
- `Deja-Vu-Banner.png` — Open Graph / Twitter Card image used when the site link is shared

Built by [INSPIRE](https://www.inspireclothing.art).
