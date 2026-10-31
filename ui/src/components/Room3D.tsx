"use client";
// Live 3D room view: the ESP32, the router, the link between them and its first
// Fresnel zone, the near / middle / far zones on the floor, and the ring at the
// distance the engine estimates (lifefi.position, ported from
// engine/viz/position.html) with one marker per person counted. One link has
// no direction and cannot tell people apart, so the markers are spread evenly
// on the ring: they say how far and how many, not where each one stands. The
// distance is measured while someone moves and held while they stand still.
// Drag to turn, wheel or pinch to zoom. Draws only when something changed.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useLive } from "@/lib/live";
import { attachOrbit, hasWebGL, placeCamera, type Orbit } from "@/lib/orbit";
import { token, useResolvedTheme } from "@/lib/useTheme";

const H = 1.0; // board and router height, m
const D_MAX = 8;
const MAX_MARKERS = 5; // the board counts up to "5+"
// lifefi.position ZONES: near < 1.5 m, middle 1.5..3.5 m, far beyond
const ZONES = [
  { name: "near", from: 0.2, to: 1.5, color: "--present" },
  { name: "middle", from: 1.5, to: 3.5, color: "--uncertain" },
  { name: "far", from: 3.5, to: D_MAX, color: "--empty" },
] as const;
const ZONE_TEXT = { near: "Near the sensor", middle: "Middle of the room", far: "Far from the sensor" } as const;

/** Where the view takes the person from: the distance estimate, or the taught-spot model (lifefi.spots). */
export type PositionSource = "distance" | "model";

const zoneOf = (d: number | null) => (d === null ? null : d < 1.5 ? "near" : d < 3.5 ? "middle" : "far");
const ROUTER_KEY = "lifefi.routerDistance";
const ROUTER_CHOICES = [2, 3, 5];

function readRouterDistance(): number {
  try {
    const v = Number(localStorage.getItem(ROUTER_KEY));
    return ROUTER_CHOICES.includes(v) ? v : 3;
  } catch {
    return 3;
  }
}

