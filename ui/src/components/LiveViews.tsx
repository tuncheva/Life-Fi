"use client";
// The three live views under the room card: where the body is (3D), what the
// sensor sees (3D) and what the detectors read (signals). All come from the
// board over USB through the engine; nothing here is simulated. three.js and
// the WebGL views load only in the browser.
import dynamic from "next/dynamic";
import { useLive } from "@/lib/live";
import type { PositionSource } from "./Room3D";
import { Card, Pill } from "./ui";
import { SignalsChart } from "./SignalsChart";

const Placeholder = () => <div className="h-72 w-full animate-pulse rounded-lg bg-surface-2" />;
const Room3D = dynamic(() => import("./Room3D").then((m) => m.Room3D), { ssr: false, loading: Placeholder });
const CsiSurface3D = dynamic(() => import("./CsiSurface3D").then((m) => m.CsiSurface3D), { ssr: false, loading: Placeholder });

function LinkPill() {
  const { result } = useLive();
  const link = result?.link;
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

export function LiveViews({ source = "distance" }: { source?: PositionSource }) {
  return (
    <>
      <Card title={source === "model" ? "Where (3D, spot model)" : "Where (3D, experimental)"} actions={<LinkPill />}>
        <Room3D source={source} />
      </Card>
      <Card title="What the sensor sees (3D)">
        <CsiSurface3D />
      </Card>
      <Card title="Live signals">
        <SignalsChart />
      </Card>
    </>
  );
}
