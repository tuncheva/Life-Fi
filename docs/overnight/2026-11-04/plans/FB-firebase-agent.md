# Track FB: Firestore as the database, and a caregiver agent (Anthropic default, Gemini option)

Owner request 2026-11-04 22:05. Plan due 22:20, implementation due 22:40. Branch `feat/overnight`.

Owner decisions (asked 22:10):
- Store in Firebase: alerts + their transitions, state changes (presence / posture / count), the 5 s history rows, and every agent run.
- Firestore **replaces** SQLite (no node:sqlite left in the server).
- Agent: day summary, "explain this alert", and a Q&A chat that reads data through tools.
- Firestore via `firebase-admin`; `LLM_PROVIDER=anthropic` by default, `gemini` as the option.
- All keys in env; `ui/.env.example` committed with empty placeholders.

## 1. Firestore store (`ui/src/server/store.ts` rewritten)

Same public surface as today's `Store`, so `History`, `runtime.ts` and the alert wiring barely change:

| Method | Today (SQLite) | New |
|---|---|---|
| `addHistory(row)` | sync insert | sync, buffers in memory; flushes one doc per minute |
| `saveAlert(a)` | sync upsert + log | sync, queued write (fire and forget, errors logged) |
| `addEvent(e)` (new) | n/a | sync, queued write |
| `queryHistory`, `vitalsRows` | sync | **async** (the 2 route handlers `await`) |
| `loadAlerts(limit)` | sync | **async** (awaited once in `runtime.start`) |
| `historySize()` | `COUNT(*)` | async `count()` aggregate (only logged at boot) |
| `purge(days)` | `DELETE` | async batched deletes, same daily timer |
| `close()` | close db | flushes the queue + the open minute |

Collections (top level, prefix from `FIRESTORE_COLLECTION_PREFIX`, default `lifefi_`):
- `history/{minuteStartMs}`: `{ t, rows: HistoryRow[] }` with up to 12 rows. One write a minute = ~1.4k writes/day instead of ~17k (the Spark free tier allows 20k writes/day). Reads filter by `t`, then flatten and trim to the exact range.
- `alerts/{id}`: `{ ...alert, created_at, state }`.
- `alert_log/{auto}`: `{ alert_id, state, t, config_hash }`.
- `events/{auto}`: `{ t, kind: "presence"|"posture"|"count"|"agent", from, to, data }`, written only on change (runtime compares with the previous result). Agent runs store mode, provider, model, question, answer, tool calls and latency, never the room name or the phone number.

Writes go through `BulkWriter`, so one slow write never blocks the 10 Hz result loop.

**No Firebase config** (keys missing, or in tests): `MemoryStore` implements the same interface in memory, and a warning says nothing is persisted. `LIFEFI_DB=:memory:` keeps its current meaning. `FIRESTORE_EMULATOR_HOST` is honoured, so a local emulator works without keys.

Tests: `store.test.ts` / `http.test.ts` / `vitals-history.test.ts` run against `MemoryStore` (same contract). Firestore code is checked by a typecheck and one manual run against the real project, if a key is available.

## 2. Agent (`ui/src/server/agent/`)

