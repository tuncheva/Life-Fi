# Dashboard UI / UX brief

Owner: Emil. Written 2026-10-27. Scope: `ui/` only. Sources: plan-v2 §7–8, §11, §13,
portal-plan.md, business-research.md ("a quiet guardian, not a gadget": warm, calm, honest).

## 1. Who looks at it, and when

| Audience | Situation | Device, state of mind | The one question |
|---|---|---|---|
| **Family caregiver** (adult child of an elderly parent living alone) | At work, glancing between tasks; or woken at 3 am by the phone notification | Phone, one hand, half awake or anxious; reads 2 lines at most | "Is Mum OK right now, and do I need to act?" |
| **The elderly person** | Tablet on a shelf in the room, glanced at in passing | Large type needed, no technical vocabulary, may distrust "being watched" | "Is it on, and is it showing a camera picture of me?" (No.) |
| **Care-home nurse** | Between tasks, several rooms (one today), handover at shift change | Desktop at the station or a phone in the pocket; busy, interrupted | "Which room needs me, since when, and has someone taken it?" |
| **School janitor / secretary** | After hours, before locking up | Phone or office PC | "Is the room empty?" |
| **Installer / teammate** | Setting up, calibrating, recording and labelling sessions | Laptop, keyboard, often watching someone act instead of the screen | "Is the sensor healthy, calibrated, recording, and did my press land?" |
| **Jury and mentors** | 3-minute live pitch; projector at 5 m plus a phone held up; organisers take a screenshot | Seconds of attention, no context, sceptical of hype | "Did it just catch that fall, and is this really live and camera-free?" |

## 2. What must never be ambiguous (every consumer view)

1. **Is the system working at all?** One sentence, not a set of chips: "Sensor working",
   "Can't reach the Life-Fi box", "Sensor has not reported for 20 s, we cannot see the room".
   A silent sensor must never look like "all quiet" (plan-v2 §7.1 watchdog).
2. **Live or replay?** Non-dismissible replay banner on every page, including presentation mode.
3. **Is anyone there?** A sentence with a time: "Someone is in the room · since 14:02",
   "Nobody in the room since 14:02", "Not sure if anyone is there".
4. **Is anything wrong right now?** The open alert dominates the screen: what happened, for how long,
   whether the phone was told, and what to do next.
5. **What do I do next?** Every alarm and every problem state names the action
   (check on them / acknowledge / recalibrate / plug the sensor back in).

Honesty rules: posture is "last change we saw" (a missed transition leaves it wrong until the next one);
breathing is "about N breaths a minute", never "normal"; "possible fall", not "fall"; the single-occupant
assumption and "assistive notification, not a medical device; does not replace nurse call or emergency
services" stay on screen.

## 3. What each audience must not be shown

- **Consumers (caregiver, elderly person, nurse, janitor):** S / B / M, CSI, Hz, RSSI, dBm, loss %, config
  hash, pipeline version, "warm-up", "uncertain" as a raw enum, `fainted_suspected`, alert ids, motion as
  `0.03`, an unlabelled y-axis. These move into a collapsed "Sensor details" section.
- **The phone notification:** no health detail ever (already "Alert — Room 1 — open dashboard").
- **The elderly person / jury:** anything that looks like an image of a person. The CSI heatmap is
  framed as "this is all the sensor sees", never as a picture.
- **Anyone:** the profile switch next to the caregiver's status. It is an installer action (Settings).

## 4. Prioritised changes

