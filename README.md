# Life-Fi

Camera-free presence, breathing and fall alerts from the Wi-Fi already in the
room: an ESP32-S3 reads channel state information (CSI), a Python engine turns
it into conditions, a server turns conditions into alerts, and a dashboard and
a phone show them.

The plan is [docs/plan/plan-v2.md](docs/plan/plan-v2.md). The docs index is
[docs/README.md](docs/README.md).

## Layout

| Folder | What | Status |
|---|---|---|
| `contracts/` | The interfaces between components: result schema, control protocol, HTTP/WS API, profiles, fixtures | done, v2 |
| `server/` | TypeScript (Node 24, Fastify): engine client, REST + WebSocket, alert state machine, watchdog, ntfy, history. Includes a **mock engine** | skeleton running |
| `ui/` | Next.js 16 dashboard, static export served by the server | skeleton running |
| `firmware/` | ESP32-S3 CSI capture (C, ESP-IDF) | not started |
| `engine/` | Python DSP, detectors, models, recording and replay | not started |
| `ml/` | Training and evaluation | not started |
| `docs/` | Plans and research | — |

## Run the portal on mock data

Requirements: Node ≥ 22 (24 recommended) and npm. No Python or Java needed
for the portal.

```bash
npm install
npm run dev
```

That starts three processes: the mock engine on TCP 127.0.0.1:6000, the
server on http://localhost:8080 and the dashboard dev server on
http://localhost:3000. Open the dashboard; the `mock:` button bottom-right
switches scenarios (fall, breath hold, sensor offline, ...).

Useful on their own:

```bash
npm run dev:mock-engine        # only the mock engine (MOCK_SCENARIO=fall to start in a scenario)
npm run dev:server             # only the server
npm run dev:ui                 # only the dashboard
npm run check:contracts        # fixtures validate against the schema
npm test                       # server unit tests
npm run build                  # server to server/dist, dashboard to ui/out
```

Production-style: `npm run build`, then `npm start -w server` serves the
dashboard and the API from one port (8080).

The dashboard PIN for writes defaults to `1234` (`LIFEFI_PIN` or
`data/settings.json`). Phone notifications need an ntfy topic in
`data/settings.json`.

## Where the real engine plugs in

The mock engine speaks exactly `contracts/control.md` on TCP 127.0.0.1:6000
and emits `contracts/results.schema.json`. When the Python engine exists it
takes that port and nothing in `server/` or `ui/` changes.
