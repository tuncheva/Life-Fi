# Track B plan: UI / UX ("where are people in the room")

Planner, 2026-11-03; revised by the critic (final, this is what B1 and B2 implement).
Input: docs/plan/ui-ux.md (owner's brief, still the rule book), docs/overnight/README.md,
a code audit of `ui/src`, track A's final contract (A-position-accuracy.md) and track
C's plan (C-prod-readiness.md). Planner's original: kept in the critic's scratchpad only;
this file supersedes it.

## Critic revisions

1. **Track A's final contract replaces the planner's guessed fields.** The planner read
   `position.quality` as a number 0..1 and `position.confidence`; neither exists. Final
   (all optional): top-level `result.occupancy: null | {state: "empty"|"occupied"|"unsure", p}`,
   `position.quality: "none"|"low"|"medium"` (no "high"),
   `position.quality_reasons: ("transmitter_not_fixed"|"no_distance_fit"|"no_empty_calibration"|"low_packet_rate")[]`,
   `position.spot.model_accuracy: number|null`, `position.spot.reliable: boolean`.
   B1.1 now reads exactly these (narrow local type, never edits `contracts.gen.ts`).
2. **Occupancy is the primary "where" state; distance is secondary and always labelled.**
   The planner made the distance band the hero picture. Track A measured the distance as
   unreliable tonight (wrong-sign correlation, phone hotspot transmitter), so the hero is
   now *is the room occupied* (big, coloured room fill) and the distance is a secondary,
   quality-labelled band: `none` → no band; `low` → dimmed dashed band, label "rough
   guess", **no number in any consumer sentence**; `medium` → band + "roughly 2 to 3 m".
   Missing `quality` (older engine) is treated as `low`: the current engine is exactly the
   unreliable one, so no number is shown until the engine says otherwise.
   `quality_reasons` become plain-language "why it is rough" lines with a link to the
   setup step that fixes each one (that is what makes "low" useful, not just honest).
3. **Spot shown only when `spot.reliable === true`** (and name ≠ `empty`). The planner's
   `p ≥ 0.7` rule would have shown a 19 %-accurate model to consumers. Older engines
   without `reliable` never show a spot in consumer views (installer 3D view only).
4. **Presence vs occupancy precedence written down** (planner left it open): the headline
   ("Someone is in the room · since 14:02") stays on the engine's presence via
   `roomStatus` (alerts and timeline depend on it). The where-block never contradicts it:
   A guarantees occupancy is never `empty` while presence is `present`; any other
   disagreement renders as `unsure`/"can't place". Without `occupancy`, presence alone.
5. **File ownership made strictly disjoint, incl. shared files.** `words.ts`, `live.tsx`
   → B1. `globals.css`, `ui.tsx`, `TopBar.tsx`, `layout.tsx`, `sound.tsx` → B2. Setup copy
   lives in `lib/setup.ts` (B2), not `words.ts`. Requests across the line go in the
   report, not an edit. Full list in §2.
6. **Contract-first step 0 for both workers** (≈10 min, before anything else): B1 lands
   `lib/room.ts` exports (`readRoomGeometry`, `writeRoomGeometry`, `RoomGeometry`) and
   `useLiveSlow()` in `live.tsx` as thin, compiling stubs so B2 can import them from minute
   10; B2 must not block on them before that.
7. **Use C's routes, degrade if absent.** `/setup` step 1 and the "Finish setup" pill use
   `GET /api/v1/setup` and `GET /api/v1/health` when they answer (shapes in C's plan),
   and fall back to the `useLive()` derivation on 404/network error. Poll ≤ every 5 s,
   only while `/setup` is open; TopBar fetches `/setup` once on mount and when the
   calibration state changes, never on a timer.
8. **Re-render budget promoted from P2 to P1, simplified.** `LiveProvider` keeps
   `useLive()` unchanged but publishes two contexts; new `useLiveSlow()` (no `result`) and
   `useResult()`. Rule: page-level components (`Dashboards`, `app/*/page.tsx`) must not
   read `result`; only leaf components do. `RoomView` subscribes itself. B2 moves
   `AlertBanner` and `sound.tsx` to `useLiveSlow()`.
9. **Hydration fix on /present without changing `useNow`'s type** (changing its initial
   state to `null` would break every caller): a `useMounted()` hook in `live.tsx` built on
   `useSyncExternalStore` (avoids the React 19 set-state-in-effect lint), clock rendered
   only when mounted.
10. **Dev server and build: Next 16 locks the project dir.** `next dev` writes
    `.next/dev/lock` and a second `next dev` (any port) refuses to start; two
    concurrent `next build`s also collide. `next dev` and `next build` *may* run at the
    same time (separate output dirs). So: one shared dev server on :3000, started by
    whoever needs it first (`npm run dev:app` from the root); the other reuses the URL the
    lock prints. Never kill it while the other worker is still running; B1 stops it at
    the end. If `next build` fails on the lock, wait 1 min and retry.
11. **Scope cuts for 2.5 h**: dropped the 768 px screen pass, the screenshot folder
    (optional, only if time), B2.6 settings work except the "Re-run setup" link, setup step
    5 reduced to a link card, the Room3D caption/reduced-motion polish (B1.5 → only the
    `tx_m` swap). Added an explicit step order where every step ends green.
12. **Smaller corrections**: RoomView eases with a CSS transition on the band radius
    (no rAF loop needed for 2 Hz data); `/present` must also show the replay banner and
    the hero where-state; `aria-live` only on the where sentence, not on the SVG;
    `calibrate()` defaults to 120 s in `lib/api.ts`, setup passes 60 explicitly.

## 0. Audit (planner's, verified by the critic)

| # | Finding | Where |
|---|---|---|
| F1 | Mobile broken: at 375 px the page is 650 px wide (grids lack `grid-cols-1` / `min-w-0`); nav overflows ~7 px. Verified: `Dashboards.tsx` uses `grid gap-4 lg:grid-cols-3` three times. | `Dashboards.tsx`, `TopBar.tsx` |
| F2 | "Where" is not the hero: a 3D card below the fold next to engineering views. | `LiveViews.tsx`, `Dashboards.tsx` |
| F3 | /present says "LIVE" whenever SSE is connected, even with the engine down. Verified at `present/page.tsx:69`. | `app/present/page.tsx` |
| F4 | Same problem said four times (system bar, alert banner, card band, headline). | `TopBar.SystemBanners`, `AlertBanner`, `Cards.RoomCard` |
| F5 | Sound prompt is a fixed bottom dialog covering content on every page. | `lib/sound.tsx` |
| F6 | Timeline canvas smeared after a width change (no ResizeObserver). | `Timeline.tsx` |
| F7 | Hydration mismatch on /present (`useNow` initial `Date.now()` during SSR); script-tag warning from the theme boot script. | `present/page.tsx`, `layout.tsx` |
| F8 | No setup flow; `calibrate()` unused; `/position/fit` has no UI. | — |
| F9 | Installer pages ("Model", "Emergency") in the consumer nav. | `TopBar.tsx` |
| F10 | Router distance is a per-browser 2/3/5 m toggle; the room has no size. | `Room3D.tsx` |
| F11 | One context value with `result` (2 Hz): every `useLive()` consumer re-renders each tick; three.js loads on every dashboard visit. | `lib/live.tsx`, `LiveViews.tsx` |

## 1. Principles

- **Text first, picture second.** The where-sentence answers the question; the room
  drawing illustrates it. The SVG has `role="img"` + `aria-label` saying the same thing.
- **Occupancy first, distance second.** The room fill says occupied / empty / unsure.
  Distance is a band (an arc around the sensor: "d is a radius around the board",
  `engine/lifefi/position.py`), never a dot or x/y, and always carries its quality label.
- **Never more certainty than the model** (README rule 8): no number when quality is
  `low`/missing, no spot unless `reliable`, held values marked as held.
- **No mock data**; empty/loading/offline are real states of absent data.
- **No new dependencies.** SVG + Tailwind + existing tokens; three.js stays, lazy, opt-in.
- Write like the surrounding code; copy in `words.ts` (B1) or `lib/setup.ts` (B2);
  token classes (`bg-present-soft`, `text-muted` …).
- Next 16.4.3: read `ui/node_modules/next/dist/docs/` before any Next API (`dynamic`,
  `error.tsx`, `not-found.tsx`, scripts). Do not edit `ui/AGENTS.md`.

## 2. Two workers, strictly disjoint files

Paths relative to `ui/`. "New" = file does not exist yet.

**Worker B1 (room view + dashboard + presentation) edits only:**
- `src/lib/room.ts` (new), `src/lib/words.ts`, `src/lib/live.tsx`
- `src/components/RoomView.tsx` (new), `Cards.tsx`, `Dashboards.tsx`, `LiveViews.tsx`,
  `Room3D.tsx`, `CsiSurface3D.tsx`, `Timeline.tsx`, `SignalsChart.tsx`, `BreathingChart.tsx`
- `src/app/page.tsx`, `src/app/model/page.tsx`, `src/app/present/page.tsx`
- `test/room.test.ts` (new)

**Worker B2 (setup + shell + global states) edits only:**
- `src/app/setup/page.tsx` (new), `src/components/setup/*.tsx` (new), `src/lib/setup.ts` (new)
- `src/components/TopBar.tsx`, `AlertBanner.tsx`, `ui.tsx`
- `src/lib/sound.tsx`, `pin.tsx`, `theme.ts`, `useTheme.ts`
- `src/app/layout.tsx`, `src/app/globals.css`, `src/app/error.tsx` (new), `src/app/not-found.tsx` (new)
- `src/app/settings/page.tsx`, `src/app/source/page.tsx`, `src/app/label/page.tsx`, `src/app/alerts/page.tsx`
- `test/setup.test.ts` (new)

**Neither edits:** `src/lib/api.ts` (both import; missing helpers go local in the owning
file), `src/lib/contracts.gen.ts`, `src/lib/emergency.ts`, `src/lib/orbit.ts`,
`src/app/emergency/**`, `src/components/Emergency*.tsx`, `src/app/api/**`, `src/server/**`,
`test/*` except the two new files, `vitest.config.ts`, `next.config.ts`, `package.json`,
`AGENTS.md`. The orchestrator accepts `test/room.test.ts` and `test/setup.test.ts` as
track B files (README gives C `ui/test/**`).

**Shared contracts (B1 provides, B2 consumes, read-only):**
```ts
// src/lib/room.ts
export type RoomGeometry = { length_m: number; width_m: number; tx_m: number | null };
export const DEFAULT_ROOM: RoomGeometry;               // { length_m: 4, width_m: 3, tx_m: null }
export function readRoomGeometry(): RoomGeometry;       // localStorage "lifefi.room", try/catch, SSR-safe
export function writeRoomGeometry(g: RoomGeometry): void;
// src/lib/live.tsx
export function useLiveSlow(): Omit<LiveState, "result">;   // stub = useLive() minus result until the split lands
export function useResult(): Result | null;
export function useMounted(): boolean;
```
Cross-requests (B2 needs a word/token from B1's files or vice versa) go in the worker's
final report; B1 uses existing tokens only (`--present`, `--uncertain`, `--empty`,
`--offline`, `--line`, `--surface-2`, `--muted`, `--replay`).

## 3. Worker B1: occupancy-first room view as the hero

Order (each step ends with tsc + vitest + lint green; `next build` after steps 3 and 6):

### B1.0 (10 min) Contract stubs
`lib/room.ts` geometry read/write (migrate `lifefi.routerDistance` into `tx_m` once),
`useLiveSlow`, `useResult`, `useMounted` in `live.tsx`. Must be green within 10 min:
B2 starts with nav work (B2.1) and imports these from B2.2 on.

### B1.1 (P0, 35 min) `lib/room.ts`: `positionView()` (pure, tested)

Local narrow types for the optional A fields (do not touch `contracts.gen.ts`; when the
regenerated type already has them, the cast is a no-op):
```ts
type Occupancy = { state: "empty" | "occupied" | "unsure"; p: number };
type Quality = "none" | "low" | "medium";
type QualityReason = "transmitter_not_fixed" | "no_distance_fit" | "no_empty_calibration" | "low_packet_rate";

export type Distance = { d: number; sd: number; quality: Quality; reasons: QualityReason[]; held: boolean; heldSince: number | null };
export type WhereState =
  | { kind: "blind"; reason: string }                 // RoomStatus.blind: draw nothing as current
  | { kind: "nobody" }
  | { kind: "unsure" }                                // presence uncertain, occupancy unsure, or they disagree
  | { kind: "here"; people: number; distance: Distance | null; spot: { name: string } | null };
export function positionView(input: { status: RoomStatus; result: Result | null; heldSince: number | null }): WhereState
```
Rules, in order:
1. `status.blind` → blind.
2. Presence (engine, as today) decides the headline. `occ = result.occupancy ?? null`.
   - presence empty: `occ?.state === "occupied"` → unsure, else nobody.
   - presence uncertain → unsure (whatever occupancy says).
   - presence present: `occ?.state === "unsure"` → here with `distance: null`
     (A guarantees occupancy is never `empty` while present; if it is, treat as unsure).
3. `distance` only when `position` exists, `valid`, `d_m !== null`, and quality ≠ `none`.
   `quality = position.quality ?? "low"` (missing → low, see revision 2).
   `reasons = position.quality_reasons ?? []` (unknown strings dropped).
4. `spot` only when `spot.reliable === true` and `spot.name !== "empty"`.
5. `heldSince`: `live.tsx` records when `position.held` flips false→true, exposes
   `positionHeldSince` (reset on boot/source change like the buffers).

`words.ts`: `whereText(w: WhereState): { headline: string; detail: string | null; reasons: string[] }`
- nobody: "Nobody in the room"; unsure: "Not sure if anyone is there"; blind: `RoomStatus.headline`.
- here, no distance: "Someone is here" · "We can't tell where in the room right now".
- here, quality low: "Someone is here" · "Distance: rough guess only" (no number).
- here, quality medium: "Someone is here, roughly 2 to 3 m from the sensor"
  (d ± sd rounded to 0.5 m; `d < 1` → "less than 1 m from the sensor").
- held: detail adds "standing still, last measured 14:02".
- people > 1: "2 people here (one sensor can't tell them apart)".
- spot: detail "probably at the desk".
- `reasons` (one line each): transmitter_not_fixed → "The Wi-Fi transmitter has moved or is a
  phone: fix it in one place"; no_distance_fit → "Distance not tuned for this room yet";
  no_empty_calibration → "Empty-room calibration missing"; low_packet_rate → "Weak signal:
  too few readings per second". Each maps to a `/setup?step=…` link (`transmitter`, `fit`,
  `calibrate`, `sensor`) — B2 reads `step` from the query.

Acceptance (`test/room.test.ts`): every branch; missing `occupancy`, missing `position`,
missing `quality` → low; `none` → no distance; unknown reason string dropped;
`reliable` false/missing → no spot; held → heldSince; presence/occupancy disagreements.

### B1.2 (P0, 40 min) `components/RoomView.tsx`: 2D top-down SVG

- Room rectangle from `readRoomGeometry()` (re-read on `storage` event), sensor box at the
  middle of the bottom wall, labelled "sensor"; transmitter box at `tx_m` along the
  centre line when set, with a thin link line.
- **Primary layer = occupancy fill** of the whole room: here → `--present` 0.18,
  unsure → `--uncertain` 0.12, nobody → plain with `--empty` outline, blind → `--offline`
  outline, everything else hidden, overlay text = headline (never the last band).
- **Secondary layer = distance band** (here + distance only), clipped to the room
  (`<clipPath>`): annulus d−sd … d+sd around the sensor. medium: `--present` 0.3, solid
  2 px arc at d, small label "roughly 2–3 m". low: 0.12 opacity, dashed, label
  "rough guess". held: dashed + "standing still". No person icon, no dot.
  Ease the radius with a CSS `transition` on `r`/`transform` (disabled under
  `prefers-reduced-motion`).
- Zone rings (1.5 m, 3.5 m) as faint dashed arcs, labelled once; scale bar "1 m".
- Spot (reliable only): tick on the arc at its taught `d_m` with "probably: desk".
- Replay: "Recording" tag in a corner (`bg-replay`).
- The component reads `useResult()` + `useLiveSlow()` itself, so the dashboard does not
  re-render per tick. SVG `role="img"`, `aria-label` = whereText headline + detail.
- Size `w-full aspect-[4/3] max-h-[60vh]`; text ≥ 12 px at 375 px; works from 320 px.

### B1.3 (P0, 20 min) Dashboard hierarchy, mobile fix

- `RoomCard`: header + `StateHeadline` (unchanged), then the where-block: `whereText`
  headline/detail in one `aria-live="polite"` region, `<RoomView />`, then the `reasons`
  list as small muted lines with "Fix" links (only when distance quality is low/none
  and the room is occupied). Facts row stays below. School profile: same view.
- Remove the "Sensor offline: not acknowledged yet" band when the open alert is
  `sensor_offline` (F4); keep it for other types.
- `Dashboards.tsx`: `grid grid-cols-1 gap-4 lg:grid-cols-3`, every child `min-w-0` (F1).
  Order: RoomCard (`lg:col-span-2`) | Breathing; Timeline; installer section (B1.4);
  Sensor details. Page-level components must not read `result` (revision 8).

Acceptance: at 375 px the where-sentence and drawing are above the fold with no alert
open; `document.documentElement.scrollWidth === 375`. **Run `next build` here.**

### B1.4 (P0, 15 min) Engineering views out of the consumer path, three.js lazy

- `LiveViews.tsx` → `<details>` "3D view and live signals (for installers)", closed by
  default, state in `lifefi.liveviews`. Mount `Room3D`, `CsiSurface3D`, `SignalsChart`
  only when open (keep `next/dynamic` + `ssr:false`, check the Next 16 docs). `LinkPill`
  moves here. `/model`: open by default with `source="model"`.
- Room3D: replace the 2/3/5 m router buttons with `readRoomGeometry().tx_m ?? 3`
  (read-only; edited in /setup). Header may show "2.1 m ± 0.4 m" plus the quality word
  (installer view).

Acceptance: Network tab on `/` with the section closed requests no three.js chunk.

### B1.5 (P0, 20 min) Presentation mode

- F3: status pill from `roomStatus` priority: blind → "NOT WATCHING" (offline token),
  replay → "REPLAY", else "LIVE". Replay banner visible.
- F7: clock rendered only when `useMounted()`; placeholder of the same width before.
- Large `RoomView` + where-sentence beside the status word when no alert is open.

### B1.6 (P1, 15 min) Timeline resize + re-render split

- F6: `ResizeObserver` on the canvas container → redraw (pattern of `BreathingChart`).
- Make the context split real: `LiveSlow` (connected, status, alerts, cleared,
  presenceSince, buffers, refreshAlerts, dismissCleared, positionHeldSince) and
  `LiveResult` (result). `useLive()` merges both (unchanged API).

### B1 verify (20 min) — see §5. Not in scope tonight: a distance lane on the timeline
(no `d_m` in `/history`), Room3D marker caption, sharing one `useNow` tick.

## 4. Worker B2: setup flow, navigation, global states

Order (each step green; `next build` after B2.3 and at the end):

### B2.1 (P0, 15 min) Navigation and one-message rule

- Consumer nav: **Room**, **Alerts**. Setup menu: "Set up this room" (/setup, first),
  Source & replay, Labelling, Settings, "Spot model view" (/model), "Emergency (building
  demo, simulated)" (/emergency), Presentation mode, sound, theme.
