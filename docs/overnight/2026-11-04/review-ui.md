# UI review: tracks M (8843490) and U (e683666)

Independent code review, read-only. `npm run typecheck`, `npm run lint` and `npm run test:ui` all pass (21 files, 225 tests).
Every finding below was checked against the code; line numbers are at 8843490.

## Medium

### 1. Movement chart says vitals stop above 0.2, but the engine stops them at 0.1
`ui/src/components/model/sections.tsx:165-170, 182, 185`.
The engine marks someone as moving when `M_now > m_on` (`engine/lifefi/engine.py:352`). `presence.motion_level` maps `m_on` to **0.1** (`presence.py:91-95`), and the server uses the same 0.1 as `MOTION_ON` (`ui/src/server/rules.ts:12`). Any motion above 0.1 resets `quiet_for` and gives breathing and heart `reason: "motion"`. The dashed guide reads "Above this, breathing and heart rate can't be read", but it is drawn at `STILL_BELOW = 0.2`. The "Still N min" stat also counts motion < 0.2.
Scenario: the person fidgets at 0.15 for 10 minutes. The line stays under the guide, the stat says "Still 10 min", and the Breathing section says "Can't be read while they move" the whole time.
Fix: set `STILL_BELOW` to 0.1 (import a shared `MOTION_ON` into lib, not from server). Change the `vitals.ts:305` fallback the same way.

### 2. The Where stat line gives a precise median from low-quality distances; `lowQuality` is computed but never used
`ui/src/lib/model.ts:63` and `ui/src/components/model/sections.tsx:236, 245`.
`trendStats(rows, s => s.d)` uses every valid `d`, including samples with `quality === "low"`. The line then reads "Mostly near, under 1.5 m · median 1.2 m" with no "rough" qualifier. The chart draws low-quality points the same way as good ones. `TrendSample.lowQuality` is filled in but nothing reads it.
Scenario: a room where every distance has quality "low" (spot model not taught, few packets). The header says "about 1.2 m · rough", but the stat line states the median as a plain fact.
Fix: when most samples in the window are `lowQuality`, add "· rough guess" (or "(rough)") to the stat line. Optionally draw low-quality samples dimmed, or as a separate dashed series.

### 3. Quality check differs from `qualityOf`: an older engine's distance is never marked rough
`ui/src/components/model/sections.tsx:210` and `ui/src/lib/model.ts:63`.
`lib/room.ts:94-98` (`qualityOf`) treats a missing `quality` as "low" ("an older engine, which is exactly the unreliable one"). `WhereSummary` and `trendSample` test `p.quality === "low"` directly. With an engine that leaves `quality` out, the Insights header shows "about 2.3 m" as if it were trustworthy, while `Room3D` on the same page says "rough guess only".
Fix: use `qualityOf(pos) === "low"` in both places.

### 4. A reconnect leaves the disconnect gap empty, although the server holds those samples
`ui/src/lib/model.ts:152-156` (`mergeSeed`) and `ui/src/lib/live.tsx:174-186`.
`mergeSeed` keeps only seed samples older than the **oldest** live sample. After a drop from T0 to T1, the client already has samples up to T0. So every server sample in (T0, T1) is thrown away, and the charts show a hole. `secondsWhere` caps the step at 2 s, so "Someone there N min" and "Still N min" also undercount by the length of the outage, although the server saw the whole period. The comment says the merge prevents duplicates, but it also drops the useful part.
Fix: merge by time. Take the seed samples whose `t` falls outside every span the live ring already covers (in practice, `t < first` or `last_before_gap < t < first_after_reconnect`), or rebuild from the seed plus the live samples newer than `seed.at(-1).t`.

## Low

### 5. Header "No distance" sits next to a distance chart and a median
`ui/src/components/model/sections.tsx:209` and `:245`.
The header shows only the current result. The body shows the whole window. When the person has just gone still and `position.valid` is false, the header says "No distance", right above a stat line like "Mostly middle · median 2.1 m". The task brief named this exact contradiction.
Fix: header text "No distance right now", or the last valid value with its age ("2.1 m, 40 s ago").

### 6. "Can't be read while they move" while Movement says "Very still"
`ui/src/lib/vitals.ts:268` vs `ui/src/components/model/sections.tsx:172-176` (`activityText`).
The engine's `motion` reason means "moved within the last `low_motion_s` (about 30 s)" (`engine.py:471`). The current motion level is often already < 0.06 by then, so the two headers side by side read "Very still" and "Can't be read while they move".
Fix: reword to "Moved in the last 30 s: needs about 30 s of stillness" (or "Waiting for 30 s of stillness").

