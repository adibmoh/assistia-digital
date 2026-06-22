WorldCup at a Glance — Reliable Mode v1

Clean rebuild with no manual player/date touches.

Rules:
- No hard-coded fixtures.
- No hard-coded fixture date corrections.
- No hard-coded player stats.
- No hard-coded scorer/assist/MVP lists.
- No service worker cache.
- Refresh fetches source data with cache: no-store.

Automatically updates if the source provides:
- schedule
- live status
- results/scores
- standings
- scorer/assist/MVP events

If a stat is not in the source, the app says unavailable instead of showing manual data.
