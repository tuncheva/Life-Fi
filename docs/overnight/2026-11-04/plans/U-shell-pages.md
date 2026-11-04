# Track U plan: app shell and the remaining pages (final, after critic)

Planner + critic, 2026-11-04. Base: 38fb377 on `feat/overnight`. Inputs: `../README.md`
(rules, ownership), last night's `../../plans/B-ui-ux.md` and `../../review-ui-server.md`,
track M's plan `M-dashboard-model.md`. Every finding below was re-checked against the code
by the critic. One worker, about 60 minutes. Paths are relative to `ui/src/` unless they
start with `ui/`.

## Hard rules for the worker

- **No git commands that change state.** `git status` / `git diff` are fine.
- **Do not start a dev server, do not run `next build`.** Track M may be running dev checks.
  Your checks are `npm run typecheck`, `npm run lint`, `npm test` from the repo root.
- **Stay in your files** (list in §3). Never edit `app/model/**`, `app/page.tsx`,
  `lib/live.tsx`, `lib/room.ts`, `lib/api.ts`, `server/**`, `app/api/**`, or any track-M
  component. If you need a change there, write it in your report.
- **`components/ui.tsx` is shared with track M: additive only.** Keep every export name and
  signature: `Card`, `Pill`, `PillTone`, `TONE_CLASS`, `btn`, `inputCls`, `Kbd`, `Notice`,
  `Icon`, `IconName`, `TONE_ICON`, `Skeleton`, `PageSkeleton`. Do not change `Card`
  or `PageSkeleton` at all tonight. Do not add `"use client"` to `ui.tsx`; `not-found.tsx`
  (a Server Component) imports it.
- `app/globals.css`: edit only above the `/* --- track M: vitals and model --- */` marker
  (if the marker is not there yet, edit only above the end of the current file content and
  leave the end of the file alone). No token value changes.
- No new dependencies. Copy shared across files goes in `lib/words.ts`; page-local copy stays
  in the page. Match comment density and idiom of the surrounding code.
- Tests are pure TypeScript in `ui/test/*.test.ts` (vitest, `environment: "node"`, no DOM).
  `tsconfig` has `"jsx": "react-jsx"` and vitest aliases `@` to `src`, so importing `.tsx`
  modules for their exports works.

## 0. Findings (verified at 38fb377)