### 7. The Heart section says "This engine does not estimate heart rate yet" when there is simply no data
`ui/src/components/model/sections.tsx:142, 150-157`.
`on = rows.some(s => s.heartOn)` is false whenever `rows` is empty: before the first result, right after a source or boot change clears the ring, or when the engine is offline. The page then tells the user the engine has no heart estimator, which is false for the current engine.
Fix: if `rows.length === 0`, show `NO_DATA`. Show the "does not estimate" text only when there are rows and none has `heartOn`.

### 8. Charts and sparklines show frozen data as "now" when results stop
`ui/src/components/model/TrendChart.tsx:212-213` and `ui/src/components/vitals/Sparkline.tsx:314`.
Both anchor x = 0 ("now") to the newest **sample**, not to the clock. When the sensor stops reporting, the last breathing and heart points stay at the right edge as if current. The top bar does say "No new readings", but the vitals sparkline next to it looks live.
Fix: anchor at `max(newest.t, Date.now() - skew)`, or dim the charts while `useStale` is true.

### 9. The settings Save sends every field from a form loaded once at mount (lost update)
`ui/src/app/settings/page.tsx:61-65, 116-123`.
The form is fetched only on mount. Save sends `notify` (topic, ntfy_url), `zone`, `dashboard_url`, `room_name` and `contact_phone`, whether or not they changed. If the setup wizard or another device changed any of them while this page was open, Save silently puts the old values back. Example: a topic generated elsewhere is replaced by an empty one, which turns phone alerts off.
Fix: send only the fields that differ from `saved` (diff `form` against `saved`). Better still, also refetch on focus or show a warning when the server copy changed.

### 10. The ntfy topic hint says "20 or more characters", but nothing enforces it
`ui/src/app/settings/page.tsx:239-241` and `ui/src/app/api/v1/settings/route.ts` (the notify block).
The topic is the only secret protecting the alert feed. Anyone who guesses it can read the alerts. A short topic like "alerts" saves without complaint on both the client and the server.
Fix: in the client, mark the field invalid when the topic is non-empty and under 20 characters, and block Save. In the server, return 400 for the same case (an empty topic still means notifications are off).

### 11. Section: `aria-controls` points to an element that is not in the DOM while closed, and landmarks are doubled
`ui/src/components/Section.tsx:396, 410-414, 390`.
- While collapsed, `bodyId` is not rendered, so `aria-controls` refers to a missing id. Some screen readers announce a broken relation.
- The `<section aria-labelledby>` is already a named region landmark, and the open body adds a second `role="region"` with the same name. On /model that makes 14 region landmarks with duplicate names.

Fix: set `aria-controls` only when `open` (or always render the body with `hidden`), and drop `role="region"` from the inner div.

### 12. Field wraps a button inside the `<label>`, which pollutes the input's accessible name
`ui/src/components/ui.tsx` (`Field`) together with `ui/src/app/settings/page.tsx:239-246, 257-264`.
The Topic and Dashboard address fields put the "generate" and "this address" buttons inside the `<label>`. The input's name becomes "Topic generate Secret, 20 or more characters." Also, a click on the label's text can land on the wrong control in some browsers.
Fix: pass `htmlFor`/`id` to Field and render the row buttons outside the `<label>`, or give the input an explicit `aria-label` and `aria-describedby` for the hint.