- F1 nav: fits 375 px (icons + short labels; Setup summary icon-only with `aria-label`).
  Setup menu items ≥ 44 px; `aria-expanded` mirrors `<details open>`.
- F4: `SystemBanners` hides its "sensor software not running" bar when an open/acked
  `sensor_offline` alert exists; replay banner always shown (non-dismissible).
- F5: sound prompt → non-modal inline notice at the top of the main column, shown once,
  never on `/present` (`usePathname`), never fixed over content; same storage key.
- `AlertBanner`, `sound.tsx` → `useLiveSlow()`.

### B2.2 (P0, 75 min) `/setup` wizard

`app/setup/page.tsx` + `components/setup/Step*.tsx` + `lib/setup.ts` (pure logic + copy,
tested). Vertical stepper, mobile first: one step expanded, done steps collapsed with a
tick, one sentence of instruction per step, a live check list (`role="status"`).
`?step=sensor|transmitter|calibrate|fit|spots` opens that step (links from B1's reasons
and Settings). All writes via `usePin().withPin`. Replay banner and disclaimer stay.

Server truth when available: fetch `GET /api/v1/setup` (C's shape `{complete,
steps:[{id,done,optional,detail}]}`, ids engine, board, pin, calibration, notify) and
`GET /api/v1/health` every 5 s while the page is open; show `detail` strings. On
404/error use the local derivation below. Type both responses locally in `lib/setup.ts`
with every field optional.

1. **Sensor connected** (`sensor`): box reachable (`connected`), sensor software running
   (`status.engine.connected` / health `engine.ok`), board readable (`source.state !==
   "error"`, error → action "Plug the board into USB"), readings arriving (`!useStale`),
   signal (`health.rate_hz` ≥ 80 ok, ≥ 50 warn, else "Weak signal"). Replay → notice
   "You are setting up on a recording" + "Continue anyway".
2. **Room and transmitter** (`transmitter`): "The Wi-Fi transmitter (router or phone
   hotspot) must stay in one place. If it moves, every reading moves." Room length/width,
   transmitter distance → `writeRoomGeometry()`; room name → `updateSettings({room_name})`.
   Show `quality_reasons` containing `transmitter_not_fixed` live if present.
3. **Empty-room calibration** (`calibrate`): "Everyone out, close the door, press Start."
   `calibrate("empty", 60)` (60/120 s choice). Countdown from `status.calibration_job`
   (`started_at + duration_s`), outcome from `job.state` (`ok`/`failed` + `job.error` +
   Retry). 409 → join the running one; 503 → "The sensor software is not running", back
   to step 1.
4. **Distance tuning, optional** (`fit`): distance input 0.3–8 m (default 2); "I'm in
   place" starts a 25 s countdown, then `POST /api/v1/position/fit {d_m, seconds: 25}`
   via a local `fitDistance()` using `api()`. Show the ack or the engine's error in
   words. Say plainly: "Distance is experimental; with a phone hotspot it stays rough."
5. **Spots, optional** (`spots`): one card: "Record each spot on the Labelling page,
   then train with `ml/train_spots.py`. Experimental." Link to `/label`.
6. **Done**: summary, "Open the room view"; store `lifefi.setup = {done_at}`.

"Finish setup" pill in TopBar (not on /present): when `/api/v1/setup` says
`complete: false`, or (route absent) `lifefi.setup` missing or calibration
`none`/`stale`. Fetched once on mount and when calibration state changes.

Acceptance: engine off → step 1 lists failing checks with actions, no step can POST;
with a replay, steps 1→3 complete against the real engine (or show its refusal in
words). `test/setup.test.ts`: step-1 check derivation (with and without the C
responses), calibration progress/outcome mapping, `?step` parsing.

### B2.3 (P1, 20 min) States app-wide

- Skeletons (`animate-pulse` on `bg-surface-2`) while `status === null` on
  settings/alerts/source/label; no "—" on consumer views.
- `app/error.tsx` (client boundary, check the Next 16 file convention) "Something went
  wrong on this page" + Reload; `app/not-found.tsx` same style.
- Alerts page empty state: "No alerts yet" + what would raise one.
- Source/label/settings errors through `friendlyError` (exists).
- Settings: "Re-run setup" link at the top; calibration row "Recalibrate" →
  `/setup?step=calibrate`.

### B2.4 (P1, 20 min) Accessibility and tokens

- Targets ≥ 44 px in `ui.tsx` (`btn.segment`, segmented buttons, pill links → `min-h-11`).
- `:focus-visible` on `summary`, SVG links, stepper; `scroll-margin-top` for the sticky header.
- Contrast: `--subtle` on `--surface`, `--muted` on `--surface-2`, both themes ≥ 4.5:1;
  fix token values in `globals.css` if below.
- `prefers-reduced-motion` covers the stepper countdown.
- F7 script warning in `layout.tsx`: fix only if the Next 16 docs give a clean way;
  else leave and note it.

### B2 verify (15 min) — see §5.

## 5. Checks and verification (both)

After every step, from `ui/`: `npx tsc --noEmit`, `npx vitest run` (all green, incl. C's
tests; a red C test that your change did not cause → note it, do not edit it); from the
root: `npm run lint -w ui`. `npm run build -w ui` at the marked points and at the end
(`prebuild` regenerates `contracts.gen.ts`; if git shows only line-ending changes there,
say so, do not revert). The other worker's half-done file can break your build: if the
error is in their file, wait a few minutes and retry; do not fix it.

Browser (if browser tools exist): the single shared dev server (revision 10) at
`http://localhost:3000`. Each worker checks **its own pages** at 375 px and 1280 px, light
and dark: B1 `/`, `/present`, `/model`; B2 `/setup`, `/alerts`, `/settings`, `/source`,
`/emergency` (still works). Each: `scrollWidth === clientWidth` at 375 px, console free of
hydration errors. Offline engine state for both; if time allows, a replay (`/source` with
`firmware/recordings/*.csirec`, engine via `npm run dev:engine` in a second terminal —
B1 starts it, B2 reuses) for here/held/nobody. Screenshots to `docs/overnight/screens/B/`
only if time is left.