- `provider.ts`: a `LlmProvider` interface `{ name, model, complete({ system, messages, tools }) -> { text, toolCalls } }` with a neutral message/tool format.
- `anthropic.ts` (`@anthropic-ai/sdk`, Messages API with tools) and `gemini.ts` (`@google/genai`, function declarations). The provider comes from `LLM_PROVIDER`, the key from `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, and the model from `ANTHROPIC_MODEL` (default `claude-opus-5-5`, low effort) / `GEMINI_MODEL` (default `gemini-3.5-flash-lite`).
- `tools.ts`: read-only tools over the store/context that return **derived, identifier-free** values:
  `get_current_status`, `get_alerts(since_h)`, `get_events(since_h, kind?)`, `get_vitals_summary(hours)` (reuses `summarize()` from vitals-history).
- `agent.ts`: a tool loop, max 6 steps and 30 s total. Modes: `summary` (system prompt: 2–3 plain sentences for a caregiver, "not medical advice"), `explain` (alert id preloaded), and `chat` (the user's question plus up to 10 earlier turns sent by the client). Every run is logged as an `agent` event.
- No key configured: the routes return 503 `{ error: "agent_not_configured" }`, and the UI shows that instead of failing.

Routes (PIN-guarded like the other write routes, rate limit of 1 request in flight):
- `POST /api/v1/agent/summary` `{ hours?: number }`
- `POST /api/v1/agent/explain` `{ alert_id }`
- `POST /api/v1/agent/chat` `{ messages: {role, text}[] }`

UI (minimal, timeboxed): an "Assistant" section on the Insights page with a "Summarize last 24 h" button, a chat box and an "Explain" button on each alert row of the Alerts page. If time runs short, the chat box goes first and the explain button is dropped.

## 3. Env

`ui/.env.example` (Next loads `ui/.env`; the root `.gitignore` already ignores `.env*` but keeps `.env.example`):
```
# Firebase / Firestore (service account; or set GOOGLE_APPLICATION_CREDENTIALS to a JSON file)
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIRESTORE_COLLECTION_PREFIX=lifefi_
# FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
# Agent
LLM_PROVIDER=anthropic          # anthropic | gemini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5-5
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```
Config validation joins `config.problems` (for example, an unknown `LLM_PROVIDER`). `FIREBASE_PRIVATE_KEY` accepts `\n` escapes.

## 4. Order of work (22:20 → 22:40)

1. `npm i firebase-admin @anthropic-ai/sdk @google/genai` in `ui/`.
2. The store interface + `MemoryStore` + `FirestoreStore`; async routes; runtime wiring and state-change events. Tests stay green.
3. Agent providers, tools, loop and routes.
4. `.env.example` + a README section.
5. UI assistant panel.
6. `npm run typecheck`, `npm test`, lint; commit on `feat/overnight` (no push until the owner reviews).

## Risks / what will not be verified tonight

- No Firebase service account or LLM keys on this machine, so the Firestore and provider calls are only typechecked. The owner should run once with real keys.
- Replacing SQLite drops existing local history in `data/lifefi.sqlite` (it is not migrated). The file is left on disk untouched.
- Firestore needs internet; without it, writes queue in memory and are retried by BulkWriter, then dropped and logged.
- 20 minutes is tight: the explain button and the purge for Firestore are the first things to cut. If cut, they go in REPORT.md.

## Status (22:25)

Done:
- `Store` is now an interface: `FirestoreStore` (`ui/src/server/store-firestore.ts`) and `MemoryStore` (`ui/src/server/store.ts`). node:sqlite is gone from the server. Runtime picks Firestore when `FIREBASE_*` is set, else memory with a warning. Alerts are restored async after boot.
- Events: presence / posture / count changes (`runtime.ts` `recordChanges`) and every agent run (`kind: "agent"`) go to `events`. Alerts go to `alerts`, transitions go to `alert_log`, and history goes into per-minute docs.
- Agent: `ui/src/server/agent/` (provider switch, Anthropic and Gemini loops, 4 read-only tools, `runAgent`), routes `/api/v1/agent/{status,summary,explain,chat}`, and contract rows in `contracts/api.md`.
- The Anthropic default is `claude-opus-5-5` (the current default model) at `effort: low`, with server-side refusal fallback (`fallbacks: "default"`). Set `ANTHROPIC_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5` for a cheaper run.
- UI: an "Assistant" section at the top of Insights (summary button + chat) and an "Explain this alert" button on each alert card.
- `ui/.env.example`. Tests: 23 files / 270 tests pass (the new `test/agent.test.ts`; the store tests now run on MemoryStore; the SQLite migration tests were removed). Typecheck and lint are clean.
- Checked in the browser (memory mode, no keys): boot, `/agent/status`, `/history/vitals`, the Insights "assistant is off" notice, and `/agent/chat` returning 503 and 400.

Not verified (no credentials on this machine):
- Real Firestore reads and writes. The `history` and `events` range queries need only single-field indexes (Firestore creates those automatically).
- Real Anthropic and Gemini calls and tool loops.
- The old `data/lifefi.sqlite` is not migrated (it is left on disk untouched).

## UI round (owner request, 22:30)

Owner decisions: a new Events page; the assistant on both Insights and its own page; a read-only Settings card; agent runs shown in the events list.
- `/events` (main nav): a day-grouped list of presence, posture and people-count changes plus assistant runs. Filters by kind (All, Presence, Posture, People, Assistant) and range (6 h, 24 h, 7 days); refreshes every 30 s; a warning when the store is memory-only. Each assistant run can expand to show its answer, model, number of lookups and time. Backed by `GET /api/v1/events`.
- `/assistant` (main nav): the same chat as on Insights, with suggested questions. The conversation is kept for the browser tab (sessionStorage) and shared with the Insights section. Cancelling the PIN prompt removes the unsent question.
- Settings: a "Data and assistant" card (read-only): Firestore or memory, the project and collection names, provider, model, and whether a key is set (never the key).
- Tests: `test/events.test.ts` (event wording); `test/shell.test.ts` now expects Room, Insights, Assistant, Events, Alerts.
- Checked in the browser: the events list with stubbed data, the Settings card, assistant suggestions → PIN prompt → answer (stubbed), PIN cancel, and phone width (375 px, no horizontal scroll).

## Test round with real credentials (23:00–23:30)

Owner put real keys in `ui/.env` (project `lifefi-74b74`, Anthropic). This replaces the "Not verified" list above.

Bugs found and fixed:
1. A bad Firebase key crashed every API route. Now it logs and falls back to memory.
2. A private key pasted without its BEGIN/END lines failed to parse. It is now wrapped back (`pemKey`).
3. The agent said the sensor was "online" when the engine was not running. The status tool now also checks `engine.connected` and whether any result has arrived.
4. The agent read UTC timestamps as local time (it reported 20:57 for 22:57). Tools now send times in the dashboard's time zone (`localTime`).
5. **BulkWriter sends only full batches (20 writes).** Single events and alerts could sit unsent for minutes and be lost on a crash. Queued writes are now flushed within 1 s.
6. **BulkWriter does not keep order per document.** An alert stored as pending → open → resolved could end up "open" in Firestore (seen in the real-Firestore test). Writes to the same alert are now chained.
7. A late history row (replay jumping back, a restart in the same minute) overwrote its minute doc. Rows are now a map keyed by `t`, written with merge. Minutes queued for writing stay readable.
8. `queryEvents` kept the **oldest** 2000 events. It now keeps the newest.
9. Read quota: the Timeline polls 24 h of history every 15 s, which is about 1,440 reads per poll and over the 50k/day free tier within hours. The last 26 h of history and 7 days of events are now loaded once at startup and kept in memory with every write; older ranges still go to Firestore.
10. Alerts raised before the async load could reuse saved ids (`a-1`) and overwrite them. Sensing (engine, watchdog, rules) now starts after the load. If the load takes over 10 s, sensing starts anyway with ids reserved above any saved one.
11. A flickering posture or count label wrote one event per result. A change is now recorded once it has held 10 s (`ChangeTracker`); presence is recorded at once, since the engine already debounces it.
12. `/events` showed caregivers' questions and answers without the PIN. They now need the PIN header or the trust cookie; the Events page offers "Enter PIN".
13. The agent's busy flag and client were module variables, so separately bundled routes might not share them. They now live on `globalThis`, like the runtime.

Tests now: 27 files / 290 unit tests pass, plus:
- `test/firestore.it.test.ts`: real Firestore, run with `FIRESTORE_IT=1 npx vitest run test/firestore.it.test.ts`. It uses throwaway `lifefi_it_*` collections and deletes them afterwards. 5 tests: per-minute history incl. late rows and unflushed reads, alert ordering, events, writes sent without `flush()` and loaded by a fresh store, purge. Passed 3+ times in a row.
- `test/providers.test.ts`: both tool loops against mocked SDKs (message shapes, thinking blocks kept, Gemini `functionResponse` ids, tool errors, refusal, step cap).
- `test/changes.test.ts`: the change debounce.

Also checked:
- `next build` succeeds and `scripts/check-contracts.mjs` passes.
- Secrets: none of the changed files contain a key, the service-account email or the project id; `ui/.env` is ignored and untracked.
- Live against the real services: every agent route and error path (401, 400, 404, 409 on two runs at once, 503), real Anthropic answers, transcripts hidden without the PIN.
- Restart: alerts and agent runs come back from Firestore, and a restored alert does not lose its id.
- Every page loads with no server errors.

Known and not fixed:
- Gemini was never run live (no key); only the mocked loop is tested.
- Shutdown: Next's `exit` handler cannot await, so up to about 1 s of queued writes can be lost on a restart.
- `alertView` passes the alert's `data` to the model unfiltered. Today that holds only reasons, minutes and windows, never names.
- `/agent/status` shows the Firebase project id without the PIN. It is an identifier, not a secret.
- The PIN is still the default `1234`.
- With no sensor here, live 5 s history from the engine was not exercised end to end; the real-Firestore test covers the same store calls.
