WorldCup PWA v27 — desktop logo fix

Fix:
- Prevents AssistAI logo from appearing as a huge desktop banner.
- Logo remains only as a small top-left header icon.
- Service worker cache bumped to v27.

Replace all files in:
assistia-digital/worldcup-at-a-glance/

Important after deployment:
1. Desktop: Ctrl + F5.
2. If huge logo still appears, unregister old service worker:
   Chrome/Edge DevTools -> Application -> Service Workers -> Unregister
   then reload.
3. Mobile: clear site storage if old PWA cache remains.
