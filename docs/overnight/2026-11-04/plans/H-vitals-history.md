# Track H: long-term vital-sign trends ("how was the night?")

Planner: H. Critic: revised (see "Critic revisions" at the end). One worker, about 60 min, medium
effort. Starts **after** the UI fix worker (Insights and settings polish) has finished, and
**re-reads** every file in §9 before editing (they may have changed since this plan was written).

## 1. Findings (current state, verified by the critic)

| What | Where | Fact |
|---|---|---|
| SQLite binding | `ui/src/server/store.ts:4` | Node's built-in `node:sqlite` (`DatabaseSync`), Node v24.8. Synchronous; `exec`, `prepare`, `.all/.get/.run`. No busy timeout is set today. |
| Row cadence | `ui/src/server/history.ts:14-25` | One row per 5 s bucket (`t = floor(ts/5000)*5000`), `INSERT OR REPLACE`: the **last** result of its 5 s bucket (a point sample). 24 h = 17 280 rows max. |
| Schema | `store.ts:22-31, 63-82` | `history(t INTEGER PRIMARY KEY, presence, motion, breathing_bpm, breathing_valid, posture, count)`; `t` is the rowid, so a `t` range scan is already indexed. `CREATE TABLE IF NOT EXISTS`, no migration, no `user_version`. WAL is set (file DBs) **before** `exec(SCHEMA)`; all statements are prepared right after it. |
| Stored today | `history.ts:18-23` | Motion always; raw `breathing_bpm` + `breathing_valid`, both null when the profile's `breathing.store` is false. Heart **not stored**. `count` stored. |
| Profile gate | `runtime.ts:171`, `contracts/profiles.yml` | `history.add(r, profiles.profiles[settings.value.profile].breathing.store)`; home and clinic `true`, school `false`. |
| Heart in results | `lib/contracts.gen.ts:134` | `heart?: null \| {bpm: number \| null, valid: boolean, confidence, snr?, valid_share?, reason?}`. Absent/null on older engines or `heart.publish: false`. |
| API | `app/api/v1/history/route.ts` | `GET /history?from=&to=&fields=` → `{rows}`; span not bounded (pre-existing, out of scope). Route handlers wrapped in `read()` (`http.ts:202`), not unit-tested (runtime starts). `ctx` has `history`, `settings`, `profiles`. |
| Validity rules | `lib/vitals.ts:9-17, 66` | `BREATH_RANGE [4,60]`, `HEART_RANGE [35,200]`, `inRange()`, and the **shared `MOTION_ON = 0.1`** already exist there (UI fix worker landed it; `sections.tsx:172` `STILL_BELOW = MOTION_ON`, `server/rules.ts:11` imports it). File has no directive: server may import it. |
| Insights | `components/model/InsightsPage.tsx:44-83` | Sections presence, breathing, heart, movement, where, health, raw; intro sentence at line 45. `ExperimentalPill` and `HEART_CAPTION` exported from `components/vitals/VitalsCard.tsx`. `safeStorage()` in `lib/model.ts:242`. uPlot ^1.6.31 installed. |
| Retention | `settings.ts`, `store.ts:119-125` | `retention_days` default 30; purge deletes whole rows `t < cutoff`, so new columns follow it unchanged. |
| Real DB | `data/lifefi.sqlite` (+ `-wal`, `-shm`) | Old-schema DB on this machine; migration runs on it at the next `npm run dev`. Tests and manual checks must never open it. |

## 2. Decisions

- **D1. Storage.** Two new nullable columns, mirroring breathing: `heart_bpm REAL` (null unless
  heart is `valid` and `bpm` finite) and `heart_valid INTEGER` (1/0; null when the result has no
  `heart` or the profile does not store vitals). Breathing columns unchanged. No other columns.
- **D2. Privacy default: store under the existing `breathing.store` flag.** Heart follows
  breathing: school stores neither (nothing new for school). Local SQLite only, same retention.
  No new settings switch tonight (owner question Q-H1).
