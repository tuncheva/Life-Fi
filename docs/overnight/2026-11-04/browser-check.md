# Browser check (orchestrator) — replay of spots-20261031-192549

Round 1, 02:22–02:30, after tracks U and M were committed (engine = track V
mid-edit). 800 px pane and 375 px mobile, dark theme. No console errors; no
horizontal scroll at 375 px; titles "Insights · Life-Fi" etc. work.

## Findings for the polish round

1. **Chart x-axis ticks** (`TrendChart`): uneven labels (15, 13, 12, 10, 8, 7,
   5, 3, 2 min) and the last label "now" is clipped at the right edge
   ("no"). Use evenly spaced ticks for the chosen window and keep "now" inside.
2. **Movement threshold label** ("Above this, breathing and heart rate can't be
   read") sits at the right end of the dashed line, on top of the newest data.
   Put it at the left end.
3. **Vitals card, no reading:** the reason text is set at the size of the big
   number, so in the narrow column it wraps to 5 lines and the card jumps
   between states. Show a fixed-size "—" in the number slot and the reason as a
   smaller line under it.
4. **Contradiction:** breathing said "Can't be read while they move" while the
   Movement section said "Very still" (UI fallback when `breathing.reason` is
   absent). With track V's engine reasons this should go away — recheck, and
   make the fallback neutral ("No reading yet") rather than claiming movement.
5. **Where section:** header summary "No distance" while the chart shows
   distances and the stat line says "Mostly far, over 3.5 m · median 3.6 m"
   (room is 2–2.5 m; distance quality is "low"). Header should describe the
   window ("Rough guess only" / "No distance right now"), and the stat line and
   chart must say the distance is a rough guess when quality is not "medium"
   (same rule as the room view, `lib/room.ts`).
6. **Insights header on mobile:** the 2/5/15 min control sits to the right of
   the title and squeezes "What the sensor sees" and the description into a
   ~180 px column. Stack the control under the header below `sm`.
7. **/model at 800 px:** the vitals card column has a large empty area under it
   next to the tall room card. Acceptable; consider `self-start`.
8. "1 packets/s" in the Sensor health header — plural for 1. (The replay itself
   ran at 4–40 packets/s; that is the recording, not a bug.)
