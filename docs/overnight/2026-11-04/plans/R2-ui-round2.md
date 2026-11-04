# Track R2: UI round 2 (setup wording, one breathing rule, /present vitals, one collapsible on `/`)

Planner: R2, revised by the critic (see "Critic revisions" at the end). One worker, about 50 min,
medium effort. Starts **after track H** has finished and **re-reads every file in §4 before
editing**: H is editing `ui/src/server/{store,history}.ts`, `ui/src/lib/{api,model,vitals}.ts`,
`ui/src/components/model/*` (incl. `InsightsPage.tsx`, new `HoursSection.tsx`), so line numbers
below (c65799a + H's uncommitted work) will move. Ground rules:
`docs/overnight/2026-11-04/README.md` (real data only, honest numbers, heart always
"Experimental", shared exports additive only, **no git state changes, no servers**).

## 1. Verified findings (file:line at the time of planning)

| # | Where | Finding |
|---|---|---|
| F1 | `ui/src/components/setup/StepRoom.tsx:53-63` | Intro says "(router or phone hotspot) must stay in one place"; the warning tells the installer to set `position.transmitter_fixed: true` in `rules.yaml` and restart. The engine now auto-detects (`rules.yaml:66` `transmitter_fixed: auto`; `engine/lifefi/link.py`). Forcing `true` is only for a router bolted to the wall. |
| F2 | `ui/src/lib/setup.ts:28-36` (`HealthResponse`) | `checks.board.transmitter` is missing from the client type although `server/health.ts:27,80-83,122` sends it. **Semantics (verified in `engine.py:703`, `runtime.ts:119,149`)**: `"fixed"` = the last frame's source MAC is a Life-Fi transmitter MAC; `"other"` = any other MAC, **even when `rules.yaml` forces `transmitter_fixed: true`** (that override is not reflected in `device.transmitter`); `null` = engine not connected / no frame yet / older engine. `engineStatus.device` is the *last* frame seen, so it can be stale when the board stops; in replay it describes the recording, not the room. `SetupWizard.tsx:44-51` already polls `/health?soft=1` every 5 s. |
| F3 | `ui/src/lib/setup.ts:141-145` `transmitterMoving` | True when `position.quality_reasons` has `transmitter_not_fixed`. This is the engine's **effective** decision (MAC auto-detect *or* rules override) and is what actually makes the distance rough. |
| F4 | `ui/src/lib/words.ts:267` `REASON_TEXT.transmitter_not_fixed` | "The Wi-Fi transmitter has moved or is a phone: fix it in one place". Shown on RoomCard "why rough" with a Fix link to `/setup?step=transmitter` (`lib/room.ts:165`, correct target). No test asserts this text (grep). |
| F5 | `ui/src/app/present/page.tsx:12,56,129-134` | /present uses `breathingText()`; shows "N / min" or "—", no reason, no heart. |
| F6 | `ui/src/lib/words.ts:181-190` vs `ui/src/lib/vitals.ts:78-100` | Two rule sets. `breathingText` shows a number when `valid` **before** the `count === 2` check and never checks `BREATH_RANGE`, so RoomCard can say "15 / min" while VitalsCard says "Can't be read with several people". `vitalsView(..).breath.text` for a reading is already exactly "breaths a minute · steady/rough reading" (same 0.8 threshold). Callers of `breathingText`: `Cards.tsx:115` (RoomCard), `Cards.tsx:230` (`BreathingCard`, **no caller left**, dead), `present/page.tsx:56`. No test calls it. |
| F7 | `ui/src/components/Cards.tsx:170-174` | RoomCard "Breathing" fact duplicates VitalsCard, which sits beside every home/clinic RoomCard (`Dashboards.tsx:40-42,54-56`, `InsightsPage.tsx:58-60`). School already shows "People" there (no breathing). |
| F8 | `Dashboards.tsx:26-33`; `Cards.tsx:257-287` `SensorDetails` (key `lifefi.details`); `LiveViews.tsx:19,37-85` (key `lifefi.liveviews`) | `/` uses two hand-made `<details>`; Insights uses `Section` (`lifefi.section.<id>`, values `"1"`/`"0"`, `lib/model.ts:197-215`). Legacy values are the same `"1"`/`"0"` format. `LiveViews` is only rendered from `Dashboards.tsx` with `source` defaulted to `"distance"` (`app/page.tsx` passes none), so the `source === "model"` default-open path is dead. Insights section ids: presence, breathing, heart, movement, hours, where, health, raw. |
| F9 | `ui/src/components/model/sections.tsx:30-34,186-196` | "Still 1 min since 02:42": `since` is the ring start, `still` is total, reads as a still streak. |
| F10 | `ui/src/components/vitals/VitalsCard.tsx`, `Sparkline.tsx:55-70` | Empty sparklines are a bare baseline with no words; on `/` the card stretches to RoomCard height (Insights has `lg:self-start`). |
| F11 | `ui/src/components/Cards.tsx:178` | `href="/alerts/"` (one 308 per click). |

## 2. Decisions

- **D1. Setup transmitter state** comes from both sources, and only says "fixed" when both agree
  and the data is live. New pure `transmitterState(health, result)` in `lib/setup.ts`:
  1. `health?.checks?.board?.source === "replay"` or `result?.source === "replay"` → `"unknown"` (a recording says nothing about this room).
  2. `transmitterMoving(result)` → `"other"` (the engine's effective decision wins).
  3. `board.transmitter === "fixed"` **and** `board.ok === true` → `"lifefi"`.
  4. otherwise → `"unknown"` (engine down, old engine, no frame yet, stale board, or a router the installer forced fixed: `"other"` from health but no reason in the result). **Never** `"lifefi"` from a stale or null health.
- **D2. StepRoom text.** Intro: "The Wi-Fi transmitter must stay in one place: if it moves, every
  reading moves. Best is the Life-Fi transmitter; the sensor recognises it by itself."
  `lifefi` → `Notice tone="ok"`: "Life-Fi transmitter found. Leave it in one place, plugged in."
  `other` → `Notice tone="warn"`: "The sensor is not hearing a fixed transmitter (it hears a phone
  hotspot or a router), so distance stays a rough guess. Switch on the Life-Fi transmitter, put it in
  one place, plugged in: it is picked up by itself. Only for a router fixed to the wall, the installer
  can mark it fixed in the sensor settings (`position.transmitter_fixed: true` in
  `engine/config/rules.yaml`, then restart)." `unknown` → no notice (same as today without a reason).
- **D3.** `REASON_TEXT.transmitter_not_fixed` → "Not a fixed transmitter (a phone or a router): set up the Life-Fi transmitter".
- **D4. One breathing rule.** `breathingText(result)` returns `vitalsView(result, false).breath`'s
  `{ value, text }` (signature unchanged; blind stays the caller's job, as today). RoomCard drops the
  Breathing fact and always shows "People" in that slot.
- **D5. /present vitals** from `vitalsView(result, false)` inside the existing
  `result && !s.blind && presence !== "empty"` block and only when `s.profile !== "school"`.
  Heart only when `vitals.heart` is non-null, with `ExperimentalPill` beside the label and the caption.
- **D6. `/` collapsibles on `Section`**, ids `sensor-details` and `live-views`, both default closed,
  with a one-time migration of `lifefi.details` / `lifefi.liveviews`.

## 3. Steps (in order; `npm run typecheck` green from `ui/` after each)

**S1. Transmitter state in setup (F1-F4, D1-D3) — 12 min.** Files: `ui/src/lib/setup.ts`,
`ui/src/components/setup/{SetupWizard,StepRoom}.tsx`, `ui/src/lib/words.ts`.
- `setup.ts`: add `transmitter?: "fixed" | "other" | null` to `HealthResponse.checks.board` (additive).
  Add `export type TransmitterState = "lifefi" | "other" | "unknown"` and `transmitterState(health: HealthResponse | null, result: Result | null): TransmitterState` exactly per D1. Keep `transmitterMoving` exported and unchanged.
- `SetupWizard.tsx` (the `StepRoom` render, ~:111): `tx={transmitterState(health, result)}` instead of `moving=…`; update the import. `health` is already in scope from `useServerSetup()` (verify on re-read).
- `StepRoom.tsx`: prop `moving: boolean` → `tx: TransmitterState`; intro + notices per D2 (`Notice` tones ok|warn|danger|neutral). Keep `<code>` styling for the rules.yaml bit.
- `words.ts:267`: D3 text.

**S2. One breathing rule + RoomCard duplicate + alerts link (F6, F7, F11, D4) — 6 min.** Files: `ui/src/lib/words.ts`, `ui/src/components/Cards.tsx`.
- `words.ts` `breathingText`: `const b = vitalsView(result, false).breath; return { value: b.value, text: b.text };` Import `vitalsView` from `./vitals` (no cycle: `vitals.ts` imports only `contracts.gen`). Remove `MOTION_ON`, `MOVING_TEXT`, `NO_READING_TEXT`, `reasonText` from the import **only if** nothing else in `words.ts` uses them (grep first; lint will flag).
- `Cards.tsx` RoomCard: delete `const breathing = …` and the Breathing branch; render the People `Fact` unconditionally in that slot. Keep the `breathingText` import (still used by `BreathingCard`). Do not delete `BreathingCard` (exported; out of scope).
- `Cards.tsx:178`: `"/alerts/"` → `"/alerts"`.

**S3. /present uses the dashboard's vitals (F5, D5) — 8 min.** File: `ui/src/app/present/page.tsx`.
- Replace line 56 with `const vitals = result && !s.blind && s.profile !== "school" ? vitalsView(result, false) : null;` Import `vitalsView` from `@/lib/vitals`, `ExperimentalPill, HEART_CAPTION` from `@/components/vitals/VitalsCard` (both exported, used by H too: import only). Drop `breathingText` from the words import.
- In the `<dl>`: grid → `grid-cols-2 gap-6 sm:grid-cols-3 xl:grid-cols-4`. Breathing item when `vitals`: `dd` = `` `${value} / min` `` or "—"; when no value add `<p className="mt-1 text-lg text-muted">{vitals.breath.text}</p>`. Heart item only when `vitals.heart`: `dt` "Heart rate" + `<ExperimentalPill />`; same value/reason pattern with "/ min"; and below the `dl`, only when heart is shown, `<p className="text-base text-muted">Heart rate: experimental. {HEART_CAPTION}</p>`. Never render a heart number without the pill in the same `dt`.

**S4. `/` collapsibles on Section with key migration (F8, D6) — 12 min.** Files: `ui/src/lib/model.ts` (append only), `ui/src/components/{Section,Cards,LiveViews}.tsx`, `ui/test/section.test.ts`.
- `lib/model.ts` (H's file: re-read, add **one function directly after `writeSectionOpen`**, touch nothing else):
  `migrateSectionKey(storage: Storage | null, legacyKey: string, id: string): void` — whole body in try/catch; no-op without storage; if `SECTION_PREFIX + id` already has a value, do nothing (legacy kept, harmless); else read legacy; only `"1"`/`"0"` are copied with `setItem`, and the legacy key is removed **after** a successful `setItem` (`removeItem`); anything else: do nothing. A throwing `setItem` leaves the legacy key in place.
- `Section.tsx`: optional prop `legacyKey?: string` (additive; H's `Section` calls unchanged). In the existing mount effect, before `readSectionOpen`, `if (legacyKey) migrateSectionKey(safeStorage(), legacyKey, id);`; add `legacyKey` to the deps. Storage stays effect-only (SSR renders `defaultOpen`, no hydration mismatch); keep the existing eslint-disable comment.
- `Cards.tsx` `SensorDetails`: keep the export name and `{ children }` signature; body → `<Section id="sensor-details" legacyKey="lifefi.details" title="Sensor details" subtitle="For installers: signal health, detector values and the raw signal" className="lg:col-span-3"><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div></Section>`. Remove `useRef`/`useEffect`/`Icon` imports only if now unused. Note: the cards inside now unmount while closed (Section mounts the body only when open); that is intended (less work at 2 Hz).
- `LiveViews.tsx`: keep the `source` prop and the `Room3DLazy`/`CsiSurface3DLazy` exports and the `dynamic()` loaders. Body → `<Section id="live-views" legacyKey="lifefi.liveviews" title="3D view and live signals" subtitle="For installers" className="lg:col-span-3"><div className="grid grid-cols-1 gap-4 lg:grid-cols-3">…the three Cards unchanged…</div></Section>`. No `defaultOpen` (the `"model"` path has no caller). Remove `useOpen`, `KEY`, unused `useEffect`/`useState`/`Icon` imports. three.js still loads only after opening (body not mounted while closed).
- Leave `.chev` CSS in `globals.css` (not R2's file).
- Tests in `ui/test/section.test.ts` (extend its Map-backed `store()` with `removeItem`).

**S5. Vitals card: no stretch + words in empty sparklines (F10) — 5 min.** Files: `ui/src/components/Dashboards.tsx`, `ui/src/components/vitals/Sparkline.tsx`, `VitalsCard.tsx`.
- `Dashboards.tsx` home and clinic: `<VitalsCard className="lg:self-start" />` (prop exists, Insights uses it).
- `Sparkline.tsx`: optional `emptyText?: string`. In `draw`, after the baseline, if no row in the window has a finite picked value and `emptyText` is set, `fillText` it centred in the canvas using the already-resolved muted/grid token colour and `12px` system font (no React state, no re-render at 2 Hz, height unchanged). Canvas `aria-label` unchanged.
- `VitalsCard.tsx`: pass `emptyText="No readings in the last 10 min"` to both sparklines. Nothing else in this file (no overlay on the wave).

## 4. Files (re-read all before editing)

| File | Steps | Overlap with H |
|---|---|---|
| `ui/src/lib/setup.ts`, `components/setup/{StepRoom,SetupWizard}.tsx` | S1 | no |
| `ui/src/lib/words.ts` | S1, S2 | no |
| `ui/src/components/Cards.tsx` | S2, S4 | no |
| `ui/src/app/present/page.tsx` | S3 | no |
| `ui/src/components/{Section,LiveViews,Dashboards}.tsx` | S4, S5 | Section is used by H's Insights/"Last hours": change is additive only |
| `ui/src/lib/model.ts` | S4 (one appended function) | **yes**: append only, after `writeSectionOpen` |
| `ui/src/components/vitals/{Sparkline,VitalsCard}.tsx` | S5 | H imports `ExperimentalPill`/`HEART_CAPTION`: keep all exports |
| `ui/src/lib/vitals.ts` | read only | H |
| tests `ui/test/{setup,section,vitals}.test.ts` | S1, S2, S4 | none expected |

Do not touch `ui/src/components/model/**`, `ui/src/lib/{api,vitals}.ts`, `ui/src/server/**`,
`engine/**`, contracts, `globals.css`. If a step needs one of those, skip it and write it in the report.

## 5. Tests

- `ui/test/setup.test.ts` `transmitterState`: health `{board:{ok:true,transmitter:"fixed"}}` + no reason → `lifefi`; same but `ok:false` → `unknown`; health `fixed` + result with `transmitter_not_fixed` → `other`; health `other` + reason → `other`; health `other` + result without reason (router forced fixed) → `unknown`; health null + reason → `other`; health null + null result → `unknown`; `board.source:"replay"` + `fixed` → `unknown`; result `source:"replay"` + reason → `unknown`. Existing `transmitterMoving` tests stay.
- `ui/test/section.test.ts` `migrateSectionKey`: legacy `"1"` → new key `"1"`, legacy removed; legacy `"0"` → `"0"`; new key present → untouched, legacy kept; legacy `"yes"` → nothing written, legacy kept; `null` storage and the existing `throwing` storage → no throw; a storage whose `setItem` throws but `getItem` works → legacy kept.
- `ui/test/vitals.test.ts` (it already has a `result()` builder): `breathingText(r)` deep-equals `{value, text}` of `vitalsView(r,false).breath` for: valid reading; count 2 + valid (value null, `SEVERAL_TEXT`); valid bpm 80 (value null, `OUT_OF_RANGE_TEXT`); empty room; reason `"motion"`.
- From the repo root: `npm run typecheck`, `npm run lint`, `npm test`. All green. No `next dev`/`next build`.

## 6. Acceptance criteria

1. `/setup?step=transmitter` never presents editing `rules.yaml` as the normal path. It says "Life-Fi transmitter found" **only** when health says `fixed`, the board is ok, the result has no `transmitter_not_fixed` and the source is live; on replay, engine down, old engine or a forced-fixed router it shows no claim either way.
2. RoomCard "why rough" reads the D3 text; "Fix" still opens the transmitter step.
3. With 2 people and a valid bpm, or a bpm outside 4-60, no page shows a breathing number; RoomCard has no Breathing fact (People instead) on all profiles.
4. `/present` (home/clinic) shows breathing with the engine's reason when there is no number, and heart only when the engine sends `heart`, always with "Experimental" and the caption; school shows neither.
5. `/` "3D view and live signals" and "Sensor details" use the Section header (44 px button, chevron, `aria-expanded`); with `localStorage lifefi.details = "1"` set beforehand, Sensor details opens after the update and `lifefi.details` is gone; three.js chunks load only after opening the 3D section; `#sensor-details` deep-links.
6. VitalsCard without readings shows "No readings in the last 10 min" inside each sparkline; on `/` at `lg` the card no longer stretches.
7. All §5 checks green. Report lists deviations and any H overlap found on re-read.

## 7. Cut list (cut from the bottom; must = S1, S2)

1. S1 transmitter state + wording (must)
2. S2 one breathing rule, RoomCard duplicate, `/alerts` link (must, small)
3. S3 /present vitals
4. S4 Section on `/` with migration
5. S5 vitals card no-stretch + empty text (the `lg:self-start` line alone is 1 min: do it even if the Sparkline part is cut)

**Cut by the critic (do not do):** Movement "since"/current-streak rewrite in `components/model/sections.tsx` + `currentStreak` in `lib/model.ts` (H's files, wording not settled; leave for the report as an owner item); the VitalsCard wave overlay; `TeachRecord` preselecting the transmitter; any `api.ts` `DeviceStatus` change.

Estimate: 12 + 6 + 8 + 12 + 5 = 43 min + ~7 min checks. If behind at 35 min, finish the step in hand, skip the rest and list it.

## 8. Worker report must include

Files changed per step, cut items, deviations, test counts, the three check results, overlaps with H
found on re-read, and a browser checklist for the orchestrator: setup step 2 with engine down
(no notice), on replay (no notice) and live (if available); `/` RoomCard facts; /present at 1280 px
and 375 px (home profile, heart pill visible when heart is sent); `/` sections with
`localStorage lifefi.details=1` pre-set, then reload (open, legacy key gone); network tab shows no
three.js chunk until the 3D section opens; vitals card before the first reading (light and dark).

## Critic revisions

1. **S1 logic was unsafe.** The plan let health `"other"` override and would have warned "not the Life-Fi transmitter, distance a rough guess" for a router the installer forced fixed (`device.transmitter` is MAC-only and ignores the rules.yaml override; verified `engine.py:703`, `link.py`). It also would have said "detected" from stale `engineStatus.device` (last frame, kept while the engine is connected) and from a replay recording. Now: the result's `transmitter_not_fixed` (the engine's effective decision) wins; "found" needs health `fixed` + `board.ok` + live source; replay/forced-router/old engine → `unknown`, no claim. Tests added for each case.
2. **S3 (breathingText) simplified and checked.** All callers listed (RoomCard, dead `BreathingCard`, /present; no alerts or tests use it). `vitalsView` already produces the identical "breaths a minute · steady/rough reading" text, so the wrapper is just `{value, text}` of `.breath`. Blind remains the caller's job (both remaining callers already guard). School: RoomCard already showed People for school; /present keeps its `profile !== "school"` guard. Only change in meaning: count 2 / out-of-range now hide the number (intended).
3. **/present heart**: kept inside the existing non-blind/non-empty block with `vitalsView(result, false)` instead of passing `s.blind` (the block already excludes blind); caption only when heart is shown.
4. **S4**: verified legacy values are the same `"1"`/`"0"` format; migration order fixed (remove legacy only after a successful `setItem`); kept effect-only (no storage in render); `LiveViews` `defaultOpen={source==="model"}` dropped (no caller) so the Section key is never written for a page that defaulted open; noted that Sensor details' cards now unmount while closed; `migrateSectionKey` is the only edit to H's `lib/model.ts`, append-only.
5. **Cut S5 (Movement "since")**: it edited two of H's files (`lib/model.ts` logic, `components/model/sections.tsx`) for a wording fix, and the proposed "Moving now" was wrong when the newest sample is not present. Left as an owner/next-round item.
6. **S6 slimmed**: Sparkline empty text drawn with `fillText` on the canvas instead of React state in a 2 Hz draw loop; the wave overlay and `TeachRecord` extra cut. Total estimate down from 52 to 43 min.