- **D3. Migration** (safe for real users' DBs):
  - New columns are also in `CREATE TABLE` so fresh DBs are complete.
  - After `exec(SCHEMA)` and **before any `prepare`**: `PRAGMA busy_timeout = 5000` (all DBs,
    harmless for `:memory:`), then `migrate()`:
    `BEGIN IMMEDIATE` → read `PRAGMA table_info(history)` **inside** the transaction → `ALTER
    TABLE history ADD COLUMN …` for each missing column → `PRAGMA user_version = 1` (only if it
    is < 1) → `COMMIT`; on any error `ROLLBACK` and rethrow with message
    `history migration failed: …`.
  - Why: `BEGIN IMMEDIATE` + re-check inside serialises two processes opening the same file
    (second one sees the columns and does nothing, instead of failing with "duplicate column");
    busy_timeout waits instead of throwing `SQLITE_BUSY` while the other process writes; the
    transaction makes a failure mid-migration all-or-nothing (SQLite DDL is transactional).
  - `ADD COLUMN` without default is a schema-only change: no row rewrite, O(1).
  - **Downgrade**: an older build still works on a migrated file: it inserts the 7 named columns
    (new ones become NULL), reads `SELECT *` and ignores unknown keys, never reads `user_version`.
    Its `INSERT OR REPLACE` drops heart for that 5 s row, which is acceptable.
  - `user_version` is informational for future migrations; the column check is the guard.
- **D4. Aggregation on the server, new sub-route** `GET /api/v1/history/vitals`. Pure functions
  in new `server/vitals-history.ts`, unit-tested without the runtime. `GET /history` unchanged
  except `fields` accepts `heart`.
- **D5. UI: separate section "Last hours"** on Insights with its **own** 1 h / 6 h / 24 h control
  (default 24 h). The global 2/5/15 min control stays for the in-memory sections.
- **D6. Buckets fixed by range:** 1 h → 60 s (≤ 61 buckets), 6 h → 5 min (≤ 73), 24 h → 10 min
  (≤ 145; first/last may be partial).
- **D7. Honesty rules (one place, `server/vitals-history.ts`):**
  - A row is **present** when `presence === "present"`.
  - A row is a **breath reading** when present, `breathing_valid = 1`, `inRange(breathing_bpm,
    BREATH_RANGE)` and `count !== 2`. Heart likewise with `heart_valid = 1`, `HEART_RANGE`.
    (Same rules as `lib/vitals.ts`; requiring "present" keeps share ≤ 100 %.)
  - A bucket's median is shown only with at least `MIN_READINGS = 3` readings (15 s of reading);
    otherwise `med/q1/q3 = null` → a **gap**, never a number from one stray row.
  - "Share of time read" = readings / present rows, over **present rows only**, computed over the
    whole range (not averaged per bucket). Empty when present rows = 0.
  - Range summary median/quartiles are computed from **all readings in the range** (not a median
    of bucket medians), and also need `MIN_READINGS`.
  - **Still** = present and `motion < MOTION_ON` (imported from `@/lib/vitals`). Still time =
    still rows × 5 s.
  - Heart is labelled experimental everywhere it appears (pill + caption).

## 3. API shape

`GET /api/v1/history/vitals?hours=H&to=T`

- `hours`: `1`, `6` or `24` only (the three UI choices; anything else 400), default 24.
- `to`: ms since epoch, default now; finite and `<= now + 60 000`. `from = to - hours × 3 600 000`.
  Bucket start = `floor(t / bucketMs) × bucketMs`.
- Errors: `fail(400, "bad_request", "hours must be 1, 6 or 24")` and
  `fail(400, "bad_request", "to must be ms since epoch, not in the future")`.
- Reply (`VitalsHistoryReply`):

```json
{
  "from": 1767139200000, "to": 1767225600000, "bucket_s": 600, "stored": true,
  "summary": {"n": 17000, "present_n": 9000, "still_n": 8100,
              "breath_n": 5600, "breath_med": 13.8, "breath_q1": 12.9, "breath_q3": 14.6,
              "heart_on_n": 9000, "heart_n": 1200, "heart_med": 61.0, "heart_q1": 58.2, "heart_q3": 64.0},
  "buckets": [
    {"t": 1767139200000, "n": 120, "present_n": 118, "still_n": 109, "motion_med": 0.03,
     "breath_n": 74, "breath_med": 13.8, "heart_on_n": 118, "heart_n": 20, "heart_med": 61.0}
  ]
}
```

- Only buckets with at least one row are returned; the client inserts a null between buckets more
  than one bucket apart (gap = no data).
- `*_med` / `*_q1` / `*_q3` null when the matching `_n < MIN_READINGS`. `motion_med` over present
  rows, null when `present_n = 0`. Bucket entries carry medians only (no quartiles: the band is cut).
- `heart_on_n` = present rows with `heart_valid` not null (lets the UI say "not measured" rather
  than "no reading" for data from before this update or an engine without heart).
- Quantiles: sort + linear interpolation; breath/heart rounded to 0.1, motion to 0.01.
- `stored` = `ctx.profiles.profiles[ctx.settings.value.profile].breathing.store`.
- Cost: one prepared `SELECT t, presence, motion, breathing_bpm, breathing_valid, heart_bpm,
  heart_valid, count FROM history WHERE t >= ? AND t < ? ORDER BY t` (rowid range, indexed),
  ≤ 17 280 rows; one pass grouping into buckets, per-bucket arrays ≤ 120 values sorted, plus one
  sort of the range's readings (≤ 17 280). A few ms; no cache. Client polls every 60 s at most.

## 4. Steps (worker)

Each step ends with `npm run typecheck` (from root) and the related vitest file green
(`cd ui && npx vitest run test/<file>`).

1. **Store: columns + migration** (`ui/src/server/store.ts`, 12 min)
   - `HistoryRow` gets `heart_bpm?: number | null; heart_valid?: boolean | null` — **optional** so
     existing callers and the `row()` helper in `store.test.ts` still typecheck; written as
     `?? null`.
   - `HISTORY_FIELDS` gets `"heart"`; `queryHistory` maps the two columns (`heart_valid` 1/0/null →
     true/false/null; `undefined` from an unmigrated read is impossible after migrate, but map
     `?? null`) and the `fields` loop expands `heart` → `heart_bpm` + `heart_valid` like breathing.
   - `CREATE TABLE history` gets `heart_bpm REAL, heart_valid INTEGER`.
   - Constructor order: `new DatabaseSync` → WAL pragmas (file only, unchanged) →
     `PRAGMA busy_timeout = 5000` → `exec(SCHEMA)` → `this.migrate()` → all `prepare` calls.
   - `private migrate()`: as D3 (`BEGIN IMMEDIATE`, `table_info` inside, `ALTER` each missing of
     `[["heart_bpm","REAL"],["heart_valid","INTEGER"]]`, `user_version` to 1 if lower, `COMMIT`;
     catch → `ROLLBACK` (ignore a rollback error) → `throw new Error("history migration failed: " + msg)`).
     One comment: DBs created before track H; idempotent; safe with two processes.
   - `insertHistory` and `addHistory` write 9 columns.
   - New prepared `selectVitals` + public `vitalsRows(from, to): VitalsRow[]` (exported type with
     the 8 columns of §3, `breathing_valid`/`heart_valid` as raw `number | null`).
2. **History: write heart** (`ui/src/server/history.ts`, 3 min)
   - `add(r, storeVitals)`: `const h = storeVitals ? r.heart ?? null : null`;
     `heart_valid: h ? h.valid === true : null`,
     `heart_bpm: h?.valid === true && Number.isFinite(h.bpm) ? h.bpm : null`.
     Call site `runtime.ts:171` unchanged (do **not** edit runtime.ts).
   - `vitalsRows(from, to)` pass-through. Header comment: "…decides whether breathing and heart are stored".
3. **Aggregation** (new `ui/src/server/vitals-history.ts`, 12 min)
   - Exports `HOURS = [1, 6, 24]`, `MIN_READINGS = 3`, `ROW_MS = 5000`, `parseVitalsQuery(q, now)`
     → `{hours, from, to, bucketMs} | {error}`, `bucketMsFor(hours)`, `quantile(sorted, p)`,
     `summarize(rows, from, to, bucketMs)` → `{summary, buckets}`.
   - Imports `BREATH_RANGE`, `HEART_RANGE`, `inRange`, `MOTION_ON` from `@/lib/vitals`; types from
     `@/lib/vitals-history`.
   - New directive-free `ui/src/lib/vitals-history.ts`: types `VitalsBucket`, `VitalsSummary`,
     `VitalsHistoryReply`; client helpers `shareText(readings, present)` ("62 %" / null),
     `withBucketGaps(buckets, bucketMs, pick)` → uPlot `[xs, ys]` with null inserted at gaps.
     Reuse `minutesText` from `lib/model.ts` for durations (import only, do not edit model.ts).
4. **Route** (new `ui/src/app/api/v1/history/vitals/route.ts`, 4 min)
   - `export const dynamic = "force-dynamic"`; `read((ctx, req) => …)` like `history/route.ts`:
     parse with `Date.now()` → error → `fail(400, "bad_request", msg)`; else
     `summarize(ctx.history.vitalsRows(from, to), from, to, bucketMs)` and reply
     `{from, to, bucket_s: bucketMs / 1000, stored, summary, buckets}`.
   - Edit `app/api/v1/history/route.ts`: nothing needed (it reads `HISTORY_FIELDS`), so leave it.
5. **Client API** (`ui/src/lib/api.ts`, 2 min, additive only)
   - `HistoryRow` gets optional `heart_bpm?`, `heart_valid?`. New
     `getVitalsHistory = (hours: number) => api<VitalsHistoryReply>(\`/history/vitals?hours=${hours}\`)`.
6. **UI** (20 min)
   - New `ui/src/components/model/HoursChart.tsx` (`"use client"`): small uPlot line chart, x =
     bucket start (`time: true`, local clock), one median line, fixed y range (breath 0..40, heart
     40..140, movement 0..1 — read the specs in `sections.tsx` and match them), `spanGaps: false`.
     Same idiom as `TrendChart.tsx` (read it, do not edit it): created in an effect keyed on theme +
     data, colours from the same tokens (`--chart-breath`, `--chart-heart`, the movement token),
     width from `ResizeObserver`, destroy on unmount, height ~140 px. Overlay text when fewer than
     2 non-null points. `aria-label` e.g. "Breathing rate, median per 10 min, last 24 h".
   - New `ui/src/components/model/HoursSection.tsx` (`"use client"`), export `HoursBody`:
     - Segmented control like the window control on the page (`role="group" aria-label="History
       range"`, `aria-pressed`, 1 h / 6 h / 24 h). Range remembered in `lifefi.model.hours` via
       `safeStorage()` read **after mount** (no hydration mismatch), try/catch.
     - Fetch on mount, on range change and every 60 s; keep the last data on error and show
       "Couldn't load history" once. While first loading: "Loading…" (no fake chart).
     - **Empty states**, in this order: fetch error with no data → error line; `stored: false` →
       "This profile does not keep breathing or heart history." and only the movement block;
       `buckets.length === 0` → "No history yet. It builds up while the app runs, one reading every
       5 seconds." and no charts; `summary.present_n === 0` → "Nobody was there in these hours."
     - Blocks (stacked, full width, so 375 px works): **Breathing** — chart + "Read {share} of the
       time someone was there · median {med} /min (typical {q1}–{q3})" (median part only when
       non-null). **Heart rate** + `ExperimentalPill` + `HEART_CAPTION` — `summary.heart_on_n === 0`
       → "Not measured in these hours (no heart estimate, or data from before this update)." and no
       chart. **Movement** — chart + "Still {minutesText(still_n × 5)} of the time someone was there".
     - One muted line: "Each point is the median of one {10 min}. Gaps: nobody there, moving, too few
       readings, or the sensor was off."
   - `InsightsPage.tsx`: one `<Section id="hours" title="Last hours" subtitle="How was the night?">`
     with `<HoursBody />` after Movement, **not** `defaultOpen` (avoids a 17 k-row query on every
     Insights load; Section remembers open state). Check `Section` renders children only when open;
     if it renders them always, gate the fetch on visibility is out of scope — then use `defaultOpen`
     false anyway and accept the fetch. Append to the intro: "…and breathing, heart and movement
     over the last hours."
