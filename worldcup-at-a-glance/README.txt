WorldCup Reliable Mode v2 — Refresh Fix

No hard-coded fixtures, dates, scorers, assists, or MVPs.

Fixes:
- Refresh uses a unique _refresh cache-buster for every network request.
- Old UI is cleared before fetching.
- Stats are recalculated from the newly fetched source payload every time.
- Stats sections show refresh number even when source provides no scorer/assist/MVP data.
- No service worker is included.

Replace all files in:
assistia-digital/worldcup-at-a-glance/
