# Track M plan (final, after critic): vitals on `/` and `/model`, `/model` becomes "Insights"

Planner draft, revised by the critic on 2026-11-04 (see "Critic revisions" at the end).
Inputs: the owner's words, `../README.md` (ground rules, file ownership), last night's
`../../plans/B-ui-ux.md`, the contract at 38fb377 (`heart`, `breathing.reason`), the code
under `ui/src/{app,components,lib,server}`, and the orchestrator decisions D1-D5.

Owner: "add the heartbeat and breaths per minute in the /model and root pages and make the
/model page show more charts that are actually useful for the user and add some
collapsibles and more, and make the system have a better UI/UX."

Budget: one worker, ~75 min. Steps are ordered by value; stop at the cut line if late.

## 0. What is there now (audit, verified against the code)

| # | Finding | Where |
|---|---|---|
| A1 | `/model` is the profile dashboard with `source="model"`; only `LiveViews` opens by default and Room3D reads the spot model. Nothing explains what the system sees. | `app/model/page.tsx`, `LiveViews.tsx` |
| A2 | `BreathingCard` reads `useLive()` (whole card re-renders at 2 Hz, chart included). Its "no reading" text is `words.breathingText` (track U's file), which ignores `breathing.reason`. No heart rate anywhere. | `Cards.tsx:224`, `lib/words.ts` |
| A3 | Client history is short: `signals` ring = 120 s. No buffer has occupancy, bpm, heart, `health.rate_hz`, loss or quality. All buffers start empty on every page load. | `lib/live.tsx` |
| A4 | Server SQLite history (one row / 5 s) has no heart/occupancy/health. D2: not changed tonight. | `server/store.ts`, `server/history.ts` |
| A5 | Two hand-rolled collapsibles (`SensorDetails` = `<details>` + localStorage, `LiveViews` = `useOpen`), no shared component. | `Cards.tsx:256`, `LiveViews.tsx:36` |
| A6 | Vitest: `environment: "node"`, `include: ["test/**/*.test.ts"]`. No DOM: everything worth testing must be a pure function in a `.ts` file. | `ui/vitest.config.ts` |
| A7 | Chart tokens exist for breath, motion, deviation, rssi, distance, activity, grid, axis; none for heart, occupancy, packet rate. `globals.css` is track U's except one appended track-M block. | `app/globals.css` |
| A8 | Charts follow one idiom: `new uPlot(...)` in a `useEffect` keyed on `useResolvedTheme()`, colours via `token("--chart-…")`, ResizeObserver for width, rAF loop that skips when `buffers.version` is unchanged. Copy it, do not invent a new one. | `SignalsChart.tsx`, `BreathingChart.tsx`, `lib/useTheme.ts` |
| A9 | Server: results arrive in `runtime.ts` `engine.on("result", r => …)` with `guard(name, fn)` per consumer; route handlers use `read(fn)` from `server/http.ts`, errors via `fail(code, error, message)`, numbers via `inRange()`. Shared server singletons live on `globalThis` (see `PinLimiter` in `http.ts`). | `server/runtime.ts:153`, `server/http.ts` |

Exact field paths (use these, they are the only ones that exist):
`r.ts`, `r.boot_id`, `r.source`, `r.presence.state`, `r.motion`, `r.breathing.{bpm,valid,confidence,reason?}`,
`r.heart?.{bpm,valid,confidence,valid_share?,reason}`, `r.occupancy?.{state,p}`,
`r.position?.{valid,d_m,d_sd,held,quality?,spot?.{name,p,d_m,reliable?}}`,
`r.health.{rate_hz,loss_udp,loss_air,warmup}`, `r.link?.rssi_dbm`, `r.count?.value`.
Blind state comes from `useRoomStatus().blind` (`components/RoomView.tsx`).

## 1. Principles

- **Honest numbers.** A rate is shown only when the engine says `valid` and `bpm` is a finite
  number in the UI sanity range (breath 4..60, heart 35..200, D5: UI-only guard). Otherwise
  no number, the reason in words. Never a held or guessed number.
- **Heart is experimental everywhere** (`/` and `/model`): `Pill tone="warn"`
  "Experimental" beside the label, smaller type than breathing, the line "From one Wi-Fi
  link. Not a medical measurement." No alarm colours, no thresholds drawn on its chart.
- **Absent vs null vs invalid.** `heart` absent or `null` → "Heart rate: not measured by this
  engine yet" (muted line, no number block, no "—"). `heart.valid === false` → reason text.
  `breathing.reason` absent (older engine) → fallback derivation (§4).
- **2 Hz budget (B rule 8).** Pages, `Section` and chart hosts read `useLiveSlow()` only;
  numbers are small leaf components on `useResult()`; charts draw on rAF from buffers and
  skip when `version` is unchanged. Never `useLive()` in new code.
- **Real data only.** Charts come from live results and the server's in-memory ring of
  real results (D2). No placeholder series, no demo values; empty means an empty state.
- **No new dependencies.** uPlot for real charts, a 2D canvas for sparklines, three.js lazy
  and opt-in.
- **Copy lives in `lib/vitals.ts` / `lib/model.ts`** (track M); `lib/words.ts` is read-only
  (imports allowed).
- 375 px and dark mode (OS and forced) are acceptance criteria.

## 2. File list (all inside track M's ownership + the D2 grant)

New
- `ui/src/lib/vitals.ts` — pure: `vitalsView()`, `reasonText()`, `BREATH_RANGE`, `HEART_RANGE`.
- `ui/src/lib/model.ts` — pure, no `"use client"` (imported by server and client):
  `TrendSample` type, `trendSample(result)`, `trendSeries()` (samples → uPlot columns for a
  window), `trendStats()`, `mergeSeed()`, `readSectionOpen()` / `writeSectionOpen()`,
  `WINDOWS`.
- `ui/src/server/recent.ts` — in-memory 15 min ring of `TrendSample` (D2), `parseMinutes()`.
- `ui/src/app/api/v1/recent/route.ts` — `GET /api/v1/recent?minutes=N`.
- `ui/src/components/Section.tsx` — accessible collapsible.
- `ui/src/components/vitals/VitalsCard.tsx` — breathing + heart numbers, reasons, sparklines, wave.
- `ui/src/components/vitals/Sparkline.tsx` — tiny canvas line (no uPlot).
- `ui/src/components/model/TrendChart.tsx` — generic uPlot chart over `buffers.trend`.
- `ui/src/components/model/InsightsPage.tsx` — the `/model` page body.
- `ui/src/components/model/sections.tsx` — one small component per section.
- `ui/test/vitals.test.ts`, `ui/test/model.test.ts`, `ui/test/model-recent.test.ts`,
  `ui/test/section.test.ts`.

Edited (additive)
- `ui/src/lib/live.tsx` — `buffers.trend: RingBuffer<TrendSample>` (1800 = 15 min @ 2 Hz),
  pushed next to `signals`, cleared with the others on boot/source change; one seed fetch in
  `es.onopen` (§3). Nothing renamed or removed; `LiveBuffers` gains a field only.
- `ui/src/server/runtime.ts` — exactly one import and one line in the result handler:
  `guard("recent", () => recentBuffer().add(r));` (D2 grant; nothing else in that file).
- `ui/src/components/Dashboards.tsx` — `BreathingCard` → `VitalsCard` in Home and Clinic.
- `ui/src/app/model/page.tsx` — renders `<InsightsPage />`.
- `ui/src/components/LiveViews.tsx` — export the two `dynamic()` loaders (`Room3DLazy`,
  `CsiSurface3DLazy`) so `/model` reuses them; behaviour on `/` unchanged.
- `ui/src/app/globals.css` — append-only, at the very end:
  `/* --- track M: vitals and model --- */` with `--chart-heart`, `--chart-occupancy`,
  `--chart-rate` in the light `:root`, the OS-dark `@media` block and the forced-dark block
  (mirror the selectors used for `--chart-breath`). No `@theme` aliases needed (charts read
  tokens via `token()`).

Not touched: `contracts/**`, `contracts.gen.ts`, `words.ts`, `api.ts` (import `api` only),
`ui.tsx`, `useTheme.ts`, `TopBar.tsx` (nav label is U's, D3), `app/present/**` (D4),
`server/store.ts`, `server/history.ts` (D2), `server/context.ts`, `server/hub.ts`,
`contracts/api.md` (V's: route docs go in the worker report, §6).
`BreathingCard` stays exported from `Cards.tsx` (unused, compatibility).

## 3. Data flow

```
engine result ─► runtime.ts ─► guard("recent") ─► RecentBuffer (server memory, 15 min, 1800 TrendSample)
                     │                                   ▲ GET /api/v1/recent?minutes=15
                     └─► hub SSE (2 Hz) ─► LiveProvider ─┤ (once in es.onopen: mount + every reconnect)
                                             ├─ setResult(m) → useResult() → number leaves
                                             └─ buffers (ref)  wave 300 s, csi, signals 120 s (existing)
                                                               trend 900 s  NEW → Sparkline, TrendChart
```

`TrendSample` (lean; same object on server and client, ~20 fields × 1800 ≈ well under 1 MB):

```ts
export interface TrendSample {
  t: number;                                          // result ts, ms
  presence: "empty" | "present" | "uncertain";
  occP: number | null;                                // occupancy.p, null when absent
  breath: number | null;                              // only when valid AND in BREATH_RANGE, else null (gap)
  breathConf: number;
  heart: number | null;                               // same rule with HEART_RANGE; null when absent/invalid
  heartOn: boolean;                                   // engine sends a non-null `heart` object
  motion: number;
  d: number | null; sd: number | null;                // position.valid only
  lowQuality: boolean;                                // position.quality === "low"
  spotD: number | null;                               // position.spot.d_m when spot.reliable, else null
  rateHz: number; lossUdp: number; lossAir: number;   // health.*
  rssi: number | null;                                // link.rssi_dbm
  warmup: boolean;                                    // health.warmup
}
```
Count 2 (`count?.value === 2`) sets `breath` and `heart` to null in the sample too (one link
cannot separate two chests). `trendSample()` must not throw on an older-engine result with
every optional field missing.

**Server ring (`server/recent.ts`).** `class RecentBuffer { add(r: Result); since(ms): TrendSample[]; boot: number|null; source: string|null }`.
Plain array ring (do NOT import `RingBuffer` from `live.tsx`: it is a `"use client"` module).
`add()` clears the ring when `boot_id` or `source` changes (same rule as the client).
Singleton: `export function recentBuffer()` = `(globalThis as …)[Symbol.for("lifefi.recent")] ??= new RecentBuffer(1800)`
so route bundles and hot reloads share it (pattern from `PinLimiter`). Memory only; nothing
written to disk; gone on restart.

**Route (`app/api/v1/recent/route.ts`).**
```ts
export const dynamic = "force-dynamic";
export const GET = read((_ctx, req) => {
  const m = parseMinutes(new URL(req.url).searchParams.get("minutes"));
  if (m === null) return fail(400, "bad_request", "minutes must be a whole number 1..15");
  const rb = recentBuffer();
  return { boot_id: rb.boot, source: rb.source, now: Date.now(), samples: rb.since(Date.now() - m * 60_000) };
});
```
`parseMinutes(null)` → 15; `"5"` → 5; `"0"`, `"16"`, `"2.5"`, `"abc"`, `""` → null. Uses
`read()` so a config error answers 500 like every other route; no PIN (same as `/history`,
read-only). Response ≤ ~400 KB at 15 min.

**Client seed (`live.tsx`).** In `es.onopen`, after the existing calls:
`api<RecentReply>("/recent?minutes=15").then(rep => …).catch(() => {})`. Accept the reply only
when `lastBoot.current === null || (rep.boot_id === lastBoot.current && rep.source === lastSource.current)`.
Then `const merged = mergeSeed(rep.samples, buffers.trend.toArray())`; `buffers.trend.clear()`;
push `merged`; `buffers.version++`. `mergeSeed(seed, live)` = seed samples with
`t < (live[0]?.t ?? Infinity)` followed by `live`, capped to the last 1800. If the first live
result then has a different boot/source, the existing clear logic wipes `trend` too. No React
state is set by the seed.

**Shared snapshot (perf).** `lib/model.ts` exports `trendSnapshot(buffers)`: caches
`buffers.trend.toArray()` per `buffers.version` (module-level `{ v, arr }`), so N charts on one
tick copy the ring once, not N times. Every TrendChart and Sparkline uses it.

## 4. Vitals card (`/` home + clinic, and `/model`)

`vitalsView(result, blind)` → `{ breath: VitalView; heart: VitalView | null }`:
```ts
type VitalView = {
  value: string | null;                    // rounded integer, only when trusted
  unit: "breaths/min" | "beats/min";
  state: "reading" | "none" | "off";
  quality: "steady" | "rough" | null;      // breath: confidence >= 0.8 steady; heart: always "rough"
  text: string;                            // reason or quality line, plain words
};
```
`heart` is `null` when `result.heart` is absent or `null`.

Precedence (first match wins, applied to each vital): `blind` → off, "Not available while the
room can't be seen" · `count?.value === 2` → "Can't be read with several people in the room"
· `valid && bpm` finite and in range → reading · `valid` but out of range → "Reading out of
range: not shown" · `reason` → `reasonText(reason)` · reason null/absent → fallback:
presence empty → "Nobody to measure"; `motion >= 0.2` → motion text; else "No steady reading
right now".

`reasonText(reason)`:
| reason | text |
|---|---|
| warming_up | "Starting up: needs about 30 s of signal" |
| no_person | "Nobody to measure" |
| motion | "Can't be read while they move: needs about 30 s of stillness" |
| noise | "Signal too weak to pick out a rate" |
| unstable | "Readings disagree: waiting for a steady one" |

Component layout (`Card title="Vital signs"`):
- `VitalsCard` itself reads `useLiveSlow()` + `useRoomStatus()` only. Numbers live in a leaf
  `VitalsNumbers` on `useResult()`. Check `useRoomStatus()` — if it reads the result it is
  already a 2 Hz hook; then put it in the leaf, not the card.
- `grid grid-cols-2 gap-4` with `min-w-0` children (fits 375 px: each column ≈ 150 px).
  Left **Breathing**: `text-4xl` number + "breaths/min". Right **Heart** + Experimental Pill:
  `text-3xl` number + "beats/min". Under each: the `text` line (`text-sm text-muted`), then a
  `Sparkline` of the last 10 min (canvas, height 32, fixed y: breath 0..40, heart 40..140,
  gaps on null, `role="img"` + `aria-label="Breathing rate, last 10 minutes"`).
- Heart absent → right column is one muted line "Heart rate: not measured by this engine yet"
  (no Pill, no sparkline).
- The existing `BreathingChart` wave below with the 30 s / 5 min segmented control (keep
  `aria-pressed`), dimmed (`opacity-40`) when breath is not "reading". `BreathingChart` gets
  `buffers` from `useLiveSlow()`, so it no longer re-renders at 2 Hz.
- Visually hidden `aria-live="polite"` sentence that changes only when a vital's `state`
  changes (memo on state, not on the number).
- Footer: "Picked up from the Wi-Fi signal, for one still person near the sensor. Not a
  medical measurement. Heart rate is experimental." plus a link "See trends" → `/model#breathing`.
- School profile: unchanged on `/` (no vitals card). `/model` shows it for every profile.

## 5. `/model` page ("Insights")

Header (not collapsible): `h1` "Insights", subtitle "What the sensor sees" (D3; URL stays
`/model`), one sentence: "Everything the system reads from the Wi-Fi signal over the last
15 minutes. Open a section for its chart." Then the window control (segmented `2 min · 5 min ·
15 min`, default **15 min**, `localStorage lifefi.model.window`, read after mount, `role="group"`
`aria-label="Time window"`, buttons `aria-pressed`, `min-h-11`).
Right-now row (always visible): `VitalsCard` + the existing `RoomCard` (`lg:grid-cols-3`,
vitals spans 1, room spans 2; stacked on mobile).

Each section: header shows a live one-line summary (leaf on `useResult()`), so a closed
section still says something; the body starts with a "What this tells you" line, then the
chart, then a one-line stat from `trendStats()`.

| # | Section (id) [default] | User question | Chart | Stat line | Empty state |
|---|---|---|---|---|---|
| 1 | Presence (`presence`) [open] | Was someone there, and how sure is it? | One uPlot: `occP` line 0..1 (`--chart-occupancy`) over a presence band strip drawn in a `hooks.drawClear` callback (present/uncertain/empty tokens, `--present`, `--uncertain`, `--timeline-empty`) | "Someone there 11 of the last 15 min" | no samples → "Collecting since hh:mm"; occP all null → strip only + "This engine gives no occupancy level; showing the decision only" |
| 2 | Breathing (`breathing`) [open] | Was the breathing rate steady, and when could it be read? | Breath rate, fixed y 0..40, soft band 12..20 labelled "typical at rest" (neutral `--chart-grid` fill, no alarm colour), gaps where not read | "Read 62 % of the time · median 14 · range 12-17 breaths/min" | never read in window → "No reading in this window: <current reason>" |
| 3 | Heart rate, experimental (`heart`) [open] | Roughly what rate does the signal suggest? | Heart trend, fixed y 40..140, `--chart-heart`, no band, no thresholds; caption repeats "Experimental. From one Wi-Fi link. Not a medical measurement." | "Read 20 % of the time · median 72 beats/min" (only if ≥ 1 point) | `heartOn` false for every sample → "This engine does not estimate heart rate yet. When it does, the trend appears here." (no empty chart drawn) |
| 4 | Movement (`movement`) [open] | How much were they moving, and is that why vitals were missing? | `motion` 0..1 (`--chart-motion`) with a dashed line at 0.2 labelled "Above this, breathing and heart rate can't be read" | "Still 9 of the last 15 min" (motion < 0.2 and present) | no presence in window → "Nobody in range" |
| 5 | Where (`where`) [open] | How far from the sensor, and does the taught-spot model agree? | Distance `d` (`--chart-distance`) with ±`sd` band (uPlot `bands`), `spotD` as a dashed second series; caption from `whereText` reasons when `lowQuality`. Below: button "Show 3D room" → lazy `Room3DLazy` with a Distance / Spot model segmented toggle (state + `lifefi.section.where3d`) | "Mostly 1.5-3.5 m (middle)" or omitted | no position → "No distance yet: needs movement and about 10 s of packets"; no spot model → "No taught-spot model loaded" + link to `/teach` |
| 6 | Sensor health (`health`) [closed] | Is the signal good enough to trust the rest? | One uPlot: packet rate Hz (`--chart-rate`) with dashed lines at 80 ("good") and 50 ("poor"); RSSI as second series on a right axis (dBm, `--chart-rssi`). Beside it the existing `HealthCard` (loss, calibration, warm-up as facts, not charts) | "Avg 92 packets/s · loss 1 %" | engine offline → "No data from the engine" |
| 7 | Raw signal, for installers (`raw`) [closed] | What does the raw Wi-Fi signal look like? | Existing `CsiCanvas`, `SignalsChart`, `DetectorCard` (activity bars live here); `CsiSurface3DLazy` behind a "Show 3D surface" button | — | as today |

Cut from the draft (do not build): activity-probability lines over time, spot-p over time,
heart confidence on a second axis, a separate loss chart, "Open all / Close all".

Mobile (375 px): sections full width, chart width from ResizeObserver, height 160 px
(120 px below `sm`), uPlot legend `show: false` on the trend charts (series are named in
the section text; one or two series each), no horizontal scroll; section header button and
segmented buttons `min-h-11`.

uPlot instances with defaults open: presence, breathing, heart (only if heartOn), movement,
where, plus the vitals card wave = 6 max; Sparklines are canvases; three.js only on click.
Each TrendChart: one rAF loop, skip when `buffers.version === drawn`, data from
`trendSnapshot()`, x = seconds ago (`time: false`, range `[-window, 0]`) like SignalsChart,
destroy on unmount and recreate on theme change (A8 idiom).

## 6. `Section` component

```tsx
<Section id="breathing" title="Breathing" subtitle="Rate over time" defaultOpen summary={<BreathSummary />}>…</Section>
```
- `<section aria-labelledby={hId} className="rounded-card border border-line bg-surface shadow-sm scroll-mt-20" id={id}>`.
- `<h2 className="m-0"><button type="button" id={hId} aria-expanded={open} aria-controls={bodyId}
  className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left sm:px-5 focus-visible:…">`
  with `Icon name="chevron"` (`aria-hidden`, `rotate-90` when open, `motion-safe:transition-transform`),
  title, subtitle (`hidden sm:inline text-sm text-muted`), and `summary` right-aligned
  (`ml-auto truncate text-sm tabular-nums`, `min-w-0`).
- Body `<div id={bodyId} role="region" aria-labelledby={hId} className="border-t border-line p-4 sm:p-5">`,
  rendered only when open (unmount stops rAF loops and three.js). Native button gives
  Enter/Space; use the existing focus-ring classes from `btn` in `ui.tsx`.
- Do not put the live `summary` inside the button's accessible name in a way that re-announces:
  give the summary `aria-hidden="true"` and render the same text in the region's first line,
  or keep it outside the button. (A 2 Hz changing button name is noisy for screen readers.)
- Open state: `useState(defaultOpen)`; after mount `readSectionOpen(localStorage, id, defaultOpen)`
  (effect + eslint-disable idiom as `LiveViews.useOpen`); on toggle `writeSectionOpen`.
  Key `lifefi.section.<id>`, values "1"/"0"; helpers take `Storage | null`, try/catch inside.
- If `location.hash === "#" + id` on mount: open it and `scrollIntoView` (the vitals card's
  "See trends" link).
- `Section` reads no live context.

## 7. Implementation steps (each step ends with `npm run typecheck` + `npm run lint` + vitest green)

| Step | Pri | Min | What |
|---|---|---|---|
| 1 | P0 | 10 | `lib/vitals.ts` + `test/vitals.test.ts`. |
| 2 | P0 | 10 | `lib/model.ts`: `TrendSample`, `trendSample`, `trendSeries`, `trendStats`, `mergeSeed`, `trendSnapshot`, section helpers + `test/model.test.ts`, `test/section.test.ts`. |
| 3 | P0 | 8 | `live.tsx`: `buffers.trend`, push, clear. `VitalsCard` + `VitalsNumbers` + `Sparkline`; swap in Home and Clinic. Check `/` at 375 px, light + dark. |
| 4 | P0 | 10 | `server/recent.ts` + route + runtime hook line + client seed in `es.onopen` + `test/model-recent.test.ts`. Check with `curl "localhost:3000/api/v1/recent?minutes=2"` against a replay, and `?minutes=99` → 400 JSON. |
| 5 | P0 | 8 | `Section.tsx`. |
| 6 | P0 | 12 | `TrendChart` (series spec `{label, token, pick, dash?, scale?}`, window, fixed y-range, horizontal guide lines + band via draw hooks, empty state < 2 non-null points). |
| 7 | P0 | 12 | `InsightsPage` header, window control, right-now row, sections 1-4; `app/model/page.tsx` renders it. globals.css track-M block. |
| 8 | P1 | 7 | Section 5 (Where: distance vs spot chart, lazy 3D on click; export loaders from LiveViews). |
| — | — | — | **Cut line (~77 min).** Below only if ahead, in this order. |
| 9 | P2 | 5 | Section 6 (health). Without it, health is still on `/` in Sensor details. |
| 10 | P2 | 4 | Section 7 (raw), reusing existing components. |
| 11 | P3 | 5 | `SensorDetails` / `LiveViews` on `/` switched to `Section` for one look. Skip if anything is shaky. |

If at step 7 time is short: ship sections 1-3 (presence, breathing, heart) — those carry the
owner's request — and leave movement/where for the next run, with `/model` still rendering.
Never leave `/model` without the Where comparison and without its old content: if step 8 is
not reached, put the old `<LiveViews source="model" />` at the bottom of `InsightsPage` so the
spot-model comparison is not lost.

## 8. Acceptance criteria

1. `/` (home, clinic) shows "Vital signs": breaths/min and heart beats/min (labelled
   Experimental, smaller) when valid; heart absent → the "not measured by this engine yet"
   line, never "—". School `/` unchanged.
2. No number when `valid` is false, `bpm` is null/non-finite/out of range, the room is blind,
   or 2 people are counted; the reason is shown in words.
3. `/model` title "Insights", subtitle "What the sensor sees"; header, right-now row and
   sections 1-5 (6, 7 if done). Each section has a what-it-tells-you line, a header summary,
   a stat line and an empty state. Distance vs spot-model comparison still reachable.
4. After a reload with the engine running a replay, charts already show up to the last
   15 min (seeded from `/api/v1/recent`), not an empty plot. Reconnect does not duplicate
   points. A new boot or source switch clears them.
5. `GET /api/v1/recent?minutes=N`: 1..15 → 200 `{boot_id, source, now, samples}`; anything
   else → 400 `{error:"bad_request", message}`; missing → 15 min. Nothing written to disk.
6. Section state survives a reload per section; throwing localStorage → defaults, no crash.
   Keyboard: Tab to header, Enter/Space toggles, `aria-expanded` flips, `aria-controls` = body id.
7. No three.js chunk is requested on `/model` until "Show 3D room"/"Show 3D surface" is clicked.
8. 375 px: no horizontal scroll on `/` and `/model`; touch targets ≥ 44 px. Dark (OS and
   forced): every line, band and strip uses tokens and is readable.
9. New page-level components do not call `useResult()`/`useLive()`; `BreathingChart` is no
   longer under a 2 Hz re-render; charts copy the ring at most once per tick (`trendSnapshot`).
10. `runtime.ts` diff is one import + one line. No file outside §2 is edited.
11. `npm run typecheck`, `npm run lint`, `npm test` green.

## 9. Tests (vitest, node)

- `vitals.test.ts`: each reason → text; valid in-range → rounded value + steady (conf ≥ 0.8) /
  rough; valid out of range (breath 70, heart 250) → no value + out-of-range text; `heart`
  absent → `heart: null`; `heart: null` → `null`; `heart.valid=false, reason=null` → fallback
  text; `breathing.reason` absent → fallback (empty, motion ≥ 0.2, else); blind → both off;
  count 2 overrides a valid reading for both.
- `model.test.ts`: `trendSample` on a full result and on one with every optional field
  missing; count 2 → breath/heart null; `trendSeries` cuts to window relative to the newest
  sample, x in seconds-ago, nulls kept as gaps, empty → empty columns; `trendStats` share /
  median / min / max with nulls ignored and an all-null input; `mergeSeed` keeps seed before
  the first live t, drops overlap, caps at 1800, empty seed / empty live.
- `section.test.ts`: `readSectionOpen` default with no key, "1"/"0", null storage, throwing
  storage; `writeSectionOpen` key `lifefi.section.<id>`, swallows a throwing `setItem`.
- `model-recent.test.ts`: `RecentBuffer` wrap at capacity, `since()` filter, clear on boot or
  source change; `parseMinutes` cases from §3. (No route-handler test: `read()` would start the
  runtime; the parse and buffer carry the logic.)

Browser (orchestrator, replay of `data/sessions/spots-*/*.csirec` through the engine):
`/` and `/model` at 375 px and desktop, light and dark, screenshots; console free of errors
and hydration warnings; reload after 2 min → charts seeded; toggle sections, reload, state
kept; keyboard-only toggle; network tab: no three.js chunk until the 3D button; leave
`/model` open 5 min, CPU stays flat.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Track V not merged / older engine: `heart`, `reason`, `occupancy` absent | Every path handles absent; tests cover it; empty states say so. |
| Seed and live overlap or come from another boot | `mergeSeed` by time; accept seed only for the same boot/source; existing clear rule. |
| Server ring in a different module instance than the route | `globalThis` + `Symbol.for` singleton, like `PinLimiter`/`getRuntime`. |
| Importing a `"use client"` module on the server | `TrendSample` and helpers live in `lib/model.ts` (no directive); server never imports `live.tsx`. |
| CPU at 2 Hz with 6 charts | `trendSnapshot` once per version, rAF skip, closed sections unmount, Sparkline is canvas. |
| Heart read as medical | Experimental Pill, smaller type, caption, no bands or thresholds, sanity range → no value. |
| Live summaries in header buttons spam screen readers | Summary `aria-hidden` / outside the button (§6). |
| Hydration mismatch from localStorage | Defaults on server, read after mount. |
| Track U edits `globals.css`, `ui.tsx`, `words.ts` concurrently | Append-only block at the end; import-only use of U's exports. |

## 11. Worker report must include

- Text for `contracts/api.md` (track V's file) describing `GET /api/v1/recent?minutes=N`:
  "In-memory samples of the last N minutes (1..15, default 15) of results since the current
  boot and source, one per result (2 Hz): `{boot_id, source, now, samples: TrendSample[]}`
  with the `TrendSample` fields from `ui/src/lib/model.ts`. Kept in server memory only, lost on
  restart, never written to disk. 400 bad_request for any other `minutes`."
- Request to track U: `/present` and `words.breathingText` can switch to `vitalsView()` later (not tonight, D4).
- Any deviation from this plan and why.

## Critic revisions

1. **Folded in D1-D5.** Heart on `/` (smaller, Experimental). `/model` titled "Insights" /
   "What the sensor sees", URL kept, nav untouched. `/present` untouched. Ranges are UI-only.
2. **Added the D2 server ring + `GET /api/v1/recent`** (§3) and the client seed in `es.onopen`,
   with `mergeSeed` (no duplicates on reconnect), boot/source guard, `globalThis` singleton,
   bounded `minutes` (1..15) and `fail()` errors. Removed the "collecting since page open"
   framing and the P3 SQLite-history breathing view; window default raised to 15 min since data
   now exists on load.
3. **Fixed real-code mismatches:** health fields live under `r.health.*` (`rate_hz`, `loss_*`,
   `warmup`), not top level; `RingBuffer` is in a `"use client"` module so the server must not
   import it, hence `TrendSample` and helpers in a directive-free `lib/model.ts`; blind comes
   from `useRoomStatus()` in `RoomView.tsx`; chart idiom (theme-keyed effect, `token()`) spelled
   out; no `@theme` aliases needed.
4. **Perf:** `trendSnapshot()` copies the 1800-sample ring once per tick for all charts instead
   of per chart; Sparklines are canvases instead of extra uPlot instances; `VitalsCard` no
   longer re-renders `BreathingChart` at 2 Hz (today's `BreathingCard` uses `useLive()`);
   three.js only on an explicit click, so default `/model` loads no three.js.
5. **Cut charts that do not answer a user question:** activity-probability spaghetti (6 lines),
   spot-p over time, heart confidence on a dual axis, a separate loss chart, Open/Close all.
   **Added what users ask:** per-section stat lines from `trendStats()` (share of time read,
   median, range; time present; time still) and a movement threshold labelled as the reason
   vitals go missing. Health merged into one chart (rate + RSSI) with facts beside it.
6. **Accessibility:** live summary must not sit in the button's accessible name at 2 Hz;
   `aria-pressed` segmented controls, `min-h-11` targets, `motion-safe` chevron, hash deep link
   with scroll, `aria-live` only on state changes.
7. **Scope:** re-ordered to fit 75 min with an explicit cut line; health and raw sections are
   below it (they exist on `/` already); a fallback keeps the old `LiveViews source="model"` on
   `/model` if Where is not reached, so the spot-model comparison is never lost.
8. **Ownership:** `runtime.ts` hook limited to one import + one line; `contracts/api.md` text
   moved to the worker report; test file named `model-recent.test.ts` to stay inside the
   `model*` test pattern M owns; explicit "not touched" list extended (`useTheme.ts`,
   `context.ts`, `hub.ts`, `TopBar.tsx`, `present/**`).