| # | Finding | Where |
|---|---|---|
| U-F1 | `/model` sits in the installer menu as "Spot model view"; the main nav has only Room and Alerts. Decision O3: it becomes **Insights** in the main nav. | `components/TopBar.tsx:18-26`, `:178-196` |
| U-F2 | Menu hrefs have trailing slashes (`/source/`, `/alerts/`, `/present/` …) and `next.config.ts` has no `trailingSlash`, so each click costs a 308. Active state is `startsWith` on a stripped string, so any route that starts with another's name (e.g. `/setupx` vs `/setup`) would match. | `TopBar.tsx:18-26`, `:160`, `:181`, `:202`, `:208` |
| U-F3 | The Setup menu stays open after a route change that is not a menu click (back button, the "Finish setup" pill, a link on the page). Escape closes it but focus is not returned to the summary. | `TopBar.tsx:146-158` |
| U-F4 | No skip link. `<main id="main">` cannot take focus. Note: the global `:focus-visible` rule in `globals.css:275` is **unlayered** CSS, so a Tailwind `focus:outline-none` utility (inside `@layer utilities`) **cannot** override it. | `app/layout.tsx:43`, `app/globals.css:275` |
| U-F5 | Every route has the title "Life-Fi". All pages but `/setup` are `"use client"` and cannot export `metadata` (Next 16 docs: "The `metadata` object and `generateMetadata` function exports are only supported in Server Components"). A server `layout.tsx` per segment can export it; `title.template` in the root layout applies to child segments. | `app/layout.tsx:15-18` |
| U-F6 | No web manifest and no SVG icon; `favicon.ico` is the template one. Next 16 supports `app/icon.svg` (gets `sizes="any"`) and `app/manifest.ts` returning `MetadataRoute.Manifest`. | `app/favicon.ico` |
| U-F7 | Page headers are hand-written 7 times with drift (wrapper div vs `<header>`, subtitle `mt-0.5` vs none, actions placed differently). | `alerts/page.tsx:108-119`, `settings/page.tsx:93-101`, `source/page.tsx` header, `label/page.tsx` header, `teach/page.tsx` header, `emergency/page.tsx:100-117`, `components/setup/SetupWizard.tsx` header |
| U-F8 | Settings labels carry hints in parentheses (long wraps on phones); `inputCls` has no min height (~38 px); no `aria-describedby`; `mt-0` and `mt-1` both on one input. | `components/ui.tsx:69`, `settings/page.tsx:151-196` |
| U-F9 | Settings: the "Phone notifications" card also holds room name, phone to call, device name, time zone and retention; one Save at the end of a long card. "This device's name" saves on every keystroke among fields that need Save. | `settings/page.tsx:130-214` |
| U-F10 | **Real bug, safety-relevant.** `Number("")` is `0`. Emptying "Send again if nobody acknowledges within" saves `escalate_after_s: 0`, which the server accepts and which **disables escalation** (`server/alerts.ts:242`: `if (esc > 0)`). Emptying "Keep history for" sends `0`; the server rejects it with 400 (`api/v1/settings/route.ts`: `inRange(…, 1, 3650)`), so the user only sees an error after pressing Save. Emptying "Room name" is silently ignored by the server (it keeps the old name) yet the page says "Saved." | `settings/page.tsx:166`, `:195`, `:179` |
| U-F10b | **New (critic): changing the PIN wipes unsaved form edits.** `run()` does `setSaved(r); setForm(r)` for any response that has `pin_set`, and `changePin` returns the PUT response. | `settings/page.tsx:58-63`, `:71-83` |
| U-F10c | PIN inputs have no `autoComplete`/`name`; browsers offer to save "1234" as a site password. | `settings/page.tsx:220-230` |
| U-F11 | Hydration mismatch: `browserPin` is read from localStorage in a `useState` initialiser (server renders `""`, client the stored PIN) and that input is rendered on first paint. `device` has the same initialiser but its input only renders after `getSettings()` resolves, so it is safe **today** and would become a mismatch the moment it moves into its own card (U5). The comment still says "static export". | `settings/page.tsx:34-40` |
| U-F12 | Alerts: each alert prints a developer line (`id · type · profile · config hash`) to consumers; the "show short events" checkbox is a 16 px target; the history renders uncapped. | `alerts/page.tsx:172-174`, `:113-117` |
| U-F13 | Source: the result notice renders at the bottom of the page; one `<label>` wraps both the `<select>` and the path `<input>`; a `getRecordings` failure is swallowed (`.catch(() => {})`) so the user sees "No recordings found yet"; the Loop checkbox is 16 px. | `source/page.tsx:25-31`, `:88-103`, `:113-115`, `:156-160` |
| U-F14 | Small targets: AlertBanner "Got it" (`py-2`, ~36 px) and "Dismiss"; `/present` "Full screen" and "Exit" (`py-1.5`). **Corrected:** the Emergency "Sound" button keeps `btn.secondary`'s `min-h-11`, so it is already 44 px; only its padding differs. | `AlertBanner.tsx:109`, `:178`, `present/page.tsx:77-82` |
| U-F15 | "Phone notification failed … (Setup → Settings)" is plain text; it should be a link. `notifiedText` is also used by `/present`. | `AlertBanner.tsx:64-66`, `present/page.tsx:100-101` |
| U-F16 | `/setup` polls `/health` every 5 s; it answers 503 while the engine is down, which logs a red network error every 5 s. The route supports `?soft=1` (always 200); `fetchOptional` passes the path through unchanged (`lib/setup.ts:44-53`). | `components/setup/SetupWizard.tsx:48` |
| U-F17 | No shared page-header, field or empty-state primitives. | `components/ui.tsx` |