7. **Checks + report** (5 min): from the repo root `npm run typecheck`, `npm run lint`, `npm test`.
   Optional manual migration check on a **copy only**: copy `data/lifefi.sqlite`, `-wal`, `-shm`
   into the scratchpad, open the copy with a node one-liner (`new DatabaseSync(copy)` then
   `PRAGMA table_info(history)` after `new Store(copy)` via `npx tsx`), print the columns. Never
   open `data/lifefi.sqlite` itself. Do not start `next dev`/`next build`.

## 5. Store tests (extend `ui/test/store.test.ts`)

- **Migrates an old DB**: `mkdtempSync(join(tmpdir(), "lifefi-h-"))`; raw `DatabaseSync(file)`,
  `exec` the old history DDL (inline copy of the 7-column table) + old alerts/alert_log DDL, insert
  one row, `close()`. `new Store(file)`: `queryHistory` returns the old row with `heart_bpm: null,
  heart_valid: null`; `addHistory` with heart round-trips; `close()`. Reopen `new Store(file)`: no
  throw, `table_info` has exactly one `heart_bpm`, `user_version` = 1; `close()`.
- **Downgrade**: after migration, raw `DatabaseSync` runs the **old** 7-column `INSERT OR REPLACE`
  and `SELECT *` — both succeed, new columns NULL.
