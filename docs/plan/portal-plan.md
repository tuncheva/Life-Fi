# Web Portal Plan (server + dashboard)

Owner: Emil. Written 2026-10-27. Internal deadline for the portal: **Wed 2026-10-29**
(Max's split). Final demo day: **Thu 2026-11-05**, TU-Sofia Plovdiv, 3-minute live pitch.

This document is the build plan for the "web portal" part of
[plan-v2.md](plan-v2.md) (§4.5, §4.7, §7, §8, §11). Where it changes a plan-v2
decision, the change is listed in §1 and must be agreed by the team.

---

## 0. Where we are (2026-10-27)

- The repo has **docs only**. `origin/dev` contains one commit from Max
  (README moved to the root). There is no `contracts/`, `engine/`, `server/`
  or `ui/` yet, so nothing blocks starting the portal now.
- Hardware (ESP32-S3), the Python engine and the models are owned by Max,
  Ivan and Tina and will not produce real data before the portal deadline.
  **Everything in the portal runs on mock data until then.**
- EduHack rules (eduhack.bg/rules): teams build the prototype 1–31 Oct with
  mentors, so building now is the expected mode. No rule against pre-event
  code was found. Judging is 25 % each: technical implementation
  ("efficiency of integrating the Google stack and stability of the working
  prototype"), innovation, social value, presentation. Named Google tools:
  Gemini / Gemini API, Google Cloud, Vertex AI, Flutter, Firebase AI Logic.
- Emil's machine has Node 24 and npm. No Java, no Python.

## 1. Decisions proposed here (need team OK)

| # | plan-v2 says | Proposal | Why |
|---|---|---|---|
| P1 | Server is Java 21 / Spring Boot (D1) | **Server in TypeScript (Node 24)**, same responsibilities, same contracts | Max's new split assigns the server to nobody. No Java on the build machine. One language for server + UI, two days to deliver. The engine link is TCP JSON lines, trivial in Node `net`. The contracts (§4.4, §4.5, §4.7) stay byte-identical, so the engine team sees no difference. |
| P2 | H2 file database (D9) | **SQLite file** (`better-sqlite3`), 1 row / 5 s, no raw CSI | Same data-minimisation intent, zero install. |
| P3 | `engine/tools/fakesensor` (Python) feeds the engine | Add a **mock engine** (`server/mock-engine`) that *is* the engine from the portal's point of view: listens on TCP 127.0.0.1:6000, answers the control commands, emits schema-valid results every 0.5 s following scripted scenarios | The mock sits exactly on the engine contract. Server and UI are 100 % real code. When the Python engine exists, it takes port 6000 and nothing in the portal changes. |
| P4 | ntfy for phone alerts (D8) | Keep ntfy. Add **Gemini API** in the server for two non-safety features: a plain-language daily / shift summary for the caregiver, and "explain this alert" (what happened in the minute around it) | Covers the "Google stack" judging criterion honestly: the LLM never decides an alert, it only writes text from the server's own history. Cheap, visible in the demo. |

Not changed: Next.js + TypeScript UI, static export served by the server, the
three profiles, the alert state machine, PIN on writes, the replay banner.

## 2. Repo layout (portal part)

```
contracts/            results.schema.json, api.md, control.md, profiles.yml, fixtures/
server/               Node 24 + TypeScript (Fastify + ws)
  src/engine-client   TCP JSON-lines client, reconnect 1 s, pending cmds with 3 s timeout
  src/alerts          state machine §7.2, reconcile on every result, escalation 2 min
  src/watchdog        no result 10 s / rate < 50 Hz 60 s -> sensor_offline
  src/api             REST §4.7, /ws/live, PIN header on writes
  src/history         SQLite, 1 row / 5 s, retention job
  src/notify          ntfy POST; gemini summaries
  mock-engine/        scenarios: normal, leave_room, fall, fainted, breath_hold,
                      sensor_offline, two_people, warmup, replay
ui/                   Next.js 15 + TS, Tailwind, shadcn/ui, uPlot, canvas heatmap
scripts/run_all       fake | replay | live
```

npm workspaces at the root so `npm run dev` starts mock engine + server + UI.

## 3. Mock data: what "mock" means here

Three layers, used in this order:

1. **Fixtures** (`contracts/fixtures/*.json`): one hand-written result per
   state (empty, present-still, walking, lying, fall, no_breathing, warmup,
   uncertain). Used by UI unit tests and component previews. Validated
   against `results.schema.json` in CI (plan-v2 Phase 1 asks for this).
2. **Mock engine scenarios**: a small state machine that walks through
   fixtures over time with noise (motion jitter, breathing wave as a 14 bpm
   sine + noise, CSI heatmap as 52 x 5 drifting values). Scenario is chosen
   by a dev endpoint `POST /dev/scenario {"name":"fall"}` and a dev panel in
   the UI (hidden outside development). The pitch uses this panel if the
   live sensor fails: plan-v2 §14 already requires a replay fallback.
3. **Recorded replay** (later): when the engine team records a real
   `.csirec`, `replay` feeds the real engine and the mock engine is not
   needed. The UI shows the replay banner in both cases (`source != live`).

## 4. Work list (in order; no dates, one person)

**Phase 1 gate — "fake mode shows live motion in the browser": passed 2026-10-27**
- [x] `contracts/`: `results.schema.json`, `control.md`, `api.md`, `profiles.yml`, fixtures; TS types generated before every `dev`/`build`
- [x] Root npm workspace, `ui/` (Next.js 16), `server/` (Fastify + ws), lint, CI workflow (schema check, generated types up to date, server tests, UI build)
- [x] Mock engine with 12 scenarios, every control command, `get_status`, mock-only `mock_scenario`
- [x] Server: engine client (reconnect, acks, timeouts), `/api/v1/*` as in api.md, `/ws/live`, watchdog -> `sensor_offline`, alert state machine with delay / escalation / reconcile, PIN on writes, ntfy POST, in-memory 5 s history, settings file
- [x] UI: shell, one shared WebSocket with backoff, replay banner, connection-lost banner, calibration / warm-up / uncertain chips, profile switch, state / motion / breathing (wave canvas) / device health / CSI heatmap cards, alert banner with acknowledge, alert history page, settings page, dev panel
- [ ] Post status + chosen technologies in the organisers' shared space (they asked)

**Home page polish + profiles**
- [x] Day timeline (presence / posture bands, motion, alert markers; 1 / 6 / 24 h; from `/api/v1/history` + alerts, live tail)
- [x] Dashboard follows the active profile: Home, Clinic (bed state, posture since, breathing, alerts) and School (occupancy from presence, after-hours flag, no breathing)
- [x] Guided calibration page (duration pick, "leave the room now", countdown, motion warning, outcome from `calibration_job` in Status)
- [x] Source page (live / replay file / speed / loop with the banner; minimal record start / stop; `GET /api/v1/recordings`)
- [ ] Breathing chart on uPlot instead of the raw canvas (axes, 30 s / 5 min)
- [ ] Phone layout check for the alert banner and Home
- [ ] Settings editing from the UI (ntfy topic, PIN change)

**Then: data + demo hardening**
- [ ] History on disk (SQLite vs H2 is still an open team decision; the in-memory store keeps the same query API)
- [ ] Real phone notification from the mock fall through ntfy.sh, with the acknowledge action
- [ ] Labelling page (segments, marks, keyboard shortcuts) on top of `/api/v1/recordings/*`
- [ ] `run_all live` against the real engine once it exists; replay fallback rehearsal
- [ ] Apply Alex's design if it arrives: swap tokens / components, not structure
- [ ] Gemini summaries (P4) once the team agrees

## 5. Working with Alex (design)

Max's rule: Emil builds the structure with default shadcn components, Alex
designs, Emil restyles. To make that work:
- Agree today on the **page list** (Home, Clinic, School, Alerts, Settings,
  Calibration, Labelling) and the **always-visible elements** (replay banner,
  calibration state, health tile, warmup / uncertain). These come from
  plan-v2 §8 and are not optional.
- Alex designs in the shadcn Figma kit, dark and light, phone + laptop.
- Hand-off unit is a page: Emil gets a Figma frame, changes tokens and
  component variants, not structure.
- Wording that must appear somewhere on screen (plan-v2 §7.4, N22):
  "assistive notification, not a medical device; does not replace nurse
  call or emergency services", and the single-occupant assumption.

## 6. Prior art the mentor asked about

- **RuView** (github.com/ruvnet/RuView, MIT; posted by Max on 1.10): Rust
  WiFi-sensing stack on ESP32-S3, claims presence, breathing, fall and
  pose. Its Docker image serves a dashboard on :3000 **with simulated data**,
  which is the same approach as §3 here. It calls itself beta and says its
  vital-sign outputs are unvalidated. Useful as a visual reference for the
  "raw signal to prove privacy" view; its models are not the right fit for
  one single-antenna link (see csi-sufficiency-research).
- Commercial Wi-Fi sensing products (Comcast, Origin / ADT, Cognitive
  Systems) show motion timelines and "home / away", not fall or breathing
  alerts; see business-research.md.

## 7. Open questions for the team

1. P1: OK to build the server in TypeScript instead of Java? (If someone
   wants to own a Spring server, the contracts make that possible later.)
2. P4: OK with Gemini for summaries / explanations as the "Google stack"
   element? Who has a Gemini API key / Google Cloud project?
3. Tina: does the model output map 1:1 onto `results.schema.json` §4.5
   (`posture.src`, `count.p`, `breathing.valid`)? The schema is frozen once
   the UI types are generated from it.
4. Max / Ivan: the engine must listen on TCP 127.0.0.1:6000 and speak the
   JSON-lines control protocol of §4.4. Confirm before Phase 2.