Not worth doing tonight: deduplicating the dark tokens in `globals.css` (M appends to them);
`server/settings.ts` writes non-atomically (server is not U's; report it only).

Already fine (verified): `lang="en"`, global focus ring, reduced-motion rule, `[id]` scroll
margin, token contrast, `error.tsx`, `not-found.tsx`, lint clean.

## 1. Order of work (what users see most first)

1. U1 nav + header (every page)
2. U2 skip link + titles (every page)
3. U3 primitives in `ui.tsx` (needed by U4–U6)
4. U4 AlertBanner fixes (every page, when an alert is open)
5. U5 Alerts page (the consumer page next to the dashboard)
6. U6 one page header on the remaining pages
7. U7 Settings (installer page, but has the escalation bug)
8. U8 Source, `/present` targets, `/setup` soft health (installer)
9. U9 icon + manifest (cuttable)

After U1, U3, U5 and U7: `npm run typecheck` and `npx vitest run test/shell.test.ts test/ui.test.ts`
(from `ui/`). At the end: the full checks in §4.

## 2. Steps

### U1. Navigation model, Insights in the main nav, menu behaviour (P0, 12 min)

1. **New `lib/nav.ts`** (O1: U-owned). Pure module, no React:
   ```ts
   import type { IconName } from "@/components/ui";
   export type NavItem = { href: string; label: string; hint?: string; icon?: IconName };
   export const MAIN_NAV: NavItem[];  // Room "/" (icon "empty"), Insights "/model" ("chart"), Alerts "/alerts" ("bell")
   export const SETUP_NAV: NavItem[]; // /setup, /source, /label, /teach, /settings, /emergency — no /model, no /present
   export function isActive(href: string, path: string): boolean;
   ```
   - Order of `MAIN_NAV` is O3's: **Room, Insights, Alerts**.
   - SETUP_NAV labels and hints: copy the existing `SETUP` array (`TopBar.tsx:18-26`) minus
     the `/model` entry, with hrefs **without** trailing slashes.
   - `isActive`: strip one trailing slash from `path` (unless `path === "/"`). `"/"` matches
     only `"/"`. Any other href matches `path === href || path.startsWith(href + "/")`.
   - `import type` only, so the module stays React-free for the tests.
2. **`components/ui.tsx`**: add `"chart"` to `IconName` and to `PATHS` (three rising bars on
   a baseline, same stroke style, 24×24). Additive only.
3. **`components/TopBar.tsx`**:
   - Delete the local `SETUP` array; import `MAIN_NAV`, `SETUP_NAV`, `isActive` from `@/lib/nav`.
   - Render the main links from `MAIN_NAV`. Each link: `<Icon>` + label, `aria-current="page"`
     when `isActive`. Layout below `sm`: `flex-col gap-0.5 px-2 text-[11px]` (icon above the
     label), still `min-h-11`; from `sm`: `sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm` as now.
     Keep `navCls` as the single place for these classes.
   - Alerts badge: keep the visible number; replace `aria-label` on the span with
     `<span aria-hidden>{open}</span><span className="sr-only">, {open} open</span>` so the
     link reads "Alerts, 2 open" (an `aria-label` on a plain span is not reliably read).
     On phones the badge sits at the icon's top-right (`absolute -right-1 -top-1` inside a
     `relative` icon wrapper) so it does not widen the item.
   - `onSetup = SETUP_NAV.some((s) => isActive(s.href, path))`; menu items use
     `isActive(s.href, path)`. The `/present` menu link href becomes `"/present"`.
   - Below 360 px the "Life-Fi" wordmark gets `max-[359px]:sr-only` (the logo mark and its
     `aria-label` stay).
   - **Menu closes on route change**: `useEffect(() => { if (menu.current) menu.current.open = false; }, [path]);`
     (sets a DOM property, not React state, so no `set-state-in-effect` lint issue; the
     existing `onToggle` keeps `menuOpen` in sync).
   - **Escape returns focus**: add `summaryRef`; in the existing keydown branch, when the
     menu was open and the key is Escape, close it and `summaryRef.current?.focus()`.
     Keep the outside-click handler as is.
   - Keep `SystemBanners`, `StatusPills`, `FinishSetupPill` and the `/present` early return
     unchanged. The early return stays **after** all hooks (it is today; keep it so).

Acceptance (worker: by reading the code + tests; orchestrator: in the browser):
- Main nav reads Room, Insights, Alerts; `/model` is not in the Setup menu.
- Exactly one main item has `aria-current="page"` on `/`, `/model`, `/alerts`; none on
  `/settings` (the Setup summary is highlighted instead).
- No href in TopBar ends with `/` except `"/"`.
- At 320 px and 375 px no horizontal scroll, also with a two-digit badge (orchestrator).
  Fallback if it overflows: Insights label `max-[359px]:sr-only`.

### U2. Skip link and page titles (P0, 8 min)

1. **`app/layout.tsx`**:
   - `metadata.title = { default: "Life-Fi", template: "%s · Life-Fi" }`, add
     `applicationName: "Life-Fi"`; keep the description. (Next 16 requires `default` with a
     template; the template applies to child segments only, so `/` stays "Life-Fi".)
   - First child of `<body>`:
     `<a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-3 focus:font-semibold focus:shadow-lg">Skip to content</a>`.
   - `<main id="main" tabIndex={-1} …>` (keep its classes).
   - In `globals.css` (above the M marker, next to the `:focus-visible` rule) add
     `#main:focus-visible { outline: none; }` with a one-line comment. A utility class would
     lose to the unlayered global rule (U-F4).
2. **New server `layout.tsx` per U route**, each:
   ```tsx
   import type { Metadata } from "next";
   export const metadata: Metadata = { title: "Alerts", description: "…" };
   export default function Layout({ children }: { children: React.ReactNode }) {
     return children;
   }
   ```
   (Explicit props, no `LayoutProps`, matching the root layout's comment about fresh
   checkouts.) Routes and titles:

   | File | `title` |
   |---|---|
   | `app/alerts/layout.tsx` | Alerts |
   | `app/settings/layout.tsx` | Settings |
   | `app/source/layout.tsx` | Source & replay |
   | `app/label/layout.tsx` | Labelling |
   | `app/teach/layout.tsx` | Teach spots |
   | `app/setup/layout.tsx` | Set up this room |
   | `app/present/layout.tsx` | Presentation |
   | `app/emergency/layout.tsx` | Emergency demo |

   `description` = the page's existing subtitle sentence, or omit it when the page has none.
   A layout that returns `children` adds a segment level but no DOM and no remount on
   navigation inside the segment; `/setup` keeps its own Suspense in `page.tsx`.
3. **Do not touch `app/model/**`** (O4: track M adds `app/model/layout.tsx` with
   `title: "Insights"`).

Acceptance: titles "Alerts · Life-Fi" etc., `/` "Life-Fi"; first Tab stop is "Skip to
content", Enter moves focus to `<main>` with no outline box, next Tab lands in the page.