- **Two connections**: open `new Store(file)` twice on the same old-schema file (second while the
  first is open) — no throw, one column each.
- Cleanup: close every handle, then `rmSync(dir, {recursive: true, force: true})` in `finally`
  (Windows locks open files).
- `:memory:`: heart round-trips; `fields: ["heart"]` gives only `t, heart_bpm, heart_valid`;
  purge test still removes the 40-day row with heart set.

## 6. Other tests (new `ui/test/vitals-history.test.ts`)

- `parseVitalsQuery`: missing → 24 h / 600 000 ms; "1" → 60 000; "6" → 300 000; "0", "2", "25",
  "2.5", "abc", "" → error; `to` > now + 60 s → error; `to` "x" → error; `from = to - hours h`.
- `summarize`: rows over 3 buckets with an empty middle → 2 buckets, aligned `t`; invalid
  (`valid 0`), out of range (70 and 2), `count 2`, not present → not readings; bucket with 2
  readings → `breath_med null`, with 3 → median; odd/even median and q1/q3 on known data;
  `heart_valid null` rows → `heart_on_n 0`; `still_n` uses `MOTION_ON` (0.09 still, 0.1 not);
  summary share uses present rows only and its median is over all readings (case where median of
  bucket medians would differ); zero rows → `buckets []`, summary meds null.