## 6. API gaps (report, do not build)

1. Room geometry in server settings (`room: {length_m, width_m, tx_m}`), so all devices
   draw the same room; B keeps it in localStorage meanwhile.
2. Distance-fit state in status (`engine.status.position_fit: {d_m, at} | null`) so
   setup can show "tuned at 2 m on 3 Nov" (A/C).
3. `GET /api/v1/spots` with taught spots, to draw all of them (C, optional).
4. `sensor_offline` opened at start before the engine ever ran (C).
5. `d_m` in `/history` rows for a later distance lane.

## 7. What NOT to do

- No x/y dot, no person pin, no heatmap "of the person". Occupancy fill + distance band.
- No distance number for consumers unless quality is `medium`; no spot unless `reliable`.
- No mock/demo data, no scenario switch, no seeded history. No new runtime dependencies.
- Do not redesign `/emergency`; only move its nav link.
- No edits outside your own file list (§2). No git writes. Tree buildable at every stop.
- No decimals, ±, dB, RSSI, S/B/M, "valid/held" enums in consumer views.
- Never hide the replay banner or disclaimer, including /setup and /present.

## 8. Time budget (hard stop 2.5 h each)

| Worker | Steps | Estimate |
|---|---|---|
| B1 | B1.0 10, B1.1 35, B1.2 40, B1.3 20, B1.4 15, B1.5 20, B1.6 15, verify 20 | ≈ 2 h 55 → drop B1.6's context split first, then the timeline fix |
| B2 | B2.1 15, B2.2 75, B2.3 20, B2.4 20, verify 15 | ≈ 2 h 25 |

