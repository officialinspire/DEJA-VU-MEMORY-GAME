# INSPIRE analytics

Optional PostHog telemetry records existing opens, starts/continues, 25/50/75% progress, completion, score/high score, recorded duration, and fresh achievement unlocks. Achievement backfills are not reported as fresh unlocks. The existing 100-achievement catalog, saves, gameplay clock, audio lifecycle and scope-isolated PWA worker are preserved. Error telemetry is categorized and excludes raw messages or stacks.

Capture is deferred, best effort, deduplicated, offline/GPC-safe, without SDK, persistent analytics identity, person profiles or replay. Common properties include brand, game, game_version, anonymous page session and event sequence. No deck, saved run IDs, player names or URLs are sent.

Validation: npm test; npm run test:analytics; npm run check:dist. Browser QA isolates routine traffic and exercises completion, scores, fresh unlocks, saves, mobile and rejected analytics requests. Service-worker cache v1.8.1 includes all latest modules. See PR #12 for exact validation runs and release status. Dashboard data currently contains QA traffic.