### U3. Shared primitives in `components/ui.tsx` (P0, 8 min, additive only)

- **`PageHeader({ title, description?, badge?, actions?, className? })`**:
  `<header className={\`mb-4 flex flex-wrap items-end gap-x-3 gap-y-2 ${className}\`}>`;
  left block `min-w-0 flex-1` with `<div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold tracking-tight">…</h1>{badge}</div>`
  and `description` as `<p className="mt-1 text-sm text-muted">`; `actions` in
  `<div className="flex flex-wrap items-center gap-2">`. No hooks.
- **`Field({ label, hint?, error?, children, className? })`**: no hooks, no `useId`, no
  `cloneElement` (keeps `ui.tsx` safe for Server Components and simple):
  `<label className="block text-sm font-medium">{label}{children}{hint && <span className="mt-1 block text-xs font-normal text-muted">{hint}</span>}{error && <span className="mt-1 block text-xs font-normal text-danger" aria-live="polite">{error}</span>}</label>`.
  Hint and error live inside the `<label>`, so they are part of the control's accessible
  name; that is enough tonight. Callers set `aria-invalid` on the input themselves.
- **`EmptyState({ icon, title, children, iconClassName? })`**: the alerts empty-state markup
  (`rounded-card border border-line bg-surface p-6 text-center`, icon `mx-auto h-8 w-8`,
  title `mt-2 font-semibold`, children `text-sm text-muted`).
- **`inputCls`**: append ` min-h-11 disabled:opacity-50 aria-[invalid=true]:border-danger`
  (same export name). Users today: settings, source, label, `setup/StepFit`, `setup/StepRoom`,
  `teach/TeachRecord` (all U-owned; no M file imports `inputCls`).
- **`inputRowCls`**: new export = `inputCls` without `mt-1 block` (for an input inside a
  flex row: `"w-full min-w-0 rounded-lg border …"`), to replace the `${inputCls} mt-0` hack.
- **`checkLabelCls`**: new export `"inline-flex min-h-11 items-center gap-2 text-sm"`, and
  checkboxes inside it use `h-5 w-5 accent-[var(--primary)]`.
- **Do not change** `Card`, `PageSkeleton`, `btn`, `Notice`. (The planner's `Card.id` /
  `Card.description` and "PageSkeleton through PageHeader" are cut: nothing tonight needs
  them, and `Card` renders on M's pages.)

### U4. AlertBanner (P0, 4 min; visible on every page while an alert is open)

`components/AlertBanner.tsx`:
- "Got it" (`:109`) and "Dismiss" (`:178`): add `inline-flex min-h-11 items-center`.
- `notifiedText`: keep the name and the `{ text, sent }` return shape (`/present` uses it).
  Remove " (Setup → Settings)" from both strings. At the banner call site, when `!n.sent`,
  render after the text: ` <Link href="/settings" className="font-semibold underline">Open settings</Link>`
  (import `Link` from `next/link`). `/present` simply shows the shorter text.
- Check the link is readable on the alert background (`text-alert-fg` inherits; use
  `underline` with inherited colour, no new colour).

### U5. Alerts page (P0, 6 min)

`app/alerts/page.tsx`:
- Header via `PageHeader`; the short-events checkbox goes in `actions` with `checkLabelCls`
  and an `h-5 w-5` checkbox (keep the copy).
- Developer line (`:172-174`) moves into
  `<details className="mt-2 text-xs text-subtle"><summary className="inline-flex min-h-11 cursor-pointer items-center">Technical details</summary><p className="font-mono text-[11px]">…same text…</p></details>`.
- Empty state uses `EmptyState` with the same copy.
- Cap (P1, cuttable): `const [limit, setLimit] = useState(50)`; group only `list.slice(0, limit)`;
  under the list, when `list.length > limit`, a `btn.secondary` "Show older ({list.length - limit})"
  that does `setLimit((l) => l + 50)`. `list` is already newest-first; check that before
  slicing.

### U6. One page header on the remaining pages (P0, 6 min)

Replace hand-written headers with `PageHeader`, keeping each existing title and subtitle:
- `settings/page.tsx`: "Re-run setup" in `actions`; the header goes inside the grid with
  `className="md:col-span-2"` (pass via `className`).
- `source/page.tsx`, `label/page.tsx`, `teach/page.tsx`: plain replace (if the header sits in
  a grid, add `md:col-span-2` via `className`).
- `components/setup/SetupWizard.tsx`: replace only if it is a plain h1 + p; if the wizard's
  header is part of a stepper layout, leave it.
- `emergency/page.tsx:100-117`: the "Prototype · simulated…" span goes in `badge`; "Viewing
  as …" and the Sound button go in `actions`. Leave the Sound button classes alone (already
  44 px).
- `error.tsx`, `not-found.tsx`, `/present`: unchanged.

### U7. Settings (P0, 14 min)

`app/settings/page.tsx` only (plus `lib/words.ts` for the parser). Data safety first:

