## Offline install

**First-online-load requirement: the app must be opened once over the network before it can run offline.** That first load registers `sw.js` (as soon as the card art has arrived, so the two never compete for a slow connection), which precaches the entire app shell — HTML, CSS, JavaScript, the card sprite, the logo, every icon, the intro video, and both music tracks — into one versioned cache. Offline play is available as soon as that install finishes; the worker claims the first page, so no second visit and no reload are needed. If the connection drops mid-install, nothing is activated and the next online load starts over.

### Installing for offline play

1. Open the site once with a working connection and let it finish loading. The precache is 36 entries, about 8.2 MB, most of it the two music tracks and the card sprite.
2. Wait a moment for the install to complete. In DevTools this is Application → Service Workers showing **activated**, and Application → Cache Storage holding a `deja-vu-<version>@/DEJA-VU-MEMORY-GAME/` cache with 36 entries. On a local network this takes well under a second; on a slow connection it is bounded by downloading those 8.2 MB.
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

## Progress tracking

Durable progress for achievements, recorded from gameplay. It lives under its own key, `inspireDejaVu:v1:progress`, apart from the legacy statistics, which are still kept exactly as before.

**Runs and sessions.** A *run* is one game from the deal to completion or abandonment. Its `runId` is saved with the game and survives saves, reloads and Continue. The `sessionId` remains per page, cleared from saves and replaced on Continue. A save from before run ids gets one when it is continued. Its match chain is only known from then on.

**Events.** `index.js` reports what its rules decide; nothing is inferred from the board:
- `deja-vu:match` when a pair resolves, and `deja-vu:mismatch` when a mistake is made. Both carry `runId`, `difficultyKey`, the cards, `moves`, `mistakes`, `matchedPairs`, `chain` and `bestChain`.
- `deja-vu:completion` keeps its existing fields and adds `runId`, `pairs`, `moves`, `mistakes`, `perfect`, `elapsed`, `elapsedMs`, `bestMatchChain`, `finalMatchChain` (the chain the board was finished on), `completedAt` and `day` (local `YYYY-MM-DD`).
- `deja-vu:run-abandoned` and `deja-vu:statistics-reset`.

A match chain is the number of consecutive matches since the last mistake.

**The record** (`progress-model.js`, version 2, validated on every read):
- Lifetime and per-difficulty totals: wins, perfect wins, matched pairs, earned score, active play time of completed runs, best match chain, and the current and best run of consecutive perfect wins.
- A daily win streak by the device's local calendar.
- A ledger of the last 100 recorded run ids.
- The achievements: what is unlocked, when and by which run, and the per-run bests their progress is measured on (see below). A win and what it unlocks are saved in the same write.

A damaged field is repaired on its own. A record from a newer build is never overwritten.

**The rules** (`progress-evaluator.js`, pure):
- Only completed runs are credited, once each by `runId`; a replayed completion changes nothing.
- Each completion is checked against the game's rules first, including its score recomputed by `runtime-config.js`'s `calculateScore`.
- A perfect win extends the consecutive-perfect streak and an imperfect win ends it.
- The first win on a local calendar day extends the daily streak if the previous winning day was yesterday, and starts a new one otherwise. More wins the same day count once, and a day without a win breaks it. Days are counted by calendar, so daylight-saving days and time-zone travel are handled; a win dated before the last winning day leaves the streak alone.
- **Abandonment:** a run is abandoned only when a new game replaces it. Leaving for the menu, reloading or closing the page keeps it resumable. An abandoned run earns nothing and is added to the ledger, so it can never complete later. If it already had a mistake it ends the consecutive-perfect streak; a clean one does not, so walking away cannot protect a streak.
- **Reset:** Reset statistics also clears every progress total and streak, but keeps the ledger, so an old event still cannot count.

**Storage** (`progress-tracker.js`):
- Every update re-reads the stored record, so another tab's progress is built on, not overwritten.
- A record that is not a record is copied to `inspireDejaVu:v1:progress:corrupt` before being replaced.
- If storage is unavailable, refuses writes (a full quota) or holds a newer build's record, progress is kept in memory for the session. Unsaved progress is written in full once storage accepts it again.