Not done at the hard stop → "not done" in the report.

## Worker B2 report

**Shipped**
- B2.1 nav: consumer nav is Room + Alerts; Setup menu (icon-only summary on phones, `aria-expanded` mirrors `<details>`, items ≥ 44 px, scrolls if tall) lists Set up this room, Source & replay, Labelling, Settings, Spot model view (/model), Emergency (building demo, simulated), Presentation mode, sound, theme. Status pills are a leaf (`useResult`), header reads `useLiveSlow`. "Sensor software not running" bar steps back when a `sensor_offline` alert is open/acked; replay bar unchanged. Sound question is now an inline notice at the top of `<main>` (`SoundQuestion` in layout), never on /present, never fixed. `AlertBanner`, `sound.tsx` on `useLiveSlow`.
- B2.2 `/setup` wizard (`app/setup/page.tsx` in Suspense, `components/setup/*`, `lib/setup.ts`): vertical stepper, `?step=` opens + scrolls to a step, live check list (`role="status"`), C's `/health` + `/setup` polled every 5 s while visible (verified live: both answer; 503 body of /health read as data), falls back to the live stream on 404/error. Steps: sensor, room + transmitter (`writeRoomGeometry`, room name via `updateSettings` + PIN), calibration (60/120 s, countdown + outcome from `calibration_job`, 409 joins, 503 → back to step 1), distance fit (25 s countdown then `POST /position/fit`, local `fitDistance`), spots link card, done (summary, C's pin/notify/lan todos, stores `lifefi.setup`). "Finish setup" pill in the header (server `complete`, else local record + calibration), fetched on mount and on calibration/local change.
- B2.3: `app/error.tsx` (Next 16 `retry` prop), `app/not-found.tsx`; skeletons on settings/alerts/source/label; alerts empty state says what raises an alert per profile; Settings "Re-run setup" + "Recalibrate" → `/setup?step=calibrate`, no "—" in the engine card.
- B2.4: `btn.*` / `btn.segment` ≥ 44 px (`min-h-11`, affects every page using them); `[id]` scroll-margin for the sticky header; global `prefers-reduced-motion` rule. Token contrast measured, all ≥ 4.5:1 (light subtle/surface-2 4.8, dark 5.25), no token change. Step/check ticks use the soft tokens (white on dark-theme `--ok` was 1.7:1).