1. **Number fields (U-F10, do this first).**
   - Add to `lib/words.ts`: `export function parseWholeNumber(s: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null`
     — trim; `/^\d+$/` else null; then the range check.
   - Keep two string drafts, `escText` and `retText`, initialised from `saved` whenever
     `saved` is set from the server (load, Save success, Discard). Do it where `setSaved` is
     called, not in an effect.
   - `esc = parseWholeNumber(escText, 0, 86400)`, `ret = parseWholeNumber(retText, 1, 3650)`
     (server limit for retention is 1–3650).
   - Field errors: "Enter a whole number of seconds (0 = never send again)." and
     "Enter 1 to 3650 days." Inputs get `aria-invalid` when null. Hint for escalation:
     "0 means the phone is told once and never again."
   - Room name: error "The room needs a name." when `form.room_name.trim() === ""`
     (the server silently ignores an empty name).
   - `invalid = esc === null || ret === null || !form.room_name.trim()`.
   - `dirty = JSON.stringify(form) !== JSON.stringify(saved) || escText !== String(saved.notify.escalate_after_s) || retText !== String(saved.retention_days)`.
   - Save sends the same fields as today, with `escalate_after_s: esc` and
     `retention_days: ret`. Save is disabled while `!dirty || invalid || busy`.
2. **Do not wipe edits on PIN change (U-F10b).** Make `run` take an option, or simplest:
   only `save` applies the response to `saved`/`form`/drafts. `changePin` returns its result
   but `run` no longer copies a `pin_set` response into the form; instead `save` does
   `const r = await updateSettings(…); applySaved(r); return r;` inside the `run` callback.
   Profile switch (`setProfile`) never touched the form; keep it so.
