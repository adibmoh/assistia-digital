WorldCup Golden Boot — Free Source v1

Focuses only on Golden Boot data.

Sources:
1. FIFA public player-statistics page through Jina Reader.
2. FIFA statistics overview through Jina Reader.
3. Jina Search fallback for Golden Boot text.

Rules:
- No hard-coded player names.
- No hard-coded goals or assists.
- No manual Golden Boot table.
- No service worker cache.
- Every refresh fetches fresh public-source text with a cache-buster.

If the public source cannot be parsed, the app shows an error instead of fake data.