**Migration.** On first load the record is seeded from the legacy statistics: earlier wins and perfect games count toward lifetime totals and are marked as `legacy`. Per-difficulty counts, pairs, score and time start from zero, since the old record never had them. A version-1 record (from before achievements) is carried over as it is and backfilled once; an older build that meets a version-2 record leaves it alone. `save-integrity.js` accepts saves with or without the new run fields and validates them when present. `stats-integrity.js` only ever rebuilds the statistics key, so it cannot touch progress.

## Achievements

Exactly 100, defined in `achievement-catalog.js` and shown on the **Achievements** screen from the main menu (see *On screen* below). `getAchievements()` from `progress-tracker.js` lists them all, and `deja-vu:achievements-unlocked` announces new unlocks with their names.

Each has a permanent `id`, a DEJA VU-themed `name`, a plain `requirement`, a `category` and a `threshold`. The list adds the player's `value` (the current measure, or `null` before anything counts), `progress` (0 to 1, and 1 once unlocked), `unlocked`, `unlockedAt` (ms), the `runId` that earned it, and `backfilled`. An id is never renamed or reused, because unlocks are stored under it.

| Category | Count | Requirement |
|---|---|---|
| Lifetime wins | 15 | Win 1, 3, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1,000 games |
| Difficulty wins | 20 | Win 1, 5, 10, 25, 50 games on each of the four difficulties |
| Perfect wins | 10 | Win 1, 2, 3, 5, 10, 20, 35, 50, 75, 100 games without a mistake |
| Matched pairs | 10 | Match 25 to 10,000 pairs in games you win |
| Speed | 10 | Win a board within a time, with at most a third as many mistakes as it has pairs |
| Score | 10 | EXCELLENT on each difficulty; 95% in one game; 5,000, 10,000 and 14,000 in one game; 100,000 and 500,000 earned in total |
| Perfect streaks | 10 | Win 2 to 25 games in a row without a mistake |
| Daily streaks | 10 | Win on 2 to 100 days in a row |
| Challenges | 5 | Flawless Insanity (a perfect Insane game), Unbroken Thread (a 12-match chain), Perfect Prism (a perfect game on every difficulty), Four Rooms, One Day (every difficulty won on one day), Lightning Recall (a perfect Advanced game in 30 s) |

**Thresholds come from the game itself.**
- **Speed:** each tier is a time budget per pair on the real board. Easy and Intermediate get 5 s and 3.5 s per pair; Advanced and Insane also get 2.5 s. That gives Easy 30/21 s, Intermediate 40/28 s, Advanced 50/35/25 s and Insane 75/52/37 s. The mistake limits are 2, 2, 3 and 5.
- **Score:** each single-game score is the score of a stated reference game, worked out by `runtime-config.js`'s `calculateScore`. 5,000 is an Easy game with 2 mistakes in 60 s, 10,000 an Insane game with 10 mistakes in 5 minutes, and 14,000 a perfect Insane game in 200 s. EXCELLENT is the runtime's own band.
- **Times** are gameplay seconds, so the memorize preview and pauses never count.
- **Attainability:** `npm run test:achievements` models a player clicking each card at a deliberate 450 ms with animations on, using index.js's real match, mismatch-study and flip-back delays. Every speed goal is within reach even with every allowed mistake, and every score reference is playable. A simulated career of valid completions at that pace unlocks all 100. The browser suite plays a perfect Insane board at full animation timing and reaches the fastest Insane goal.

**Rules** (`achievement-evaluator.js`, pure):
- **When it runs.** Achievements are evaluated only when a completion has just been recorded: valid, and new by its `runId`. They are also evaluated once when a record is created or carried over from version 1. Matches, mismatches, abandoned runs and resets can raise nothing, so they never trigger an evaluation.
- **Award once.** Each achievement is awarded once, stamped with the completion's time and run, and never changed afterwards. A replayed completion, before or after a reload, is refused before it gets here.
- **No reward for spam or worse play.** No measure counts moves, mistakes or time upward. Speed goals ignore wins over their mistake limit, so mashing cards quickly never qualifies. Score goals use the game's own scoring. The tests check that a worse game (more mistakes, more time) never unlocks or advances anything a better one would not.
- **Reloads.** Reloads earn nothing. Continue never replays the memorize preview, and a mistake is saved before the page unloads, so a reload mid-turn cannot erase it.
- **Perfect** means no mistake. A *chain* is consecutive matches since the last mistake, and only chains in games you win count. A perfect game is one chain of all its pairs.
- **Reset statistics** clears progress toward achievements, but never takes back one already unlocked. Unlocked ones show as complete; locked ones measure from the reset.

