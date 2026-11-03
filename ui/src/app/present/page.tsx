"use client";
// Presentation mode for the 3-minute pitch (docs/plan/ui-ux.md §4.9): readable
// from 5 m on a projector. The room state in huge type next to the raw signal
// ("no camera, this is everything the sensor sees"); an open alert takes over
// the whole screen with one Acknowledge button; acknowledged and all-clear
// de-escalate calmly. The replay banner and the disclaimer stay visible.
// Keys: F full screen, Esc leaves full screen, Backspace back to the dashboard.
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLive, useMounted, useNow, usePublished } from "@/lib/live";
import { DISCLAIMER, PROFILE_TEXT, roomName, activityText, alertAction, alertTitle, breathingText, clearedText, clock, postureText, stopwatch } from "@/lib/words";
import { BreathingChart } from "@/components/BreathingChart";
import { CsiCanvas, StateHeadline } from "@/components/Cards";
import { RoomView, useRoomStatus, useWhere } from "@/components/RoomView";
import { notifiedText, situation, useAck, usePhoneSetUp } from "@/components/AlertBanner";
import { SystemBanners } from "@/components/TopBar";
import { Icon } from "@/components/ui";

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

export default function PresentPage() {
  const { result, alerts, cleared, buffers, status } = useLive();
  const s = useRoomStatus();
  const now = useNow();
  const router = useRouter();
  const { ack, busy, error } = useAck();
  // Only urgent or needs-attention alerts take over the screen; "for information" does not.
  const open = alerts.filter((a) => a.state === "open" && a.level !== "low");
  const acked = alerts.find((a) => a.state === "acked");
  const phone = usePhoneSetUp(open.length);
  const allClear = cleared.find((a) => a.resolved_at && now - a.resolved_at < 60_000);
  const replay = (status?.source.mode ?? result?.source) === "replay";
  const mounted = useMounted();
  // not "LIVE" just because the page is connected: the engine or the sensor may be down (plan F3)
  const pill = s.blind && s.tone !== "uncertain" ? { text: "NOT WATCHING", cls: "bg-offline text-white", dot: "bg-white" } : replay ? { text: "REPLAY", cls: "bg-replay text-replay-fg", dot: "bg-replay-fg" } : s.blind ? { text: "STARTING", cls: "bg-uncertain-soft text-uncertain-fg", dot: "bg-uncertain" } : { text: "LIVE", cls: "bg-ok-soft text-ok-fg", dot: "bg-ok" };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "Backspace") router.push("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const sit = open.length ? situation(open) : null;
  const top = sit?.lead;
  const published = usePublished();
  const posture = result && !s.blind && published.posture ? postureText(result.posture) : null;
  const breathing = result && !s.blind && s.profile !== "school" ? breathingText(result) : null;

  return (
    <div className="fixed inset-0 z-30 flex flex-col overflow-auto bg-bg text-fg">
      <SystemBanners />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-base sm:px-8 sm:text-xl">
        <span className="flex shrink-0 items-center gap-2 font-bold">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-fg">
            <Icon name="wave" className="h-6 w-6" />
          </span>
          Life-Fi
        </span>
        <span className="text-muted">
          {roomName(status)} · {PROFILE_TEXT[s.profile].title}
        </span>
        <span className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-base font-semibold ${pill.cls}`}>
          <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${pill.dot}`} />
          {pill.text}
        </span>
        {/* the clock differs between the server render and the browser: drawn only once mounted (plan F7) */}
        <span className="ml-auto min-w-[8ch] text-right font-mono tabular-nums text-muted">{mounted ? clock(now, true) : " "}</span>
        <button onClick={toggleFullscreen} className="hidden rounded-lg border border-line px-3 py-1.5 text-base text-muted hover:bg-surface-2 sm:block">
          Full screen <kbd className="font-mono">F</kbd>
        </button>
        <Link href="/" className="rounded-lg border border-line px-3 py-1.5 text-base text-muted hover:bg-surface-2">
          Exit
        </Link>
      </div>

      {top ? (
        <section role="alert" className={`mx-4 mb-4 flex flex-1 flex-col justify-center rounded-3xl p-5 text-alert-fg sm:mx-8 sm:p-8 xl:p-10 shadow-2xl ${sit!.level === "high" ? "bg-alert-high" : "bg-alert-medium"}`}>
          <div className="flex flex-wrap items-center gap-4 sm:gap-6">
            <span className="flex h-16 w-16 shrink-0 sm:h-24 sm:w-24 items-center justify-center rounded-full bg-white/20 motion-safe:animate-beacon">
              <Icon name="alert" className="h-10 w-10 sm:h-14 sm:w-14" />
            </span>
            <div className="min-w-0">
              <p className="text-xl font-semibold uppercase tracking-wide opacity-90 sm:text-3xl">{roomName(status)}</p>
              <h1 className="text-4xl font-bold leading-tight sm:text-5xl xl:text-7xl">{alertTitle(top.type)}</h1>
            </div>
            <span className="ml-auto font-mono text-4xl font-bold tabular-nums sm:text-6xl">{stopwatch(now - sit!.since)}</span>
          </div>
          {sit!.others.length > 0 && <p className="mt-3 text-2xl font-medium opacity-95">Also: {sit!.others.map((a) => alertTitle(a.type).toLowerCase()).join(", ")}</p>}
          <p className="mt-6 text-2xl font-medium sm:text-3xl xl:text-4xl">{alertAction(top.type, top.profile)}</p>
          <p className="mt-4 flex items-center gap-3 text-lg opacity-95 sm:text-2xl">
            <Icon name={notifiedText(top, phone).sent ? "bell" : "bell-off"} className="h-8 w-8" />
            {notifiedText(top, phone).text}
          </p>
          <div className="mt-8 flex items-center gap-6">
            <button onClick={() => void ack(open)} disabled={busy} className="rounded-2xl bg-white px-6 py-4 text-2xl font-bold text-black shadow-lg sm:px-12 sm:py-6 sm:text-4xl hover:bg-white/90 disabled:opacity-60">
              {busy ? "Acknowledging…" : "I'm on it · Acknowledge"}
            </button>
          </div>
          {error && <p className="mt-4 rounded-lg bg-black/25 px-4 py-2 text-2xl">{error}</p>}
        </section>
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-8 px-4 pb-4 sm:px-8 lg:grid-cols-[3fr_2fr] [&>*]:min-w-0">
          <section className="flex flex-col justify-center gap-8">
            {acked && (
              <div aria-live="polite" className="flex items-center gap-4 rounded-2xl border-l-8 border-warn bg-warn-soft px-6 py-4 text-3xl font-semibold text-warn-fg">
                <Icon name="check" className="h-10 w-10" />
                {alertTitle(acked.type)}: someone is on it
              </div>
            )}
            {!acked && allClear && (
              <div aria-live="polite" className="flex items-center gap-4 rounded-2xl bg-ok-soft px-6 py-4 text-3xl font-semibold text-ok-fg">
                <Icon name="check" className="h-10 w-10" />
                All clear at {clock(allClear.resolved_at!)}: {clearedText(allClear.type)}
              </div>
            )}
            <StateHeadline s={s} size="xl" />
            <PresentWhere />
            {result && !s.blind && result.presence.state !== "empty" && (
              <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3">
                {posture && (
                  <div>
                    <dt className="text-xl text-muted">Position</dt>
                    <dd className="text-2xl font-semibold sm:text-4xl">{posture.text}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xl text-muted">Activity</dt>
                  <dd className="text-2xl font-semibold sm:text-4xl">{activityText(result.motion)}</dd>
                </div>
                {breathing && (
                  <div>
                    <dt className="text-xl text-muted">Breathing</dt>
                    <dd className="text-2xl font-semibold sm:text-4xl">{breathing.value ? `${breathing.value} / min` : "—"}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>
          <section className="flex flex-col justify-center gap-3 rounded-3xl border border-line bg-surface p-5">
            <div>
              <h2 className="text-3xl font-bold">No camera.</h2>
              <p className="text-2xl text-muted">This is everything the sensor sees:</p>
            </div>
            <CsiCanvas className="h-40 xl:h-56" />
            <p className="text-lg text-muted">52 Wi-Fi frequency bands, last 30 seconds. No image, no sound, no face.</p>
            {s.profile !== "school" && (
              <div>
                <p className="mb-1 text-xl font-semibold">Breathing, from the same signal</p>
                <BreathingChart buffers={buffers} seconds={30} height={90} big />
              </div>
            )}
          </section>
        </div>
      )}

      <footer className="px-4 pb-4 sm:px-8 text-center text-base text-muted xl:text-lg">
        {DISCLAIMER} {PROFILE_TEXT[s.profile].assumption}
      </footer>
    </div>
  );
}

/** The room drawing and the where-sentence, big enough for a projector. */
function PresentWhere() {
  const { where, text } = useWhere();
  return (
    <div className="grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <RoomView className="max-h-[40vh]" />
      <div aria-live="polite">
        {where.kind === "here" && (
          <>
            <p className="text-3xl font-semibold xl:text-4xl">{text.headline}</p>
            {text.detail && <p className="mt-2 text-2xl text-muted">{text.detail}</p>}
          </>
        )}
      </div>
    </div>
  );
}
