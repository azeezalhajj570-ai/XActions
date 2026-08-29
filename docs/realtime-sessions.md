# XActions Extension Agent — Realtime Sessions

How the Chrome/Edge extension replaces the old console-paste agent for
dashboard-driven operations on x.com.

## Flow

```
Dashboard                          Backend                        Extension
   │  socket (role: dashboard)         │                              │
   ├──────────────────────────────────►│  session created +           │
   │  session:created { pairingCode }  │  pairing code issued         │
   │◄──────────────────────────────────┤                              │
   │                                   │    user opens x.com + popup, │
   │                                   │    enters pairing code       │
   │                                   │◄──── POST /api/pairing/claim │
   │                                   │      { pairingCode, username }│
   │                                   │───── sessionId ─────────────►│
   │                                   │◄──── socket (role: agent) ───│
   │                                   │      auth: { pairingCode }   │
   │  agent:connected { account }      │                              │
   │◄──────────────────────────────────┤                              │
   │  start:operation                  │                              │
   ├──────────────────────────────────►│                              │
   │                                   ├── execute ──────────────────►│
   │                                   │                    service worker
   │                                   │                    → bridge → injected
   │  progress / action / complete     │◄─────────────────────────────│
   │◄──────────────────────────────────┤                              │
```

## Pairing

- The dashboard socket connection creates a session and a **pairing code**
  (8 hex chars, 10-minute TTL), delivered in `session:created`.
- The user enters the code in the extension popup. The service worker claims
  it with `POST /api/pairing/claim` (the code is the credential — no JWT in
  the extension), sending the X account detected on the tab.
- The agent socket then connects with `auth: { role: 'agent', pairingCode }`.
  The code is single-use: after the socket consumes it, reconnects use
  `auth: { role: 'agent', sessionId, username, agentType: 'extension' }`.
- The backend binds one live agent per session. A newer registration replaces
  a stale one (`agent:replaced`), so duplicate tabs/extensions never leave two
  active agents.

## Backend API

| Endpoint | Purpose |
|---|---|
| `GET /api/pairing/info` | Reports pairing is enabled and the backend URL the extension should use |
| `POST /api/pairing/claim` | Claims a session with a pairing code + X account |

## Events (unchanged contract)

- Dashboard → server: `start:operation { operation, config }`, `stop:operation`
- Server → agent: `execute { operation, config }`, `stop`
- Agent → server: `progress`, `action`, `complete`, `error`
- Server → dashboard: `session:created`, `agent:connected`, `agent:disconnected`,
  `operation:started`, `progress`, `action`, `complete`, `error`
- Extension-only: `agent:tab-closed` (tab closed while socket is up),
  `agent:replaced` (a newer agent took over)

The legacy console-agent path (`auth: { role: 'agent', sessionId }`) still
works for compatibility, but the extension is the supported agent.

## Extension side

- `extension/background/agent-connection.js` — the single Socket.IO client
  (service worker is the networking boundary; the page never sees it).
- `extension/background/service-worker.js` — message dispatch
  (`AGENT_PAIR`, `AGENT_CONNECT`, `AGENT_DISCONNECT`, `AGENT_STATUS`,
  `AGENT_BRIDGE_MESSAGE`), tab-close handling, restart restore.
- `extension/content/bridge.js` / `injected.js` — unchanged automation
  execution; injected.js now answers `AGENT_CONNECT` with the account info.
- The socket.io-client UMD bundle is vendored into the extension by
  `npm run build:extension` (`extension/build.js`) — no CDN load.

## Local development

1. Run the backend: `npm run dev` (port 3001).
2. Build the extension bundle: `npm run build:extension`.
3. Load `extension/` unpacked in Chrome/Edge.
4. In the popup **Settings** tab, set the backend URL to `http://localhost:3001`.
5. Open the dashboard, click **Connect Browser**, copy the pairing code.
6. Open x.com (signed in), open the popup, paste the code, click
   **Connect to Dashboard**.

## Production

- Set `API_URL=https://xactions.azeez-tech.com` (or your backend origin) on
  the server; it is returned by `GET /api/pairing/info` and included in the
  claim response.
- Add your backend origin to:
  - `extension/manifest.json` → `host_permissions` (the service worker needs
    to reach it).
  - `api/realtime/socketHandler.js` → the Socket.IO CORS origin list.
- The dashboard loads its Socket.IO client from `/vendor/socket.io.min.js`
  (served by the same app), so no CDN allowlist is needed in the CSP.
