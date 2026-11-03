# Overnight run (2026-11-03): ground rules for every agent

Branch `feat/overnight`, cut from `origin/dev` with `feat/usb-live-next-backend-spot-model`
(963c980, the live USB / backend-in-Next work) merged on top. One orchestrator
runs it; each feature goes planner → critic (revises the plan) → worker.

Goal from the owner: a production-ready web UI for the ESP32 that shows where
people are in a room from Wi-Fi CSI; **better model accuracy** and **better UI/UX**.

## Rules (all agents)

1. **No git writes.** Do not commit, push, branch, stash, reset or merge. The
   orchestrator commits your files by path. Leave the tree buildable.
2. **Stay in your track's files** (table below). If you must touch another
   track's file, say so in your final report instead of editing it.
3. **No mock or demo data in the app.** Only real board data or real
   recordings are shown. Synthetic data is for tests only
   (`engine/tests/scenarios.py`, `engine/lifefi/synth.py`).
4. **The board.** The ESP32 is normally on USB (COM3) but is **not detected
   right now** and has no Wi-Fi transmitter. Never flash firmware. Test with
   replays: `firmware/recordings/*.csirec` and `data/sessions/spots-*/`
   (labelled spot sessions; `data/` is gitignored, do not delete anything in it).
5. **Python:** `E:\Code\Competition\Life-Fi\.venv\Scripts\python.exe`. Engine
   tests are scripts, run one by one: `.venv\Scripts\python engine\tests\test_position.py`.
6. **Next.js:** read `ui/AGENTS.md`; this Next version differs from what you
   know, check `ui/node_modules/next/dist/docs/` before using an API.
   UI tests: `cd ui; npx vitest run`. Type check: `cd ui; npx tsc --noEmit`.
   Lint: `npm run lint -w ui`.
7. **Ports.** Only the UI track runs `next dev` (port 3000). Anyone else who
   needs a server uses port 3100+ and stops it when done.
8. **Honesty** (docs/plan/ui-ux.md §2): never show more certainty than the
   model has. One link cannot see direction; say "about 2 m from the sensor",
   not a fake x/y dot, unless the model really estimates it.
9. **Owner questions** go to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) (append;
   the owner is asleep). Pick the best default and keep going.
10. Write code like the surrounding code: same comment density, naming, idiom.

## Tracks and file ownership

| Track | Owns |
|---|---|
| **A — position / model accuracy** | `engine/lifefi/` (all but `sources.py`, `control.py`), `engine/tests/`, `engine/config/`, `ml/`, `contracts/results.schema.json` + `ui/src/lib/contracts.gen.ts` (additive changes only), `docs/models.md` |
| **B — UI / UX** | `ui/src/app/**` except `ui/src/app/api/**`, `ui/src/components/**`, `ui/src/lib/**` except `contracts.gen.ts`, `ui/src/app/globals.css` |
| **C — production readiness** | `ui/src/server/**`, `ui/src/app/api/**`, `ui/test/**`, `ui/src/instrumentation.ts`, `ui/next.config.ts`, `ui/package.json`, root `package.json`, `scripts/**`, `.github/**`, `engine/run.py`, `engine/lifefi/sources.py`, `engine/lifefi/control.py`, `README.md`, new `docs/ops/` |

Plans live in `docs/overnight/plans/`, the morning report in `docs/overnight/REPORT.md`.