**Backfill** (once, when a record is created or migrated). Only what earlier history proves is credited, marked `backfilled` with no `runId` and the time of the backfill:
- **A version-1 record's totals and streaks**, which were tracked as they happened.
- **The legacy statistics' win and perfect-game counts.**
- **Each difficulty's best entry**, which proves a win there and its fewest mistakes.
- **The legacy best score.** The old record keeps each best (time, mistakes, score) separately, possibly from three different games, so only the best score describes one whole game. With the game's scoring and the other two bests, it bounds that game's mistakes and time. What every such game has in common is proven: for example, a best Easy score of 5,900 proves a perfect game of at most 20 s.

No per-difficulty win count, pair total, streak or day is invented. A legacy Insane best can unlock *Win an Insane game*, but *Win 5 Insane games* counts tracked wins only.

### On screen

`achievements-ui.js` and `achievements-ui.css` present the achievements; they only read what the tracker reports. They load as their own module, so if they ever fail to load the game still plays and still records achievements, and the screen says it could not be shown.

- **The Achievements screen** (main menu → Achievements) is a panel like Statistics, with the menu music.
  - It shows *N of 100 unlocked* with a progress ring.
  - **Category filters** cover all nine categories, plus All / Unlocked / Locked. They are toggle buttons with their pressed state exposed; arrow keys move along a row, and each change is announced ("Showing 6 unlocked Speed achievements").
  - **Every achievement** shows its badge, name and plain requirement. An unlocked one shows its unlock date; one proven from earlier games says so ("From earlier games · recorded …"). A locked one shows its progress as text ("4 of 10 won", "Best 59 s · goal 37 s") and a bar.
  - **Badges** are inline SVG from one sprite, with a glyph and colour per category and a lock while locked. Nothing is downloaded, so the screen works with the card art missing and offline.
- **The results** of a game that unlocked something carry a highlight line: the badges and names, one line on short desktop windows. It is part of the dialog's description for screen readers and never moves focus from *Play Again*.
- **Unlock notices** are small toasts.
  - They never take focus, and never cover the board or a result. They wait while a game, the start or intro screen, any dialog, or a hidden page is showing. A notice on screen when one of those appears is taken down and shown again later in full.
  - Unlocks already highlighted in the results are not repeated as a notice. Notices appear for runs whose results were never shown (leaving a finished board before its results open), and once, after an upgrade, for achievements proven from earlier games.
  - Simultaneous unlocks are one notice. At most three wait, and later unlocks merge into the last one, so a burst neither piles up nor loses anything.
  - Each notice is announced through a polite live region, stays 5 s (held while hovered or focused), and can be dismissed or opened with *View*.
  - A notice sits at the top or bottom edge, whichever covers fewer of the screen's controls, inside the safe-area insets. With reduced motion it appears without sliding.
- **Reset achievements…** at the end of the screen opens a dialog titled *Reset achievements?*. It says how many unlocks will be locked again, that all progress toward them is cleared, and that statistics and personal bests are not changed. It opens on *Keep achievements*, and Escape cancels.
  - Confirming locks every achievement and clears the totals, streaks, bests and days they are measured on. The run ledger is kept, so an old completion cannot count again, and nothing is backfilled again.
  - **Reset statistics** keeps its own meaning: it clears statistics and progress totals but never takes back an unlocked achievement. Its confirmation now says so.

## Asset loading

The card sprite sheet is the one download play cannot start without, so it goes first and everything else waits on it:

