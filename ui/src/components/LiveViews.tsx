"use client";
// The engineering views, for installers (plan B1.4): the distance in 3D, what the
// sensor sees (3D) and what the detectors read (signals). All come from the board
// over USB through the engine; nothing here is simulated. Closed by default and
// mounted only when opened, so three.js loads only for someone who asks for it.
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useResult } from "@/lib/live";
import type { PositionSource } from "./Room3D";
import { Card, Icon, Pill } from "./ui";
import { SignalsChart } from "./SignalsChart";

const Placeholder = () => <div className="h-72 w-full animate-pulse rounded-lg bg-surface-2" />;
const Room3D = dynamic(() => import("./Room3D").then((m) => m.Room3D), { ssr: false, loading: Placeholder });
const CsiSurface3D = dynamic(() => import("./CsiSurface3D").then((m) => m.CsiSurface3D), { ssr: false, loading: Placeholder });

const KEY = "lifefi.liveviews";

function LinkPill() {
  const link = useResult()?.link;
  if (!link) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {link.rssi_dbm !== null && <Pill>RSSI {link.rssi_dbm.toFixed(0)} dBm</Pill>}
      {link.board && (
        <Pill tone={link.board.state === "present" ? "present" : link.board.state === "empty" ? "empty" : "uncertain"} title="The board's own estimate, from its USB log">
          Board: {link.board.state}
          {link.board.people !== null && link.board.state === "present" ? ` · ${link.board.people === 2 ? "2+" : link.board.people} ${link.board.people === 1 ? "person" : "people"}` : ""}
        </Pill>
      )}
    </div>
  );
}

/** Open state remembered per browser; `/model` opens it by default. */
function useOpen(byDefault: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(byDefault);
  useEffect(() => {
    if (byDefault) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after hydration
      if (localStorage.getItem(KEY) === "1") setOpen(true);
    } catch {
      /* private mode */
    }
  }, [byDefault]);
  const set = (v: boolean) => {
    setOpen(v);
    if (byDefault) return;
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  return [open, set];
}

export function LiveViews({ source = "distance" }: { source?: PositionSource }) {
  const [open, setOpen] = useOpen(source === "model");
  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group min-w-0 rounded-card border border-line bg-surface shadow-sm lg:col-span-3">
      <summary className="flex min-h-11 items-center gap-3 px-4 py-3 sm:px-5">
        <Icon name="chevron" className="chev h-4 w-4 text-muted transition-transform" />
        <span className="font-semibold">3D view and live signals</span>
        <span className="text-sm text-muted">for installers</span>
      </summary>
      {open && (
        <div className="grid grid-cols-1 gap-4 border-t border-line p-4 sm:p-5 lg:grid-cols-3">
          <Card className="min-w-0" title={source === "model" ? "Where (3D, spot model)" : "Where (3D, experimental)"} actions={<LinkPill />}>
            <Room3D source={source} />
          </Card>
          <Card className="min-w-0" title="What the sensor sees (3D)">
            <CsiSurface3D />
          </Card>
          <Card className="min-w-0" title="Live signals">
            <SignalsChart />
          </Card>
        </div>
      )}
    </details>
  );
}