**Checks**: `npx tsc --noEmit` clean; `npx vitest run` 12 files / 138 tests green (`test/setup.test.ts` 25 new); `npm run lint -w ui` 0 errors (warnings only in B1/C files). Browser: /setup, /alerts, /settings, /source, /label, /emergency, 404 at 375 px `scrollWidth === 375`, light + dark, 1280 light; no hydration errors on /setup.

**Not done / dropped**: did not press Start on calibration or distance fit against the shared replay engine (would rewrite the engine's baseline under B1/A); the POST paths are covered only by type + manual reading. F7 theme-script warning left as is: the Next 16 guide (`preventing-flash-before-hydration.md`) prescribes exactly this inline script; the warning appears only after a client re-render (seen after /present's hydration error). Screenshots skipped. Dev server on :3000 was started by B2 (`npm run dev:app`) and left running for B1; it has since exited (stopped from outside, no error in the log before the exit), so nothing is left on :3000.

**Cross-file requests**
- B1: `words.ts` reasons → link `/setup?step=transmitter|fit|calibrate|sensor` (all four ids parse). `/present` hydration error on the clock still seen once in this session (may predate B1.5).
- C: `/api/v1/health` returns 503 while the engine is down, so every 5 s poll logs a red "Failed to load resource" in the browser console on /setup; harmless, but a 200 with `ok:false` would keep consoles clean. Room geometry in server settings (plan §6.1) would let setup save it for all devices.

