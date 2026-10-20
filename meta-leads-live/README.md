# Meta Lead Ads → Live React Native Feed (PoC)

When someone submits a Meta Lead Ad form (or a lead created with Meta's **Lead Ads Testing Tool**), the lead appears **instantly** in an already-open React Native screen. No pull-to-refresh, no polling, no touching the device.

```
Meta Lead Ad / Testing Tool
        │  (1) POST /webhook   { field: "leadgen", leadgen_id, form_id, page_id, ... }
        ▼
┌───────────────────────────── backend (Node + Express + ws) ─────────────────────────────┐
│ 2. verify X-Hub-Signature-256 (HMAC-SHA256 with APP_SECRET)                              │
│ 3. ack 200 immediately                                                                   │
│ 4. GET graph.facebook.com/{leadgen_id}  → name / email / phone (webhook has IDs only)    │
│ 5. dedupe, store (memory + data/leads.json)                                              │
│ 6. broadcast {type:"lead"} over WebSocket /ws                                            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        │  (7) WebSocket push
        ▼
React Native (Expo) app: useLeadsSocket() → FlatList re-renders, new card highlighted
```

## Why webhooks + WebSocket

Meta's leadgen webhook does **not** contain the lead's answers, only `leadgen_id`. So the server must (a) receive the webhook and (b) call the Graph API to read the lead. The phone can't receive a webhook directly, so the server pushes to it over a persistent WebSocket. This is real push, not polling.

On every (re)connect the server sends a full `snapshot`, and the app auto-reconnects with backoff and on returning to the foreground, so a dropped connection can't lose a lead.

## Repo layout

```
backend/
  server.js                    webhook + Graph fetch + WebSocket + REST (/leads, /health)
  scripts/send-test-webhook.js signed fake webhook for local smoke tests
  .env.example
app/                           Expo app
  App.js                       leads list screen
  src/useLeadsSocket.js        WebSocket hook (reconnect, snapshot, fresh highlight)
```

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env     # fill in VERIFY_TOKEN, APP_SECRET, PAGE_ACCESS_TOKEN
npm start
```

Expose it over HTTPS (Meta requires HTTPS for the callback URL):

```bash
ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000
```

### 2. Meta configuration (one-time)

1. **developers.facebook.com → My Apps → Create app** (type *Business* / Other). Note the **App Secret** (Settings → Basic) → `APP_SECRET`.
2. Add the **Webhooks** product → choose **Page** → **Subscribe to this object**:
   - Callback URL: `https://<your-tunnel>/webhook`
   - Verify token: the same value as `VERIFY_TOKEN` in `.env`
   - After it verifies, subscribe to the **`leadgen`** field.
3. Get a **Page access token** for a Page you admin with `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement` (Graph API Explorer works) → `PAGE_ACCESS_TOKEN`.
4. Subscribe the Page to your app for leadgen:
   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/<PAGE_ID>/subscribed_apps" \
     -d "subscribed_fields=leadgen" -d "access_token=<PAGE_ACCESS_TOKEN>"
   ```
5. You need a Lead Ad **form** on that Page (Meta Business Suite / Ads Manager → Instant Forms). No live ad is needed.

> Meta's UI and permission requirements change occasionally; if a step differs, check Meta's Lead Ads / Webhooks docs.

### 3. Mobile app

```bash
cd app
npm install
# Android emulator reaches your machine at 10.0.2.2 (default). iOS simulator uses localhost (default).
# Physical phone: point at your tunnel or LAN IP:
EXPO_PUBLIC_SERVER_URL=https://<your-tunnel> npx expo start
```

Open it in a simulator or Expo Go. The header pill shows **Live** once the socket is connected.

### 4. Trigger a lead

Open the **Lead Ads Testing Tool**: https://developers.facebook.com/tools/lead-ads-testing
Select your Page and form → **Create lead**. The card appears in the app within a second or so.

## Local smoke test without Meta

```bash
# terminal 1
cd backend && DEV_MOCK_GRAPH=true APP_SECRET=testsecret VERIFY_TOKEN=tok npm start
# terminal 2
APP_SECRET=testsecret npm run test:webhook
```

This sends a correctly signed webhook; `DEV_MOCK_GRAPH` fakes the Graph lookup. **Do not use it for the final demo** – the demo should use the real Testing Tool and a real Page token.

Verified locally: webhook handshake (good token → challenge echoed, bad token → 403), unsigned POST → 401, signed webhook → a connected WebSocket client receives the lead.

## Assumptions

- Meta app is in development mode and I am an admin/tester of the app and Page, so no App Review is needed for `leads_retrieval` with test leads.
- A Lead Ad form already exists on the Page; no real ad spend or live ad.
- The backend is reachable via an HTTPS tunnel during the demo (ngrok/cloudflared); production would use a hosted server.
- Storage is in-memory plus a JSON file (last 500 leads), enough for a PoC. Production would use a database.
- The WebSocket endpoint is unauthenticated (PoC). Production would add a token/auth and use `wss://`.
- Single-tenant: one Page, one feed, every connected client sees every lead.
- Test leads from the Testing Tool contain dummy field values; they display as returned by the Graph API.
- If the Graph lookup fails (e.g. expired token), the lead still appears with a "details unavailable" note so the pipeline stays visible.

## Demo script (Loom #1, ≤ 5 min)

1. Show the app running on the simulator with the empty "Waiting for leads…" screen and the green **Live** pill.
2. Show the terminal with the backend running (and the tunnel).
3. Open the Lead Ads Testing Tool, pick Page + form, click **Create lead**.
4. Without touching the simulator, show the card appearing with a green **NEW** highlight.
5. Create a second lead to show it's repeatable.

## Walkthrough outline (Loom #2)

1. Architecture diagram above: why webhook → Graph fetch → WebSocket.
2. `server.js`: raw-body signature verification, fast 200 ack, `handleLeadgen` (dedupe, Graph retry, normalize, broadcast), snapshot on connect, heartbeat.
3. `useLeadsSocket.js`: connect, snapshot vs. lead messages, backoff reconnect, AppState reconnect, fresh-highlight timers.
4. `App.js`: FlatList rendering, status pill, empty state.
5. Trade-offs and what I'd do for production.