### 13. `/recent` sends up to ~0.5 MB on every page open and every SSE reconnect
`ui/src/app/api/v1/recent/route.ts:6-9` and `ui/src/lib/live.tsx:174`.
The client always asks for `minutes=15`: 1800 samples of 19 keys each (about 250–300 B of JSON per sample). With a flapping connection (backoff starts at 0.5 s), every reconnect downloads the full window again, mostly samples the client already has. Memory is bounded (1800 entries) and nothing goes to disk, so this costs bandwidth only.
Fix: let the client send `?since=<first live t>` (or the last t before the gap, see #4) so the server returns only the missing samples.

## Checked and fine
- `recent.ts`: the ring index arithmetic is correct, `since()` returns samples oldest first, the ring clears on a new boot or source, `parseMinutes` accepts only whole numbers 1..15, errors use the shared `fail()` JSON, and nothing is written to disk.
- Seeding race: a seed from another boot or source is dropped, and a fresh page that adopts the seed's boot clears correctly on the first live result from a different one. No duplicates.
- Every TrendChart spec and sparkline range is a module constant, so charts are not recreated per tick. Charts use `setData` on rAF and are destroyed with their ResizeObserver disconnected. `trendSnapshot` copies the ring once per version.
- Heart: shown only when `valid` and within 35–200 bpm, never with 2 people, and always carries the Experimental pill or label. Breathing follows the same rule.
- localStorage access is wrapped in try/catch everywhere. Section, window and settings state are read after hydration, so there is no hydration mismatch.
- Settings: an emptied number field cannot save 0; changing the PIN leaves unsaved edits alone; the server re-validates zone, retention and PIN.

## Fixes applied

UI polish worker, 2026-11-04. Files: `ui/src/**` and `ui/test/**` only (no engine, contract, `validate.ts` or `contracts.gen.ts` edits).

Review findings:
1. **Fixed.** One constant `MOTION_ON = 0.1` in `lib/vitals.ts` (with `STILL_FOR_S` = 20 s breathing / 30 s heart from rules.yaml). `server/rules.ts` re-exports it instead of its own literal. `STILL_BELOW` in `model/sections.tsx` is now `MOTION_ON` (export kept). The guide, the "Still N min" stat and the old-engine fallbacks in `vitals.ts` and `words.breathingText` all use it.
2. **Fixed.** Where chart: low-quality distances are drawn as a separate thin dotted series. The stat line becomes "Rough guess only: mostly …" with no median when at least half of the read distances are rough.
3. **Fixed.** `trendSample.lowQuality` and `WhereSummary`/`WhyRough` use `qualityOf()` from `lib/room.ts`, so a missing quality reads as low and only "medium" counts as more than a rough guess.
4. **Fixed.** `mergeSeed` merges by time: every seed sample whose t the live ring lacks, with the live sample winning on equal t. That fills gaps inside the ring and after its newest sample. `live.tsx` skips live results already covered by the seed (`seededUpTo` guard, reset on the first newer result or a boot/source clear). New tests: gap inside the ring, outage before reconnect.
5. **Fixed.** The header says "No distance right now", "about 2.1 m now", or "rough guess, about 2.1 m". It is clearly about this moment, not the window.
6. **Fixed.** The engine's `motion` reason now reads "Moved recently: waiting for about 20 s (breathing) / 30 s (heart) of stillness". The old-engine fallback claims movement only when the current motion is above `MOTION_ON`. Otherwise it says "No reading yet".
7. **Fixed.** Heart section: no rows means "No data from the engine yet". It says "not estimated by this engine" only when rows exist and none has `heartOn`. Same rule for the header summary and the vitals card's heart column, which shows "—" and "Waiting for a reading" before the first result.
8. **Fixed (dim, not re-anchor).** New `vitals/StaleDim.tsx`: a 2 Hz leaf that dims trend charts and sparklines when the last result is older than 3 s. Trend charts also show "No new readings: last values shown". The x axis is still anchored to the newest sample, because browser and engine clocks may differ.
9. **Fixed.** Save sends only the fields that differ from the loaded copy (`changedSettings` in `lib/notify.ts`, notify field by field). The route already merges partial updates. Not done: refetch on focus.
10. **Fixed (no lock-out).** `topicCheck` in `lib/notify.ts`, shared by the client and `PUT /settings`. A new non-empty topic under 20 characters is refused: the client blocks Save and the server returns 400, checked before anything is applied. The short topic an install already has is accepted, with a warning in the form. Empty still means off.
11. **Fixed.** `aria-controls` is set only while the body is rendered. The inner `role="region"` is dropped, so the `<section>` is the one named region.
12. **Fixed.** `Field` takes an optional `htmlFor` (backward compatible). With it, only the label text is in the `<label>`, and the hint gets id `<id>-hint`. Topic and Dashboard address use it with `aria-describedby`, and the row buttons are outside the label.
13. **Fixed.** `/recent` accepts `since=<ms>` (`parseSince`, tested). On a reconnect the client asks only for samples after its newest one. The first load still gets the full 15 min.

Browser check:
1. **Fixed.** Even x ticks per window (30 s / 1 min / 3 min steps). Right padding is 16 px unless a right axis exists, so "now" is not clipped.
2. **Fixed.** Guide labels are drawn at the left end of the line. The Movement label now reads "Above this counts as moving: vital signs pause".
3. **Fixed.** The vitals card number slot keeps its size and shows "—". The reason sits on the small line underneath, like the quality line of a reading.
4. **Fixed.** Neutral "No reading yet" fallback. The engine's `motion` reason is worded as "moved recently" (see review #6). Recheck in the browser with track V's engine.
5. **Fixed.** See review #2, #3 and #5.
6. **Fixed.** The Insights header stacks below `sm`. The window control sits under the title, left-aligned.
7. **Fixed.** `lg:self-start` on the /model vitals card.
8. **Fixed.** "1 packet/s" in the Sensor health header and stat line.

Not browser-checked by the worker (no dev server, per instructions).