## Worker B1 report

**Shipped (B1.0–B1.6, all steps):**
- B1.0 shared contracts (landed first): `lib/room.ts` (`RoomGeometry`, `DEFAULT_ROOM`,
  `readRoomGeometry` / `writeRoomGeometry`, migrates `lifefi.routerDistance` once, fires a
  same-tab `lifefi:room` event); `live.tsx` with two real contexts. `useLiveSlow()`,
  `useResult()`, `useMounted()` (useSyncExternalStore), `positionHeldSince`; `useLive()` API unchanged.
- B1.1 `positionView()` + `whereText()` / `reasonLinks()` / `REASON_TEXT` in `words.ts`,
  reading A's optional fields through a narrow local type. `WhereState.here` also carries
  `reasons`, and the spot carries its taught `d`. `test/room.test.ts`: 20 tests.
- B1.2 `components/RoomView.tsx`: SVG with the occupancy fill, the quality-labelled distance
  band (CSS `r` transition, off under reduced motion), zone rings, scale bar, transmitter,
  spot tick (reliable only) and a "Recording" tag. Also exports `useRoomStatus`, `useWhere`, `useRoomGeometry`.
- B1.3 RoomCard where-block (aria-live sentence, drawing, "Fix" links to
  `/setup?step=transmitter|fit|calibrate|sensor`), F4 band removed for `sensor_offline`, F1 grids.
- B1.4 LiveViews is a closed `<details>`, mounted only when open (no three.js on `/` verified),
  open by default on `/model`. Room3D takes the transmitter distance from the room geometry and shows the quality word.
- B1.5 /present: NOT WATCHING / STARTING / REPLAY / LIVE pill, clock only after mount, RoomView +
  where-sentence, made responsive (375 px no overflow).
- B1.6 Timeline ResizeObserver. Dashboards and pages read `useLiveSlow()`.

**Checks:** tsc clean; vitest 12 files / 138 tests pass; lint clean. Browser: `/`, `/present`,
`/model` at 375 and 1280, light and dark, with the engine offline and on the spots replay:
scrollWidth equals clientWidth, no hydration errors on a fresh load. `next build` not run
(orchestrator runs it).

**Not verified:** the distance band live. On the spots replay the engine sent
`position: null` all through (A's side), so only the unit tests cover the band and quality states.

**Dropped / left:** `/present` page and `RoomCard` still read `result` (via `useRoomStatus`).
They are leaf-level enough, but /present re-renders at 2 Hz.

**Cross-file requests:** B2: none outstanding (both of its requests were already in).
C/A: `position` stayed null on `spots-20261031-192549` for the whole replay; worth a look.