export function Room3D({ className = "h-72", source = "distance" }: { className?: string; source?: PositionSource }) {
  const { buffers, result } = useLive();
  const host = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
  const [routerD, setRouterD] = useState(readRouterDistance);
  const [webgl] = useState(hasWebGL);

  useEffect(() => {
    const el = host.current;
    if (!el || !webgl) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return; // context lost or blocked after the check: nothing to draw on
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.prepend(renderer.domElement);
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(token("--surface-2"));
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const geo = <T extends THREE.BufferGeometry>(g: T) => (disposables.push(g), g);
    const mat = (color: THREE.ColorRepresentation, o: THREE.MeshStandardMaterialParameters = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o });
      disposables.push(m);
      return m;
    };
    const line = (color: THREE.ColorRepresentation, opacity = 1) => {
      const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
      disposables.push(m);
      return m;
    };

    const linkColor = token("--chart-breath");
    const personColor = token("--present");
    const grey = token("--subtle");

    const board = new THREE.Mesh(geo(new THREE.BoxGeometry(0.12, 0.04, 0.06)), mat(linkColor));
    board.position.set(0, H, 0);
    const stand = (x: number) => {
      const m = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.01, 0.01, H)), mat(grey));
      m.position.set(x, H / 2, 0);
      return m;
    };
    const router = new THREE.Mesh(geo(new THREE.BoxGeometry(0.22, 0.05, 0.14)), mat(token("--chart-motion")));
    router.position.set(routerD, H, 0);
    const r1 = Math.sqrt(0.125 * routerD) / 2; // first Fresnel zone at mid-link, λ = 12.5 cm
    const fresnel = new THREE.Mesh(geo(new THREE.SphereGeometry(1, 40, 20)), mat(linkColor, { transparent: true, opacity: 0.12, depthWrite: false }));
    fresnel.scale.set(routerD / 2, r1, r1);
    fresnel.position.set(routerD / 2, H, 0);
    const link = new THREE.Line(geo(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, H, 0), new THREE.Vector3(routerD, H, 0)])), line(linkColor));
    const size = Math.ceil(Math.max(routerD, D_MAX) * 2);
    const grid = new THREE.GridHelper(size, size, token("--chart-grid"), token("--chart-grid"));
    disposables.push(grid.geometry, grid.material as THREE.Material);
    scene.add(board, stand(0), router, stand(routerD), fresnel, link, grid);

    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) ringPts.push(new THREE.Vector3(Math.cos((i / 128) * 2 * Math.PI), 0.005, Math.sin((i / 128) * 2 * Math.PI)));
    const ringMat = line(personColor, 0.85);
    const ring = new THREE.Line(geo(new THREE.BufferGeometry().setFromPoints(ringPts)), ringMat);
    const band = new THREE.Mesh(geo(new THREE.RingGeometry(0.9, 1.1, 96)), mat(personColor, { transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide }));
    band.rotation.x = -Math.PI / 2;
    band.position.y = 0.004;
    scene.add(ring, band);

    // the zones on the floor; the one the person is in is drawn stronger
    const zoneMats = ZONES.map((z) => mat(token(z.color), { transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide }));
    ZONES.forEach((z, i) => {
      const m = new THREE.Mesh(geo(new THREE.RingGeometry(z.from, z.to, 96)), zoneMats[i]);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.002;
      scene.add(m);
    });

    // one marker per person, sharing geometry and material
    const personMat = mat(personColor, { transparent: true, opacity: 1 });
    const bodyGeo = geo(new THREE.CylinderGeometry(0.17, 0.15, 1.1, 20));
    const headGeo = geo(new THREE.SphereGeometry(0.12, 20, 14));
    const legsGeo = geo(new THREE.CylinderGeometry(0.14, 0.1, 0.25, 16));
    const people = Array.from({ length: MAX_MARKERS }, () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, personMat);
      body.position.y = 0.75;
      const head = new THREE.Mesh(headGeo, personMat);
      head.position.y = 1.45;
      const legs = new THREE.Mesh(legsGeo, personMat);
      legs.position.y = 0.12;
      g.add(body, head, legs);
      g.visible = false;
      scene.add(g);
      return g;
    });

    const orbit: Orbit = { theta: -0.9, phi: 1.05, r: 8, target: new THREE.Vector3(routerD / 2, 0.6, 0) };
    let dirty = true;
    const detach = attachOrbit(renderer.domElement, orbit, () => (dirty = true), [2, 25]);

    const resize = () => {
      const w = el.clientWidth || 300;
      const h = el.clientHeight || 240;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // eased display state, so the ring glides from one estimate to the next
    let shownD: number | null = null;
    let goalD: number | null = null;
    let goalSd = 0.5;
    let bandW = 0.1;
    let count = 0;
    let held = false;
    let zone: string | null = null;
    let seen = -1;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (seen !== buffers.version) {
        seen = buffers.version;
        const last = buffers.signals.length ? buffers.signals.toArray().at(-1)! : null;
        if (source === "model") {
          const s = last?.spot ?? null;
          goalD = s && s.name !== "empty" ? s.d : null;
          goalSd = 0.3;
          held = false;
          zone = zoneOf(goalD);
        } else {
          goalD = last?.d ?? null;
          goalSd = last?.sd ?? goalSd;
          held = last?.held ?? false;
          zone = last?.zone ?? null;
        }
        count = Math.min(MAX_MARKERS, Math.max(goalD !== null ? 1 : 0, goalD !== null ? (last?.people ?? 0) : 0));
        dirty = true;
      }
      if (goalD !== null) {
        shownD = shownD === null ? goalD : shownD + (goalD - shownD) * 0.12;
        if (Math.abs(goalD - shownD) > 0.002) dirty = true;
      }
      if (!dirty) return;
      dirty = false;
      const has = goalD !== null && shownD !== null;
      ring.visible = band.visible = has;
      ZONES.forEach((z, i) => (zoneMats[i].opacity = has && z.name === zone ? 0.22 : 0.06));
      personMat.opacity = held ? 0.55 : 1;
      people.forEach((g, i) => (g.visible = has && i < count));
      if (has) {
        const d = shownD!;
        ring.scale.set(d, 1, d);
        band.scale.set(d, d, 1);
        const w = Math.min(0.45, Math.max(0.05, goalSd / d)); // ± sd as a share of the radius
        if (Math.abs(w - bandW) > 0.01) {
          bandW = w;
          band.geometry.dispose();
          band.geometry = new THREE.RingGeometry(1 - w, 1 + w, 96);
        }
        // spread evenly round the ring, the first in front of the board: how many, not who is where
        for (let i = 0; i < count; i++) {
          const a = Math.PI / 2 + (i * 2 * Math.PI) / count;
          people[i].position.set(d * Math.cos(a), 0, d * Math.sin(a));
        }
      }
      placeCamera(camera, orbit);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      detach();
      band.geometry.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [buffers, routerD, theme, webgl, source]);

  const pos = result?.position ?? null;
  const n = pos ? Math.max(pos.valid ? 1 : 0, pos.people) : 0;
  const spot = pos?.spot ?? null;
  const pickRouter = (d: number) => {
    setRouterD(d);
    try {
      localStorage.setItem(ROUTER_KEY, String(d));
    } catch {
      /* private mode: just this page */
    }
  };

  return (
    <div>
      <div
        ref={host}
        role="img"
        aria-label={
          source === "model"
            ? spot
              ? `3D room view, spot model: ${spot.name}${spot.d_m !== null ? `, ${spot.d_m} metres from the sensor` : ""}`
              : "3D room view, spot model: no answer"
            : pos?.valid && pos.d_m !== null
              ? `3D room view: ${n} ${n === 1 ? "person" : "people"} about ${pos.d_m.toFixed(1)} metres from the sensor`
              : "3D room view: no distance reading"
        }
        className={`relative w-full cursor-grab overflow-hidden rounded-lg bg-surface-2 active:cursor-grabbing ${className}`}
      >
        {!webgl && <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-muted">This browser cannot draw 3D (WebGL is off).</p>}
        <div className="pointer-events-none absolute left-3 top-2 text-sm font-semibold tabular-nums">
          {source === "model" ? (
            spot ? (
              <>
                {spot.name === "empty" ? "Room empty" : `Spot: ${spot.name}`}
                {spot.d_m !== null && ` · ${spot.d_m} m`}
                <span className="font-normal text-muted"> · {Math.round(spot.p * 100)} % sure</span>
              </>
            ) : (
              <span className="font-normal text-muted">{pos ? "No spot model loaded (ml/train_spots.py)" : "No reading yet"}</span>
            )
          ) : pos?.valid && pos.d_m !== null ? (
            <>
              {n > 1 ? `${n >= MAX_MARKERS ? `${MAX_MARKERS}+` : n} people · ` : ""}
              {pos.zone ? `${ZONE_TEXT[pos.zone]} · ` : ""}
              {pos.d_m.toFixed(1)} m <span className="font-normal text-muted">± {pos.d_sd?.toFixed(1) ?? "?"} m</span>
              {pos.held && <span className="block text-xs font-normal text-muted">Standing still: last position while moving</span>}
            </>
          ) : (
            <span className="font-normal text-muted">{pos ? "Nobody to place right now" : "No distance reading yet"}</span>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
        <span>Router</span>
        {ROUTER_CHOICES.map((d) => (
          <button key={d} type="button" onClick={() => pickRouter(d)} className={`rounded-md px-2 py-0.5 font-medium ${d === routerD ? "bg-fg text-bg" : "text-muted hover:bg-surface-2"}`}>
            {d} m
          </button>
        ))}
        <span className="ml-auto">drag to turn · scroll to zoom</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-subtle">
        {ZONES.map((z) => (
          <span key={z.name} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: `var(${z.color})` }} />
            {z.name} {z.name === "far" ? `> ${z.from} m` : `< ${z.to} m`}
          </span>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted">
        {source === "model"
          ? "Spot model (experimental): names the closest of the spots it was taught in this room and draws you at that spot's measured distance. It is only as good as its recordings, and it can be wrong when the Wi-Fi itself changes."
          : "How far from the sensor, and how many people. One board cannot tell direction or who is where, so everyone is drawn on the same ring. The distance is measured while you move and held while you stand still."}
      </p>
    </div>
  );
}
