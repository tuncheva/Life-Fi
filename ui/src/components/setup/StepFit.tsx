// Step 4 (optional): distance tuning. Someone moves gently at a known distance
// from the sensor for 25 s; then the engine fits its distance scale to the last
// 25 s of readings (POST /api/v1/position/fit).
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useNow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { FIT_LIMITS, FIT_SECONDS, parseMetres } from "@/lib/setup";
import { btn, inputCls, Notice } from "@/components/ui";

const fitDistance = (d_m: number) => api<Record<string, unknown>>("/position/fit", { method: "POST", body: JSON.stringify({ d_m, seconds: FIT_SECONDS }), pin: true });

export function StepFit({ engineUp, onNext }: { engineUp: boolean; onNext: () => void }) {
  const { withPin } = usePin();
  const [d, setD] = useState("2");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useNow(500);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const metres = parseMetres(d, FIT_LIMITS);
  const remaining = startedAt === null ? 0 : Math.max(0, Math.ceil((startedAt + FIT_SECONDS * 1000 - now) / 1000));

  const send = async (d_m: number) => {
    setBusy(true);
    try {
      const r = await withPin(() => fitDistance(d_m));
      if (r !== undefined) setMsg({ text: `Distance tuned at ${d_m} m. Check the room view: someone standing there should show about that far away.`, ok: true });
    } catch (e) {
      setMsg({ text: friendlyError(e), ok: false });
    } finally {
      setBusy(false);
      setStartedAt(null);
    }
  };

  const start = () => {
    if (typeof metres !== "number") return;
    setMsg(null);
    setStartedAt(Date.now());
    timer.current = setTimeout(() => void send(metres), FIT_SECONDS * 1000);
  };

  if (startedAt !== null)
    return (
      <div role="status" aria-live="polite">
        <p className="text-base font-semibold">Stay about {metres} m from the sensor and keep moving gently: shift your weight, wave your arms.</p>
        <p className="mt-3 font-mono text-5xl font-bold tabular-nums">{remaining > 0 ? `${remaining} s` : "Tuning…"}</p>
        <button
          type="button"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setStartedAt(null);
          }}
          className={`${btn.secondary} mt-4`}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    );

  return (
    <>
      <p className="text-base">Stand at a measured distance from the sensor, press the button, and keep moving gently for {FIT_SECONDS} seconds.</p>
      <Notice tone="neutral" className="mt-3">
        Distance is experimental. With a phone hotspot as the transmitter it stays a rough guess even after tuning.
      </Notice>
      <label className="mt-4 block max-w-xs text-sm font-medium" htmlFor="fit-d">
        Your distance from the sensor <span className="font-normal text-subtle">(m)</span>
        <input id="fit-d" inputMode="decimal" className={`${inputCls} min-h-11 text-base`} value={d} onChange={(e) => setD(e.target.value)} aria-invalid={metres === "bad"} />
      </label>
      {metres === "bad" && <p className="mt-1 text-sm text-danger">Between {FIT_LIMITS.min} and {FIT_LIMITS.max} m.</p>}
      {msg && (
        <Notice tone={msg.ok ? "ok" : "danger"} className="mt-3">
          {msg.text}
        </Notice>
      )}
      {!engineUp && <p className="mt-3 text-sm text-muted">Needs the sensor software running (step 1).</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={start} disabled={!engineUp || typeof metres !== "number" || busy} className={btn.primary}>
          I&apos;m in place, start
        </button>
        <button type="button" onClick={onNext} className={btn.secondary}>
          {msg?.ok ? "Continue" : "Skip"}
        </button>
      </div>
    </>
  );
}
