WorldCup PWA v25 fix

Fixes:
- Header logo cannot render huge anymore.
- Standings rows align correctly on mobile.
- Standings mobile row now uses: # | Team | Pts | GD | Status.
- P/W/D/L/GF/GA are hidden on mobile to avoid wrapping.
- Service worker cache bumped to v25.

Replace/add all files in:
assistia-digital/worldcup-at-a-glance/

After deploy:
1. Open the page.
2. Hard refresh desktop: Ctrl + F5.
3. On mobile, if the old view remains: browser menu → site settings/storage → clear, then reopen.
