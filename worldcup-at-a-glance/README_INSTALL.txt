WorldCup at a Glance — Mobile App / PWA v24

Replace/add these files in:
assistia-digital/worldcup-at-a-glance/

Required:
- index.html
- app.js
- styles.css
- manifest.webmanifest
- sw.js
- assistia-logo.png
- icon-192.png
- icon-512.png
- apple-touch-icon.png

After upload/push:
1. Open https://assistia.digital/worldcup-at-a-glance/ on your phone.
2. Android Chrome: tap ⋮ menu → Add to Home screen → Install.
3. iPhone Safari: tap Share → Add to Home Screen.

Important:
- Installable PWA works only on HTTPS, so test from the live site, not file://.
- After replacing files, hard refresh once on desktop with Ctrl + F5.
- If old cache remains, open browser DevTools → Application → Service Workers → Unregister, then reload.