- `index.html` preloads the sheet at high priority. `sprite-atlas.js` loads it once through that preload (one request), decodes it off the main thread, and checks a pixel of the card back before calling it ready, so a truncated or wrong file counts as a failure rather than an invisible board.
- Music is created with `preload="none"` and starts buffering once the sheet has settled. The first tap still unlocks audio as before: `play()` inside the gesture loads a track just as well.
- The service worker registers once the sheet has settled (10 s at most), so its 8 MB precache never shares a cold connection with it.
- Starting a game (New Game, Play Again, Continue) waits for the art. If it is ready, as it is on every warm visit, the board starts immediately. If not, a small **Loading cards** dialog appears; after 12 s it offers **Try again** alongside waiting. If the sheet fails (missing, unreachable or undecodable) it says so, and says when the device is offline, and offers **Try again**. **Cancel** or Escape backs out to the picker, and a sheet arriving afterwards starts nothing. The board, its clock and the memorize preview start only once the art can be drawn, so no memorize time is spent looking at blank cards.

The sheet ships as the original PNG. A lossless WebP of it is 28% smaller (1.44 MB) and pixel-identical, but producing it needs libwebp's `cwebp` (Chromium's own lossless encoder only reaches 1.90 MB), and the build has no way to check a derivative still matches the PNG. Lossy WebP changes pixels. So no derivative is shipped. `npm test` runs the source-level checks (responsive/gameplay, release-candidate audio/scoring/app-shell, progress, achievements, `dist/` parity) and then the rendered-behavior suite described below. `npm run dev` serves the built app at `http://127.0.0.1:4173` for browser testing.

## Rendered-behavior tests

`npm run test:browser` drives the built app in real Chromium and measures what a player would see, rather than matching source text or recomputing board maths. It serves `dist/` from a GitHub Pages-shaped subpath (`/DEJA-VU-MEMORY-GAME/`) so relative paths, manifest scope, and service-worker scope are exercised the way the hosted site uses them.

It covers:

- **No horizontal overflow** on any screen or dialog, checked on the document, `body`, `#app`, and the active view.
- **Essential text and controls reachable.** Each view declares the elements a player must be able to read or press; every one must be rendered, inside the available width without horizontal scrolling, reachable by vertical scrolling, and not covered by anything else. Buttons and inputs additionally have to be hit-testable and inside the viewport once scrolled to.
- **Views that must fit outright.** The start and intro screens have no scroll container. On desktop the menu, the board and every modal must fit the window without scrolling, including the results with an achievements highlight and the *Reset achievements?* confirmation. Only the long-form panels (statistics, help, settings, achievements) may scroll.
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

- **Progress.** Real games end to end:
  - A perfect win reports its run in full and is credited lifetime and to its difficulty, with the legacy statistics still kept; a duplicate completion event, before and after a reload, changes nothing.
  - Continue after a reload keeps the run id and its match chains through to completion.
  - An old save and old statistics migrate: the record is seeded, and the save gets a run id on Continue.
  - Replacing a clean run, or one with a mistake, is handled as abandonment.
  - Wins in America/Los_Angeles are dated by the local day, with a second win the same day, the next day and a missed day.
  - A corrupt record is kept aside and replaced, and with storage denied entirely the game still completes and is tracked for the session.
  - A first win unlocks its achievements stamped with its run and time, announced once; all 100 are listed with progress; a replay, before or after a reload, awards nothing.
  - A perfect Insane board with animations on reaches the fastest Insane speed goal and the top score goals.
  - Reloading during a mismatch's study time keeps the mistake, so that win earns no perfect achievement.
  - Old statistics backfill exactly the achievements they prove, without per-difficulty counts.
