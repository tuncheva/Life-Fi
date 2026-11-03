// Step 2: room size and where the Wi-Fi transmitter stands. The geometry is kept
// in this browser (lib/room.ts) until the server has a place for it; the room
// name goes to the server settings.
import { useState } from "react";
import { updateSettings } from "@/lib/api";
import { friendlyError, usePin } from "@/lib/pin";
import { readRoomGeometry, writeRoomGeometry } from "@/lib/room";
import { parseMetres, ROOM_LIMITS, TX_LIMITS } from "@/lib/setup";
import { btn, inputCls, Notice } from "@/components/ui";

export function StepRoom({ roomName, moving, onNext }: { roomName: string; moving: boolean; onNext: () => void }) {
  const { withPin } = usePin();
  const [initial] = useState(readRoomGeometry);
  const [length, setLength] = useState(String(initial.length_m));
  const [width, setWidth] = useState(String(initial.width_m));
  const [tx, setTx] = useState(initial.tx_m === null ? "" : String(initial.tx_m));
  const [name, setName] = useState(roomName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const l = parseMetres(length, ROOM_LIMITS);
  const w = parseMetres(width, ROOM_LIMITS);
  const t = parseMetres(tx, TX_LIMITS);
  const valid = typeof l === "number" && typeof w === "number" && typeof t === "number";

  const save = async () => {
    if (!valid) return;
    setError(null);
    writeRoomGeometry({ length_m: l, width_m: w, tx_m: t });
    const trimmed = name.trim();
    if (trimmed && trimmed !== roomName) {
      setBusy(true);
      try {
        if ((await withPin(() => updateSettings({ room_name: trimmed }))) === undefined) return;
      } catch (e) {
        setError(friendlyError(e));
        return;
      } finally {
        setBusy(false);
      }
    }
    onNext();
  };

  const field = (label: string, hint: string, value: string, set: (v: string) => void, bad: boolean, id: string) => (
    <label className="block text-sm font-medium" htmlFor={id}>
      {label} <span className="font-normal text-subtle">{hint}</span>
      <input id={id} inputMode="decimal" className={`${inputCls} min-h-11 text-base`} value={value} onChange={(e) => set(e.target.value)} aria-invalid={bad} />
    </label>
  );

  return (
    <>
      <p className="text-base">
        The Wi-Fi transmitter (router or phone hotspot) must stay in one place. If it moves, every reading moves.
      </p>
      {moving && (
        <Notice tone="warn" className="mt-3">
          The sensor thinks the transmitter is not fixed (it moved, or it is a phone). Put it in one place, plugged in, and leave it there.
        </Notice>
      )}
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block text-sm font-medium sm:col-span-2" htmlFor="room-name">
          Room name <span className="font-normal text-subtle">shown on the dashboard and in phone alerts</span>
          <input id="room-name" className={`${inputCls} min-h-11 text-base`} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Room 1" />
        </label>
        {field("Room length", "(m, away from the sensor)", length, setLength, l === "bad", "room-length")}
        {field("Room width", "(m)", width, setWidth, w === "bad", "room-width")}
        <div className="sm:col-span-2">{field("Transmitter distance from the sensor", "(m, straight line)", tx, setTx, t === "bad", "room-tx")}</div>
        {(l === "bad" || w === "bad") && <p className="text-sm text-danger sm:col-span-2">Room sides are {ROOM_LIMITS.min} to {ROOM_LIMITS.max} m.</p>}
        {t === "bad" && <p className="text-sm text-danger sm:col-span-2">The transmitter distance is {TX_LIMITS.min} to {TX_LIMITS.max} m.</p>}
        {error && <Notice tone="danger" className="sm:col-span-2">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <button type="submit" disabled={!valid || busy} className={btn.primary}>
            {busy ? "Saving…" : "Save and continue"}
          </button>
          <span className="text-sm text-muted">The room size is kept in this browser.</span>
        </div>
      </form>
    </>
  );
}
