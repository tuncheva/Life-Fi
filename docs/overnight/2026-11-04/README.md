# Overnight run 2 — 2026-11-04 (01:45 → 07:00)

Branch **`feat/overnight`** only. No PRs, no merges into other branches.
Every feature: planner subagent → critic subagent (revises the plan) → worker
subagent, all at medium effort. The orchestrator commits and pushes by pathspec;
**subagents never run git commands that change state** (`git diff`/`git status`
/`git log` are fine).

## Goals (from the owner)

1. Heart rate and breaths per minute on the dashboard (`/`) and on `/model`.
2. `/model` shows more charts that are actually useful to the user, with
   collapsible sections.
3. Better UI/UX across the system.
4. Production ready.

## Ground rules for every subagent

- **Real data only in product paths.** No mock or demo data in the app. Recorded
  sessions (`data/sessions/spots-*/*.csirec`, replays through the engine) and the
  synthetic generators (`engine/lifefi/synth.py`, `engine/tests/scenarios.py`) are
  for tests only. The ESP32 is not connected tonight: nothing is tested on hardware.
- **Honest numbers.** Heart rate from one ESP32 link is experimental; it must be
  labelled so wherever it is shown and must never look like a medical reading.
  Show "no reading" with a reason rather than a guessed number.
- **Contract is fixed.** `contracts/results.schema.json` got two optional fields
  in commit 38fb377: `heart` (`bpm`, `valid`, `confidence`, `snr?`, `valid_share?`,
  `reason`) and `breathing.reason`. Do not change their shape. Additive optional
  fields elsewhere only if essential, and say so in your report.
- **Stay in your files.** Each track owns the files listed below. Do not edit
  another track's files; if you need a change there, write it in your report.
  Shared exports (`ui/src/components/ui.tsx`, `ui/src/lib/live.tsx`) stay
  backward compatible: add, never rename or remove.
- **Checks before you finish:** `npm run typecheck`, `npm run lint`,
  `npm test` (from the repo root; runs contracts + engine + vitest). Python:
  `.venv/Scripts/python.exe`. Do not run `next build` while a `next dev` is up
  (it sends the dev server into a reload loop); do not leave servers running.
- Windows machine; Bash (Git Bash) and PowerShell 5.1 are both available.
- Match the surrounding code: comment density, naming, idiom, Tailwind tokens
  already defined in `ui/src/app/globals.css`.

## Tracks and file ownership

| Track | Scope | Owns |
|---|---|---|
| **V** — vital signs engine | engine fills `heart` and `breathing.reason`, tests on recorded + synthetic data, docs | `engine/**`, `ml/**`, `contracts/fixtures/**`, `contracts/*.md`, `docs/models.md`, `ui/src/server/validate.ts` |
| **M** — dashboard + `/model` | vitals card on `/` and `/model`, the `/model` page with useful charts and collapsible sections, client-side history buffers | `ui/src/app/page.tsx`, `ui/src/app/model/**`, `ui/src/components/{Dashboards,Cards,BreathingChart,SignalsChart,LiveViews,Timeline,RoomView,Room3D,CsiSurface3D}.tsx`, new `ui/src/components/{vitals,model}/**`, new `ui/src/components/Section.tsx`, `ui/src/lib/live.tsx`, `ui/src/lib/room.ts`, new `ui/src/lib/{vitals,model}*.ts`, `ui/src/server/{history,store}.ts`, `ui/src/app/api/v1/history/**`, new tests `ui/test/{vitals,model,live,section}*.test.ts` |
| **U** — shell + other pages | navigation, header, layout, visual consistency, the remaining pages | `ui/src/components/{TopBar,AlertBanner,ui,EmergencyMap,EmergencyPanels}.tsx`, `ui/src/components/{setup,teach}/**`, `ui/src/app/{layout.tsx,globals.css,error.tsx,not-found.tsx}`, `ui/src/app/{alerts,settings,source,label,setup,teach,present,emergency}/**`, `ui/src/lib/{words,theme,useTheme,sound,pin,setup,teach,emergency}.ts*`, new tests `ui/test/{shell,ui}*.test.ts` |

`globals.css`: track M may append one block at the very end, delimited by
`/* --- track M: vitals and model --- */`; track U edits only above it.

Plans, critiques and worker reports: [plans/](plans/). Questions for the owner:
[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md). Morning report: [REPORT.md](REPORT.md).
