# INSPIRE analytics

Optional PostHog events use the existing gameplay transitions: game_opened, game_started, game_progress (25/50/75%), game_completed, high_score_achieved, and error_encountered. Scores, recorded durations, and existing mode/difficulty are reported when present. No achievement system is added.

Capture is deferred and best effort. Offline and Global Privacy Control suppress requests. Failures are swallowed; no retries, SDK, analytics storage, person profiles, replay, raw errors, URLs, deck contents, or saved game IDs are transmitted. Common properties include brand, game, game_version, anonymous page session, occurrence time, and event sequence.

Service-worker shell includes the analytics module and preserves offline play. Routine CI traffic is isolated from production analytics. Regression validation: npm test and npm run test:analytics; production parity: npm run check:dist. See PR #12 for independent browser validation and PostHog QA evidence. The analytics dashboard contains QA data and must not be interpreted as production player statistics.
