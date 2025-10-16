# The Capitol Wire — Unified Backend (Pushover + Web Push)

This single service keeps your existing Pushover workflow **and** adds Web Push.

## Endpoints
- `POST /ingest` — your extension/shortcut hits this; summarizes + pushes via Pushover and Web Push
- `POST /subscribe` — website sends browser subscription JSON here
- `POST /broadcast` — manual test to push to all subscribers
- `GET /health` — basic health + subscriber count

## Environment Variables (Render → Environment)
- `GEMINI_API_KEY` — for summaries (optional; if unset, falls back to trimmed text)
- `PUSHOVER_API_TOKEN` — optional, keeps old path working
- `PUSHOVER_USER_KEY` — optional, keeps old path working
- `INGEST_SECRET` — required; same secret your extension/shortcut and site send
- `VAPID_PUBLIC` — your VAPID public key
- `VAPID_PRIVATE` — your VAPID private key
- `CONTACT` — e.g. `mailto:alerts@thecapitolwire.com`

## Deploy
1. Push this folder to GitHub.
2. Create/Update your existing **Render Web Service** to use this repo (or create a new one if you want to test first).
3. Add the env vars above and deploy.

## Test
- Subscribe once from your website, then:
```bash
curl -X POST https://YOUR-RENDER-URL/broadcast   -H "Content-Type: application/json"   -H "X-HillPulse-Key: YOUR_SECRET"   -d '{"title":"The Capitol Wire","body":"Test push","url":"https://x.com"}'
```