- `History.add` (`:memory:` store): store false → breathing and heart null; no `heart` → heart
  null; `{valid:false, bpm:70}` → `heart_valid false, heart_bpm null`; valid → stored.
- `withBucketGaps`: null inserted between non-adjacent buckets; `shareText(0, 0)` → null.

## 7. Acceptance criteria

1. An old-schema DB gains `heart_bpm`, `heart_valid` exactly once; reopen is a no-op; old rows
   read with heart null; two concurrent opens don't fail; an old build's insert/select still work
   on the migrated file. All covered by tests.
2. Home/clinic: each row has `heart_valid` (when the engine sends heart) and `heart_bpm` only when
   valid. School: breathing and heart columns null (nothing new stored). Motion as before.
3. `GET /api/v1/history/vitals?hours=1|6|24` → 200 with ≤ 61/73/145 buckets; bad `hours`/`to` →
   400 `{error:"bad_request", message}`. `GET /history` unchanged; `fields=heart` accepted.
4. Insights has a "Last hours" section with its own 1/6/24 h control; breathing, heart
   (Experimental pill + caption) and movement charts; stat lines with share of time read.
   Short-window sections unchanged.
5. No number for a bucket with fewer than 3 valid readings (gap); heart never without the
   Experimental label; fresh install shows the "No history yet" text, not an empty chart frame.
6. 375 px: no horizontal scroll; dark mode via tokens only; control keyboard-accessible.
7. Retention unchanged.
8. Root `npm run typecheck`, `npm run lint`, `npm test` green. No edits outside §9.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Migration on the owner's real DB | Additive only, in one `BEGIN IMMEDIATE` transaction, re-checked inside, busy timeout; tested on an old-schema file, with two connections and an old-build insert. |
| `prepare` before migration ("no such column") | `migrate()` before all `prepare` calls; the migration test fails otherwise. |
| Point-sample rows miss short motion spikes | Documented; `motion_med` only, no `motion_max` claim. |
| Heart read as medical | Pill + caption, median only, no quartile band, no thresholds. |
| UI fix worker changed files meanwhile | H starts after it and re-reads §9 files; H edits only `InsightsPage.tsx` among shared ones. |
| DST night | Epoch-aligned buckets; uPlot local axis. |

## 9. Files

New: `ui/src/server/vitals-history.ts`, `ui/src/lib/vitals-history.ts`,
`ui/src/app/api/v1/history/vitals/route.ts`, `ui/src/components/model/{HoursChart,HoursSection}.tsx`,
`ui/test/vitals-history.test.ts`.

Edited: `ui/src/server/store.ts`, `ui/src/server/history.ts`, `ui/src/lib/api.ts` (additive),
`ui/src/components/model/InsightsPage.tsx` (one Section + intro sentence), `ui/test/store.test.ts`.