| # | Change | Why |
|---|---|---|
| 1 | **Semantic token layer** in `globals.css` (surfaces, text, `present / empty / uncertain / offline`, `alert-high / medium / low`, `ok / warn / danger / replay`, chart colours), light + dark + forced theme; components use tokens, not raw palette classes | One meaning, one colour everywhere ("present" is the same teal in the hero, timeline and legend). Alex's Figma lands by editing tokens, not components |
| 2 | **Status language module** (`lib/words.ts`): one derived `RoomStatus` with a headline sentence, detail, tone and action, by priority: server unreachable > engine down > sensor silent > starting up > presence; plus breathing / motion / posture phrases and alert copy per profile | All screens say the same plain thing; no enums leak |
| 3 | **Dashboard hierarchy**: a large room-status hero (state + since + what to do), then breathing (Home / Clinic) and today's timeline; device health, S/B/M, config hash, count probabilities and the CSI heatmap go into a collapsible "Sensor details" section, remembered per browser | The caregiver reads one sentence; the installer still has everything one click away |
| 4 | **Alert banner**: unmissable block with icon, "Possible fall · Room 1", a ticking "open for 1:12", "Phone notified 23:51" or "Phone not notified", the action ("Call or check on them now") and a large Acknowledge button; acknowledged = calm "Someone is on it"; resolved = a green "All clear" line for a minute; `role="alert"`, pulse only on the icon and only with `prefers-reduced-motion: no-preference` | The 3 am reader and the jury get what / how long / what next in one look; transitions de-escalate calmly |
| 5 | **PIN dialog** instead of `window.prompt` / `window.alert`, with "wrong PIN, try again" inline | The acknowledge moment in the demo and on a phone must not be a browser popup |
| 6 | **Header and navigation**: brand + room + one live/replay/offline pill; consumer nav "Room" and "Alerts", installer pages under "Setup"; profile switch moved to Settings with a description of each profile; plain-language status pills (calibration only when it needs attention) | Caregivers see only what they use; plan-v2 §8 always-visible items stay |
| 7 | **Alert history as a story**: grouped by day, each alert a small timeline (detected → phone notified → acknowledged after 1 min → cleared), dropped "short events" hidden behind a toggle, technical ids in muted text | A nurse at handover reads what happened, not a log line |
| 8 | **Charts**: token colours that follow the theme; breathing without a meaningless y-axis, "30 s ago … now", dimmed when not valid; timeline with lane labels (In room / Position / Activity), word legend, pointer + touch tooltip in words, alert markers by level, "no history yet" state | Readable at a glance on a phone and a projector |
| 9 | **Presentation mode** (`/present/`): status word in huge type, full-screen alert takeover with Acknowledge, the raw signal heatmap next to the breathing wave with "No camera. This is everything the sensor sees.", keyboard `F` for fullscreen; replay banner and disclaimer still visible | The fall → alert → acknowledge sequence and the privacy reveal read from 5 m |
| 10 | **Installer flows**: calibration as numbered steps with a big countdown and outcome that says what to do; labelling buttons ≥ 64 px with key hints and a "last press" confirmation; source and settings errors mapped to actions | Installers watch the subject, not the screen; errors must tell them what to fix |
| 11 | **Empty / loading / error states** everywhere: connecting, server down, engine down, no data yet, no alerts yet, wrong PIN | No blank "—" cards |
| 12 | **Accessibility**: focus-visible rings, contrast ≥ 4.5:1 for text in both themes, `aria-live` on the status hero, min 16 px body text on phones, 44 px touch targets | Elderly users, phones, projectors |

## 5. Layout principles

- Phone first: hero and alert fit above the fold at 375 px.
- The hero is a **room card** with the room name; a future multi-room list is a grid of these cards
  sorted by "needs attention", so the layout does not fight a nurse station view.
- One accent of urgency per screen: red only for an open high alert or a dead sensor. Low-level
  ("for information") alerts are a calm notice with "Got it": no pulse, no badge, no takeover.
- One situation, one tap: a fall followed by fainted_suspected shows as one block ("also: …"),
  and "I'm on it" acknowledges every open alert of the room.
- Teal means "someone is there" and nothing else; buttons are neutral ink.
- Dev-only mock panel stays hidden in production builds.

## 6. Status (2026-10-28)

Done on `claude/ui-ux-overhaul-7db99b`: items 1–12 above, checked with the mock scenarios at 375 /
768 / 1280 px in light, dark and a forced theme. Left for later: a multi-room list (only one room
exists), a "Call" button (needs a phone number, ask 2), shadcn components (the tokens and
`components/ui.tsx` are the swap point; not worth the bundle yet), Gemini summaries (P4 not agreed).

## 7. Asks for the server

Done on the server on 2026-10-28 (items 1-7); the UI uses them. Item 8 waits for the Gemini decision.

1. **Room name** in settings (UI and notification say "Room 1" today).
2. **Contact phone** in settings, so the alert can offer a `tel:` "Call" button next to Acknowledge.
3. **Who acknowledged** (`acked_by`, e.g. a device name entered once per browser), for nurses at handover.
4. **Presence-since** in `Status` (time of the last presence change). The UI derives it from
   `/history` today, which is 5 s coarse and empty after a fresh server start.
5. **Notification outcome** on the alert: distinguish "not configured", "sent" and "ntfy refused".
   Today `notified_at` is stamped on every attempt, even with no topic set, so the UI cross-checks
   the topic in `/settings` before claiming "phone notified", and cannot tell a refused POST.
6. **After-hours occupancy** (School) and **long_inactivity** (Home) are defined in `profiles.yml` but not
   raised by the server; the School page computes "occupied after hours" locally for now.
7. **Resolution reason** in `data` for every resolve (cleared by the engine, server restart, profile change);
   only "server restart" is written today.
8. Gemini "explain this alert" (portal-plan P4) has a natural slot in the alert story once agreed.
