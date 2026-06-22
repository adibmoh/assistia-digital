WorldCup PWA v40 — cache-busted scorer display

Fixes:
- index.html loads app.js?v=40 and styles.css?v=40 to avoid stale browser cache.
- sw.js v40 no longer caches app.js/styles.css aggressively.
- Mikel Oyarzabal appears under T-3.
- Only rank 1 is green/highlighted; T-2 and T-3 are neutral.

Replace all files in:
assistia-digital/worldcup-at-a-glance/

After deploy:
- Desktop: Ctrl + F5.
- If still old, unregister service worker once.