- **Achievements UI** (`--suite=achievements`):
  - **Phones and tablets** (all seven mobile viewports): the menu, the Achievements screen, the reset confirmation and results with unlocks are fully reachable. The confirmation opens on *Keep achievements*, and Escape cancels it. A notice over the menu covers no menu button, takes no focus, is announced, stays inside simulated safe-area insets, and is not shown with the results.
  - **Awards in play:** a real Easy win highlights exactly its unlocks without moving focus, and does not repeat them as a notice. The screen then shows them with the run's date, plays the menu music, and filters by state and category, also from the keyboard.
  - **Continue** after a reload earns at completion under the original run id.
  - **A finished board left before its results** gets one notice instead; *View* opens the screen. A dialog withdraws a notice, which returns in full. A burst of 16 unlocks while the board is up arrives as at most three notices with none lost.
  - **Repeated restarts and rapid input:** five rapid restarts earn and show nothing. *Play Again* clears the previous highlight, and each game highlights only its own. Mashing the board as the last pair resolves completes it once. Sixty rapid filter clicks settle consistently.
  - **Reset:** *Keep* changes nothing. Confirming clears unlocks and their progress, keeps the ledger and leaves statistics byte-identical, then announces the reset and returns focus. A later statistics reset still keeps unlocks.
  - **Migration:** old statistics produce one *From your earlier games* notice, not repeated after a reload, and the screen marks those rows.
  - **Missing assets:** with `achievements-ui.js` blocked, a game still completes and records achievements. With the card art blocked, all 100 badges draw with no download.
  - **Motion:** notices slide with animations on and appear without motion under reduced motion.
  - **Offline**, in the offline suite: a win unlocks achievements, highlighted in its results, and the Achievements screen renders from the cache.

Narrow a run while iterating with `--suite=desktop,intro,mobile,offline,sprites,loading,lifecycle,progress,achievements`.

`npm run test:progress` covers the record, the evaluator and storage handling directly in Node:
- field-by-field repair, records from newer builds, the bounded ledger, calendar days (leap days, year ends, both daylight-saving changes, other time zones) and the legacy seed;
- every refusal reason, perfect and daily streaks, abandonment and reset;
- reload, duplicate, corrupt, newer, denied and full storage;
- confirmation that the two integrity guards keep progress and migrate saves.

`npm run test:achievements` covers the achievements in Node:
- **The catalog:** exactly 100, in the requested allocation, with stable unique ids and names and plain requirements.
- **Thresholds:** derived from board sizes, scoring and turn timings, and attainable at a human pace.
- **Boundaries:** each threshold met exactly at its edge and not one step short.
- **Award once:** duplicates and resets.
- **No reward for spam or worse play.**
- **Backfill:** legacy-statistics proofs, version-1 migration, and idempotence.
- **Tracker storage:** unlock events, reload, reset, migration, newer records and a full quota.
- **Resetting achievements:** unlocks, bests and the totals they stand on start over; the ledger stays; statistics are untouched; the next new win earns again.

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

## Device checks (manual)

The automated suites run in desktop Chromium, with phones emulated by viewport, pixel ratio and touch. They cannot show how a real phone's browser installs the app, evicts storage, routes audio, draws safe areas or speaks to a screen reader. The checks below need real devices. They are kept apart from the automated results on purpose: a passing `npm test` says nothing about them.

**Status for v1.8.0: not yet run on hardware.** Record each run in the table at the end.

**Android (Chrome, installed from *Add to Home screen* / *Install app*)**
1. Open the site online once, wait about 10 s for the worker to activate, then install. Launch from the icon.
2. Turn on airplane mode, force-stop the app, and launch it from the icon. The start screen appears with its art. A tap plays the intro (or skips it) and the menu music starts.
3. Offline, win an Easy game. The results show the achievements it unlocked. Open Achievements: they are listed with today's date.
4. **Audio.**
   - Music starts on the first tap.
   - Switching apps or locking the screen silences it. Coming back opens Pause, and music resumes after *Resume*.
   - Volume sliders and the music and effects toggles survive a relaunch.
   - Sound effects follow the media volume.
5. Haptics: a mismatch vibrates where the device supports it, and *Haptics* off stops it.
6. Notices:
   - Finish a board and tap ☰ before the results open. One notice appears on the menu, clear of the status bar and the gesture area.
   - A notice never appears over a board.
7. TalkBack: an unlock notice is read out; an achievement row reads name, requirement, state and progress; filter buttons announce *pressed*.
8. Rotate to landscape on the menu and the Achievements screen: everything can be reached by scrolling.