Read-only: `lib/vitals.ts`, `lib/model.ts` (`safeStorage`, `minutesText`), `components/model/{TrendChart,sections}.tsx`,
`components/vitals/VitalsCard.tsx`, `components/Section.tsx`, `server/http.ts`.

Not touched: `runtime.ts`, `app/api/v1/history/route.ts`, `Timeline.tsx`, `live.tsx`, `globals.css`,
`contracts/**` (doc text goes in the report), `profiles.yml`, `data/**`.

## 10. Time and cut list (~60 min)

| Step | Min |
|---|---|
| 1 store + migration + tests | 14 |
| 2 history.add heart | 3 |
| 3 aggregation + tests | 12 |
| 4 route | 4 |
| 5 client api | 2 |
| 6 UI | 20 |
| 7 checks + report | 5 |

Keep in this order (cut from the bottom): (1) columns + migration + writing heart — data can't be
backfilled; (2) aggregation + route; (3) breathing chart + stat; (4) empty states; (5) movement
chart; (6) heart chart; (7) 60 s auto-refresh; (8) remembered range.
**Cut outright:** quartile band on charts, `motion_max`, per-bucket quartiles, a breathing lane on
the `/` Timeline, a per-install "don't store vitals" switch, bounding the old `/history` span.

## 11. Worker report must include

- Text for `contracts/api.md` (track V owns it): `HistoryRow` gains `heart_bpm` (null unless valid)
  and `heart_valid` (null when the engine sends no heart or the profile does not store vitals);
  `fields` accepts `heart`; new `GET /history/vitals?hours=1|6|24&to=` with the reply of §3 and the
  honesty rules of D7; "`breathing_*` and `heart_*` are null when the active profile has
  `breathing.store: false`"; DB `user_version` 1.
- Whether `Section` mounts children only when open (affects the fetch).
- Any deviation and why.

## 12. Owner question (orchestrator adds to OPEN-QUESTIONS.md)

**Q-H1.** Breathing and (experimental) heart rate are kept in the local history file
(`data/lifefi.sqlite`, 5 s rows, deleted after `retention_days`, default 30) for the home and
clinic profiles, so "Last hours" on Insights can show the night. School stores neither. Nothing
leaves this machine. Keep that default, or add a switch "Keep breathing and heart rate history"
(off = only presence and movement)? Default tonight: keep.

## Critic revisions

1. **Migration hardened** (was: bare `table_info` + `ALTER` outside a transaction). Added
   `PRAGMA busy_timeout = 5000`, `BEGIN IMMEDIATE` with the column check *inside*, rollback +
   clear error on failure. Reason: `next dev` and a second process can open the same file;
   without this the second open throws "duplicate column" or `SQLITE_BUSY` and the backend does
   not start. Added downgrade and two-connection tests; spelled out why an older build keeps working.
2. **`HistoryRow` heart fields optional** on write: otherwise the existing `row()` helper in
   `store.test.ts` and any other `addHistory` caller break typecheck.
3. **Minimum readings per bucket (3)**: one stray valid row in a 10 min bucket would have drawn
   a confident median. Now a gap.
4. **Readings must be "present"**, so share of time read cannot exceed 100 %, and it is over
   present rows only, for the whole range.
5. **Range summary computed server-side from all readings** (new `summary` object): the stat line
   was otherwise a median of bucket medians or client-side guesswork.
6. **Still-time formula fixed**: planner wrote `still_n × bucket rows × 5 s`; correct is
   `still_n × 5 s` (each row is 5 s).
7. **`MOTION_ON` source settled**: it already lives in `lib/vitals.ts` (UI fix worker's change);
   no fallback to `server/rules.ts`.
8. **`hours` limited to 1/6/24** (was 1..24): only those three are used; fewer cases to test.
9. **Cut**: quartile band in charts, per-bucket quartiles, `motion_max`. Kept quartiles only in
   the range summary for the "typical" text. Saves the uPlot `bands` work.
10. **Section not `defaultOpen`**, to avoid a 17 k-row query on every Insights load; worker reports
    whether `Section` mounts children when closed.
11. **Empty states made explicit** (loading, error, profile does not store, fresh install with no
    rows, nobody there, heart not measured) — a fresh install previously would show empty frames.
12. **Query uses `t < to` and selects 8 named columns** on the rowid range (already the PK, so
    indexed); no new index needed. `history/route.ts` needs no edit since it reads `HISTORY_FIELDS`.
