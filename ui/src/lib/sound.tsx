"use client";
// Alarm sound, opt-in. On the first visit the dashboard asks once whether it
// may beep; the answer is kept in this browser (localStorage) and can be
// changed in the Setup menu. While an urgent (high) alert is open and nobody
// has acknowledged it, a short double beep repeats every 2 s; a medium alert
// beeps once; low ones never do. Browsers only let a page play sound after the
// person has interacted with it, so the "Yes" click (or the first click or key
// press after a reload) is what unlocks the audio. WebAudio, no sound file.
// "Silence" stops the beep for the alerts open now without acknowledging them
// (no PIN needed); a new alert beeps again.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLive } from "./live";

const KEY = "lifefi.alarm-sound";
const REPEAT_MS = 2000;

type Choice = "on" | "off";

interface SoundState {
  /** null until the person has answered the question. */
  choice: Choice | null;
  setChoice: (c: Choice) => void;
  /** True while the browser still blocks audio (no click on the page since it loaded). */
  locked: boolean;
  /** True while the repeating alarm beep is sounding. */
  beeping: boolean;
  /** Stops the beep for the alerts open now, without acknowledging them. */
  silence: () => void;
}

const SoundContext = createContext<SoundState | null>(null);

function readChoice(): Choice | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

// The choice as an external store (like the theme), so every reader sees the same value.
const choiceListeners = new Set<() => void>();
function subscribeChoice(cb: () => void): () => void {
  choiceListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    choiceListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
let memoryChoice: Choice | null = null; // when localStorage is blocked

function saveChoice(c: Choice): void {
  memoryChoice = c;
  try {
    window.localStorage.setItem(KEY, c);
  } catch {
    /* private window: the choice lasts until the page is closed */
  }
  for (const cb of choiceListeners) cb();
}

export function SoundProvider({ children }: { children: ReactNode }) {
  const { alerts } = useLive();
  // "loading" on the server render, so the question does not flash before the saved answer is read
  const stored = useSyncExternalStore(subscribeChoice, () => readChoice() ?? memoryChoice ?? "unset", () => "loading");
  const choice: Choice | null | undefined = stored === "loading" ? undefined : stored === "unset" ? null : (stored as Choice);
  const [locked, setLocked] = useState(true);
  const [silenced, setSilenced] = useState<ReadonlySet<string>>(() => new Set());
  const audio = useRef<AudioContext | null>(null);

  /** Creates or resumes the audio context; only works inside a click or key handler at first. */
  const unlock = useCallback(() => {
    try {
      audio.current ??= new AudioContext();
      if (audio.current.state === "suspended") void audio.current.resume().then(() => setLocked(audio.current?.state !== "running"));
      else setLocked(false);
    } catch {
      /* no WebAudio: stay silent */
    }
  }, []);

  const beep = useCallback((times = 2) => {
    const ctx = audio.current;
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      const start = t0 + i * 0.22;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    }
  }, []);

  // After a reload with sound on, the first interaction with the page unlocks the audio.
  useEffect(() => {
    if (choice !== "on" || !locked) return;
    const onInput = () => unlock();
    window.addEventListener("pointerdown", onInput);
    window.addEventListener("keydown", onInput);
    return () => {
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onInput);
    };
  }, [choice, locked, unlock]);

  const setChoice = useCallback(
    (c: Choice) => {
      saveChoice(c);
      if (c === "on") {
        unlock();
        setTimeout(() => beep(1), 50); // a short confirmation that sound works
      }
    },
    [unlock, beep],
  );

  // Urgent: repeat while any high alert is open (not acknowledged) and not silenced.
  const openHigh = alerts
    .filter((a) => a.state === "open" && a.level === "high")
    .map((a) => a.id)
    .join(",");
  const urgent = openHigh
    .split(",")
    .filter((id) => id && !silenced.has(id))
    .join(",");
  const beeping = choice === "on" && urgent !== "" && !locked;
  const silence = useCallback(() => setSilenced((prev) => new Set([...prev, ...openHigh.split(",")])), [openHigh]);
  useEffect(() => {
    if (choice !== "on" || !urgent) return;
    beep();
    const t = setInterval(() => beep(), REPEAT_MS);
    return () => clearInterval(t);
  }, [choice, urgent, locked, beep]);

  // Needs attention: one beep per newly opened medium alert.
  const beeped = useRef(new Set<string>());
  useEffect(() => {
    for (const a of alerts) {
      if (a.state !== "open" || a.level !== "medium" || beeped.current.has(a.id)) continue;
      beeped.current.add(a.id);
      if (choice === "on") beep(1);
    }
  }, [alerts, choice, beep]);

  const value = useMemo<SoundState>(() => ({ choice: choice ?? null, setChoice, locked, beeping, silence }), [choice, setChoice, locked, beeping, silence]);
  return (
    <SoundContext.Provider value={value}>
      {children}
      {choice === null && <SoundQuestion onAnswer={setChoice} />}
    </SoundContext.Provider>
  );
}

function SoundQuestion({ onAnswer }: { onAnswer: (c: Choice) => void }) {
  return (
    <div role="dialog" aria-labelledby="sound-q" className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-md rounded-card border border-line bg-surface p-4 shadow-xl">
      <p id="sound-q" className="font-semibold">
        Play a sound when an alarm goes off?
      </p>
      <p className="mt-1 text-sm text-muted">
        A beep repeats until someone presses &ldquo;I&apos;m on it&rdquo;. You can change this later under Setup. Only this browser remembers it.
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => onAnswer("on")} className="flex-1 rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-fg hover:opacity-90">
          Yes, beep
        </button>
        <button onClick={() => onAnswer("off")} className="flex-1 rounded-lg border border-line px-4 py-2.5 font-semibold hover:bg-surface-2">
          No sound
        </button>
      </div>
    </div>
  );
}

export function useSound(): SoundState {
  const v = useContext(SoundContext);
  if (!v) throw new Error("useSound must be used inside <SoundProvider>");
  return v;
}