**iOS / iPadOS (Safari, *Share → Add to Home Screen*)**
1. Add to the Home Screen while online, open it once from the icon, and wait about 10 s.
2. Turn on airplane mode, remove the app from the app switcher, and launch it from the icon. It loads offline and plays an Easy game to its results.
3. **Audio.**
   - The first tap starts the menu music.
   - It stops when the screen locks or the app is backgrounded, and resumes after *Resume*.
   - Check sound effects with the ringer switch in both positions (Web Audio follows the ringer on some iOS versions; note what happens).
   - Plug in and unplug headphones mid-game: no error, and music continues or pauses cleanly.
4. **Safe areas** on a notched or Dynamic Island device, in portrait and landscape:
   - Notices sit below the status area.
   - The home indicator does not cover *Reset achievements…*, *Play Again* or the board.
5. **Reduced Motion** (Settings → Accessibility → Motion) and the in-app *Reduced motion* toggle: notices appear without sliding.
6. **VoiceOver:**
   - Unlock notices are spoken without moving focus.
   - The results dialog reads its achievements line.
   - Filter buttons announce *selected*.
   - *Reset achievements?* opens on *Keep achievements*.
7. **Storage:** after the app has been unused for more than a week, Safari may evict its storage, including progress and achievements. Note whether they survive on the Home Screen app and in a plain Safari tab.

| Date | Device | OS / browser | Build | Result and notes |
|---|---|---|---|---|
| — | — | — | v1.8.0 | not yet run |

## Features

- Four board sizes: Easy, Intermediate, Advanced, and Insane
- Original geometric card art from `card-flip-sprite-sheet.png`
- Touch, mouse, and full keyboard controls
- Timer, moves, mistakes, and difficulty-relative scoring (`pairs × 1,000 − mistakes × 350 − gameplay seconds × 5`)
- Working-memory board ratings: EXCELLENT 85–100%, GOOD 70–84%, AVERAGE 50–69%, and POOR 0–49%
- Local autosave with Continue Game
- Persistent statistics and personal bests
- 100 achievements with an Achievements screen, category filters, unlock notices and results highlights
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
- `progress-model.js` / `progress-evaluator.js` / `progress-tracker.js` — the versioned progress record, the pure rules that update it, and the event listener that stores it
- `achievement-catalog.js` / `achievement-evaluator.js` — the 100 achievements with thresholds derived from the boards and scoring, and the pure rules that award, backfill, reset and describe them
- `achievements-ui.js` / `achievements-ui.css` — the Achievements screen, inline-SVG badges, unlock notices, the results highlight and the reset confirmation
- `sprite-atlas.js` — measured card rectangles in the sprite sheet, and each card side's canvas, painted at the card's real pixel size from a bounded cache of sized crops
- `sw.js` / `manifest.webmanifest` — offline and installable web app support
- `scripts/build-dist.mjs` — deterministic `dist/` build and parity validation
- `scripts/serve-dist.mjs` — dependency-free local static server with media range support
- `scripts/verify-responsive.mjs` — dependency-free viewport, input-flow, and accessibility regression checks
- `scripts/verify-release-candidate.mjs` — dependency-free scoring, audio, haptics, and app-shell audit
- `scripts/verify-browser.mjs` — rendered layout, viewport-fit, offline and service-worker, card sprite, asset loading, and gameplay lifecycle regression suite
- `scripts/generate-icons.mjs` — regenerates the PWA icons from the card back in the sprite sheet
- `scripts/browser-harness.mjs` / `scripts/browser-probes.js` — Chromium discovery, subpath test server, and the in-page measurement helpers
- `scripts/verify-progress.mjs` — progress record, evaluator, storage and integrity-guard checks
- `scripts/verify-achievements.mjs` — achievement catalog, threshold, evaluator, backfill and storage checks
- `scripts/sprite-probes.js` / `scripts/measure-sprite-atlas.mjs` — canvas instrumentation and sprite crop checks for the browser suite, and the sprite cost meter
- `scripts/mobile-layout-baseline.json` — recorded phone and tablet geometry the suite guards
- `Deja-Vu-Banner.png` — Open Graph / Twitter Card image used when the site link is shared

Built by [INSPIRE](https://www.inspireclothing.art).