3. **Cards, in this order** (all existing copy kept; hints move from the parentheses into
   `Field hint`):
   1. "Where is this sensor installed?" (unchanged).
   2. **"This room"**: room name, phone to call, time zone, keep history for.
   3. **"Phone notifications"**: status pill + the 3-step list, topic + generate, ntfy
      server, send again after, dashboard address + "this address", then "Send test
      notification" with its existing disabled rules and hint ("Save first, then test.").
   4. **"This device"**: device name (hint "Saved on this device as you type; shown as who
      acknowledged") and "PIN remembered in this browser".
   5. "Change the dashboard PIN" (the new/repeat fields, existing copy).
   6. "Server and engine" (unchanged).
   Cards 2 and 3 render the existing skeleton / load-failed notice while `!form`.
   Inputs in flex rows (topic, dashboard address) use `inputRowCls` and the row gets `mt-1`.
4. **One Save, always reachable.** Remove the in-card Save. At the end of the page grid,
   while `dirty` (or while a save notice is showing), render
   `<div role="region" aria-label="Unsaved changes" className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:col-span-2">`
   with "You have unsaved changes." (or the save result `Notice`), **Save** (`btn.primary`),
   **Discard** (`btn.secondary`: `setForm(saved)` and reset both drafts). Hide the success
   notice after 4 s with a `setTimeout` cleared on unmount. The sticky bar sits in normal
   flow, so it never covers the last field (no padding hack needed).
   - `beforeunload` while dirty: `useEffect(() => { if (!dirty) return; const h = (e: BeforeUnloadEvent) => { e.preventDefault(); }; addEventListener…; return remove…; }, [dirty]);`
     Note in a comment: this covers reload and closing the tab, **not** in-app link
     navigation (App Router has no blocking API); that is accepted.
5. **PIN fields (U-F10c)**: remembered PIN `name="lifefi-browser-pin" autoComplete="off" inputMode="numeric"`;
   new and repeat `name="lifefi-new-pin" / "lifefi-new-pin-2" autoComplete="new-password" inputMode="numeric"`.
6. **Hydration (U-F11)**, lint-clean, no setState in effects:
   ```ts
   const noop = () => () => {};
   const storedPin = useSyncExternalStore(noop, getPin, () => "");
   const [pinDraft, setPinDraft] = useState<string | null>(null);
   const browserPin = pinDraft ?? storedPin;
   ```
   Same pattern for `device` (`getDeviceName`). On change set the draft (and for device also
   call `setDeviceName`); on PIN blur `setPin(browserPin)`; after a PIN change set
   `setPinDraft(newPin)`. Delete the stale "static export" comment.
   (`getPin`/`getDeviceName` are already `try/catch`-safe in `lib/api.ts`.)

Acceptance (worker, by reading + tests; orchestrator in the browser):
- Emptying "Send again…" shows the error and disables Save; nothing sends `0` unless the user
  typed `0`.
- Changing the PIN with unsaved room-name edits keeps the edits and the bar.
- Discard restores every field including the two number fields.
- At 375 px labels are one or two lines; hints sit under fields.
- No hydration warning on a hard reload of `/settings` with a PIN stored.

### U8. Installer-page polish (P1, 6 min)

- `app/source/page.tsx` (cuttable as a block):
  - `msg` gets `where: "live" | "play" | "record"` (match the actual cards); each card
    renders its own `Notice` under its action; remove the bottom notice.
  - `reload()`: on failure set `listFailed` and show "Can't list the recordings: {friendlyError(e)}"
    in place of "No recordings found yet". Clear it on success.
  - Split the label: `<Field label="Recording">` holds the `<select>` only; the path input
    goes in `<details open={files.length === 0}><summary className="inline-flex min-h-11 cursor-pointer items-center text-sm">Type a path instead</summary>…</details>`
    keeping its `aria-label`.
  - Loop checkbox: `checkLabelCls`, `h-5 w-5`.
- `app/present/page.tsx:77-82`: Full screen and Exit get `inline-flex min-h-11 items-center`
  (keep `hidden … sm:block` → `sm:inline-flex` for Full screen so it stays hidden on phones).
  Do not touch anything else in `/present` (O5: vitals there are the orchestrator's).
- `components/setup/SetupWizard.tsx:48`: `fetchOptional<HealthResponse>("/health?soft=1")`.
  Update the comment at `:5` if it mentions the 503.

### U9. Icon and manifest (P2, cuttable, 4 min; O2)

- `app/icon.svg`: 32×32 viewBox, `#1b2027` rounded square (`rx="7"`), the `wave` path from
  `ui.tsx` scaled into it, white stroke. Leave `favicon.ico`.
- `app/manifest.ts`: `import type { MetadataRoute } from "next"`; `name`/`short_name`
  "Life-Fi", the root description, `start_url: "/"`, `display: "standalone"`,
  `background_color: "#f5f6f8"`, `theme_color: "#1b2027"`,
  `icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }]`.

### Cut order if late

U9 → U8 Source block → U5 "Show older" cap → U8 `/present` + SetupWizard → U6 for label/teach/
SetupWizard. Never cut U1, U2, U3, U4, U5 (except the cap), U7.1, U7.2, U7.5, U7.6.

## 3. Files

Edited: `components/{TopBar,ui,AlertBanner}.tsx`, `components/setup/SetupWizard.tsx`,
`app/layout.tsx`, `app/globals.css` (one rule, above the M marker),
`app/{alerts,settings,source,label,teach,emergency,present}/page.tsx`, `lib/words.ts`
(`parseWholeNumber` only).

New: `lib/nav.ts`, `app/{alerts,settings,source,label,teach,setup,present,emergency}/layout.tsx`,
`app/icon.svg`, `app/manifest.ts`, `ui/test/shell.test.ts`, `ui/test/ui.test.ts`.

Not touched: everything of tracks M and V, `app/model/**`, `app/page.tsx`, `lib/live.tsx`,
`lib/api.ts`, `lib/room.ts`, `server/**`, `app/api/**`, `contracts*`.

## 4. Tests and checks

`ui/test/shell.test.ts` (new):
- `isActive`: `("/","/")` true; `("/","/alerts")` false; `("/alerts","/alerts/")` true;
  `("/alerts","/alerts/x")` true; `("/setup","/settings")` false; `("/setup","/setupx")` false;
  `("/model","/model")` true.
- `MAIN_NAV.map(h => h.href)` equals `["/", "/model", "/alerts"]`; the `/model` label is
  "Insights".
- `SETUP_NAV` has no `/model` and no `/present`; no href in either list ends with `/`
  except `"/"`.
- Every href except `/` has `src/app/<seg>/page.tsx` on disk
  (`fs.existsSync(fileURLToPath(new URL(\`../src/app${href}/page.tsx\`, import.meta.url)))`).
- `parseWholeNumber`: `""`→null, `"abc"`→null, `"-1"`(min 0)→null, `"3.5"`→null,
  `"0"`(min 0)→0, `"0"`(min 1)→null, `" 30 "`→30, `"4000"`(1, 3650)→null.

`ui/test/ui.test.ts` (new, backward-compat guard for track M):
- `import * as ui from "@/components/ui"`; every name in the "Hard rules" export list plus
  `PageHeader`, `Field`, `EmptyState`, `inputRowCls`, `checkLabelCls` is defined.
- `inputCls` and `btn.segment(true)` contain `min-h-11`; `inputRowCls` does not contain `mt-1`.
- If importing the `.tsx` fails under vitest, keep only what works and say so in the report.

Commands (repo root), all green before handing back: `npm run typecheck`, `npm run lint`,
`npm test`. If `npm test` fails in a track M/V test or the engine, run `npx vitest run` in
`ui/` to show U's tests pass and report the foreign failure without fixing it.

Manual checks for the orchestrator's replay run (worker needs no browser):
light/dark × 375/1280 px on `/`, `/alerts`, `/settings`, `/source`, `/setup`, `/model` (nav
only), `/present`; no horizontal scroll at 320 px; tab titles; skip link; `/setup` console
clean with the engine stopped; settings bar, Discard, emptied number field, PIN change with
pending edits, no hydration warning.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Four nav items overflow at 320 px. | Icon-over-label below `sm`, badge absolutely positioned, wordmark sr-only below 360 px; fallback Insights label sr-only below 360 px. |
| `ui.tsx` change breaks M. | Additive only; `Card`/`PageSkeleton` untouched; `ui.test.ts` guards the export list; no hooks added to `ui.tsx`. |
| `inputCls` `min-h-11` changes the look of U's setup/teach inputs. | Intended (44 px targets); they are U's files. |
| Route layouts change rendering. | They return `children` only: no DOM, no client code. |
| Settings: drafts drift from `saved`. | One `applySaved(r)` helper sets `saved`, `form`, `escText`, `retText` together; used on load, after Save, and by Discard (with `saved`). |
| `beforeunload` does not catch in-app navigation. | Accepted and commented; the sticky bar makes pending edits obvious. |
| `lib/nav.ts` imports a type from `ui.tsx`. | `import type` only, erased at compile time; tests stay React-free. |

## 6. Time

| Step | Min |
|---|---|
| U1 nav + menu | 12 |
| U2 skip link + titles | 8 |
| U3 primitives | 8 |
| U4 AlertBanner | 4 |
| U5 Alerts | 6 |
| U6 headers | 6 |
| U7 Settings | 14 |
| U8 installer polish | 6 |
| U9 icon + manifest | 4 |
| Tests + checks | 6 |
| **Total** | **≈ 74; ≈ 60 after the cut list's first three items** |

## Critic revisions

1. **Reordered by what users see most**: nav/header and titles first, then AlertBanner (every
   page) and the Alerts page, then the other headers, then Settings, then installer polish.
   AlertBanner fixes moved out of the old "small fixes" bucket to P0.
2. **Folded in orchestrator decisions**: O1/O2 (nav.ts, icon.svg, manifest.ts are U's), O3
   (main nav Room / Insights / Alerts, test asserts that order), O4 (no `app/model/**`), O5
   (old U9 `/present` vitals removed entirely). Added the "no dev server, no `next build`"
   rule; the planner's risk mitigation relied on the orchestrator's `next build`.
3. **New safety finding U-F10b**: changing the PIN overwrote unsaved settings edits
   (`run()` copies any `pin_set` response into `form`). Fixed by applying server responses
   only from Save via one `applySaved` helper.
4. **U-F10 sharpened**: an emptied escalation field saves `0`, which silently **disables
   escalation** (`server/alerts.ts:242`); retention `0` is rejected by the server, not saved;
   an empty room name is silently ignored. Added range limits matching the server
   (1–3650 days), a required room name, and string drafts included in `dirty`/Discard.
5. **Hydration fix made concrete and lint-safe** (`useSyncExternalStore` + nullable draft)
   and noted that `device` only becomes a mismatch once it moves to its own card.
6. **Removed risky or low-value `ui.tsx` changes**: no `useId`/`cloneElement` in `Field`
   (hint and error live inside the label instead), no `Card.id`/`Card.description`, no
   `PageSkeleton` rewrite, no `home` icon. Added `inputRowCls` to replace the `mt-0` hack.
7. **Skip link fix corrected**: `focus:outline-none` cannot beat the unlayered global
   `:focus-visible` rule; use one `#main:focus-visible` rule in `globals.css` above M's marker.
8. **Corrected U-F14**: the Emergency Sound button is already 44 px (`btn.secondary` keeps
   `min-h-11`); dropped that fix. `/present` Full screen keeps `hidden sm:inline-flex`.
9. **Sticky Save bar** placed in the page grid (normal flow), so no padding hack; Discard
   resets drafts; `beforeunload` limitation documented instead of overpromising
   "no lost edits on navigation".
10. **Menu close on route change** specified as a DOM-property effect (no setState, lint
    clean); badge accessible name via sr-only text instead of `aria-label` on a span.
11. Verified Next 16.4.3 docs in `ui/node_modules/next/dist/docs`: metadata only in Server
    Components, `title.template` needs `default` and applies to child segments, `icon.svg`
    and `manifest.ts` conventions; per-route server `layout.tsx` is the right mechanism.
12. Tests: added `/present` exclusion, `"/alerts/x"`, upper bound for `parseWholeNumber`,
    `inputRowCls` checks; foreign test failures are reported, not fixed.

## Worker report (U)

**Built (all steps U1–U9; nothing from the cut list was cut).** Paths under `ui/src/` unless noted.

- **U1** new `lib/nav.ts` (`MAIN_NAV` Room / Insights / Alerts, `SETUP_NAV` without `/model` and `/present`, `isActive`). `components/TopBar.tsx`: nav from `MAIN_NAV` with icons (icon above an 11 px label below `sm`, row from `sm`), Alerts badge absolutely on the icon on phones and inline from `sm`, accessible name via sr-only ", N open"; "Setup" label now visible at all widths (summary keeps `aria-label="Setup menu"`); wordmark `max-[359px]:sr-only`; menu closes on route change (DOM property effect); Escape closes and returns focus to the summary; no trailing-slash hrefs (`/present` too). `ui.tsx`: `"chart"` icon.
- **U2** `app/layout.tsx`: `title: { default, template: "%s · Life-Fi" }`, `applicationName`, skip link, `<main tabIndex={-1}>`; `globals.css`: one `#main:focus-visible { outline: none }` rule next to the global focus rule (above M's marker). New server `layout.tsx` in `alerts, settings, source, label, teach, setup, present, emergency` (title + description).
- **U3** `ui.tsx` (additive only): `PageHeader`, `Field`, `EmptyState`, `inputRowCls`, `checkLabelCls`; `inputCls` gained `min-h-11 disabled:opacity-50 aria-[invalid=true]:border-danger`. `Card`, `PageSkeleton`, `btn`, `Notice` untouched; no hooks, no `"use client"`.
- **U4** `AlertBanner.tsx`: "Got it" / "Dismiss" 44 px; `notifiedText` lost "(Setup → Settings)"; banner adds an "Open settings" link when the phone was not told (not for "Phone not notified yet", which is just pending). `/present` shows the shorter text.
- **U5** `app/alerts/page.tsx`: `PageHeader`, 44 px short-events checkbox, developer line behind "Technical details", `EmptyState`, "Show older (N)" cap at 50 (server list is newest first, checked in `server/alerts.ts:105`).
- **U6** `PageHeader` on settings, source, label, teach, emergency (badge + actions), `setup/SetupWizard.tsx`. In grid/space-y parents the header uses `mb-0!` so spacing stays as before.
- **U7** `app/settings/page.tsx` rewritten: number fields as string drafts parsed with new `parseWholeNumber` (`lib/words.ts`), errors + `aria-invalid`, empty room name blocked; one `applySaved` for load/Save/Discard; PIN change no longer overwrites unsaved edits; cards "This room" / "Phone notifications" / "This device" / "Change the dashboard PIN" / "Server and engine"; hints under fields via `Field`; sticky Save/Discard bar in normal flow, success notice fades after 4 s; `beforeunload` while dirty (comment notes in-app navigation is not covered); PIN inputs with `name`/`autoComplete`; `useSyncExternalStore` + nullable drafts for the stored PIN and device name (no hydration mismatch); stale "static export" comment removed.
- **U8** `app/source/page.tsx`: per-card result notices, recordings list failure shown instead of "No recordings found yet", select in its own `Field`, path input under "Type a path instead" (open when there are no recordings), 44 px Loop checkbox, `inputRowCls` instead of the `mt-0` hack. `label/page.tsx` same hack replaced. `/present` Full screen / Exit 44 px (Full screen still hidden on phones). `SetupWizard` polls `/health?soft=1`. `setup/StepDone.tsx` trailing-slash hrefs fixed.
- **U9** `app/icon.svg` (dark rounded square, white wave), `app/manifest.ts`.
- Tests: new `ui/test/shell.test.ts` (isActive, nav order/labels, no trailing slashes, every href has a page, parseWholeNumber) and `ui/test/ui.test.ts` (export guard for track M, 44 px classes). Both import fine under vitest.

**Cut:** nothing.

**Checks (repo root, final run):** `npm run typecheck` green; `npm run lint` green; `npm test` 18 passed, 1 skipped (`test_features_vectors.py`, pre-existing skip), 0 failed. During one intermediate run typecheck failed in `server/health.ts` (missing `transmitter`) and lint in `components/model/sections.tsx` (unescaped `'`): both foreign, mid-edit, and gone on the re-run.

**Known issues / for other tracks:**
- `components/Cards.tsx:177` (track M) still links to `"/alerts/"` (one 308 per click). Change to `"/alerts"`.
- `Field` wraps the topic and dashboard-address rows (a `<div>` with input + button) inside a `<label>`, as the old markup did; valid in browsers, not strict HTML content model.
- Settings card order moved "Dashboard PIN" after "This device"; "Server and engine" now spans both columns.
- `server/settings.ts` writes non-atomically (not U's; from the plan, report only).

**Browser checks for the orchestrator** (light and dark, 375 and 1280 px; also 320 px for the header):
- Header on `/`, `/model`, `/alerts`, `/settings`: Room / Insights / Alerts / Setup, exactly one `aria-current` on main pages, Setup highlighted on installer pages; no horizontal scroll at 320/375 with a two-digit alert badge (fallback in plan: Insights label `max-[359px]:sr-only`). Setup menu closes on Back and on the "Finish setup" pill; Escape returns focus to "Setup".
- Tab titles ("Alerts · Life-Fi", "/" stays "Life-Fi"); first Tab shows "Skip to content", Enter focuses `<main>` without a ring.
- `/settings`: empty "Send again…" shows the error and disables Save; Discard restores both number fields; change PIN with a pending room-name edit keeps the edit and the bar; hard reload with a stored PIN: no hydration warning; sticky bar does not cover the last card.
- `/alerts` empty state, "Technical details", short-events checkbox; `/source` per-card notices and "Type a path instead"; `/setup` console clean with the engine stopped (no 503 every 5 s); `/present` buttons; `/icon.svg` and `/manifest.webmanifest` served; AlertBanner "Open settings" link readable on red/orange.
