"use client";
// Live 3D CSI surface: the last ~30 s of the 52 Wi-Fi subcarrier amplitudes the
// board sends over USB, as a landscape. Left → right is frequency, back → front
// is time (newest at the front), height and colour are the amplitude (dB),
// scaled to the 2nd-98th percentile on screen like the 2D heatmap. A still room
// is a flat, steady landscape; a person moving makes it ripple.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { CSI_ROWS, useLive } from "@/lib/live";
import { attachOrbit, hasWebGL, placeCamera, type Orbit } from "@/lib/orbit";
import { token, useResolvedTheme } from "@/lib/useTheme";
import { ramp } from "./Cards";

const N_SUB = 52;
const WIDTH = 3.2; // scene units across the 52 subcarriers
const DEPTH = 4.0; // scene units along the time axis
const HEIGHT = 1.0;

export function CsiSurface3D({ className = "h-72" }: { className?: string }) {
  const { buffers, result } = useLive();
  const host = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
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
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);

    // one vertex per (row, subcarrier); rows = time, oldest at the back
    const geom = new THREE.PlaneGeometry(WIDTH, DEPTH, N_SUB - 1, CSI_ROWS - 1);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    const colors = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    geom.setAttribute("color", colors);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const surface = new THREE.Mesh(geom, material);
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.PlaneGeometry(WIDTH, DEPTH, 13, 10).rotateX(-Math.PI / 2)), new THREE.LineBasicMaterial({ color: token("--chart-grid") }));
    wire.position.y = -0.002;
    scene.add(surface, wire);
    const emptyRGB = new THREE.Color(token("--surface-2"));

    const orbit: Orbit = { theta: 1.15, phi: 0.95, r: 6.2, target: new THREE.Vector3(0, 0.25, 0.2) };
    let dirty = true;
    const detach = attachOrbit(renderer.domElement, orbit, () => (dirty = true), [2.5, 14]);

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

    let seen = -1;
    let raf = 0;
    const update = () => {
      const rows = buffers.csi.toArray();
      const sample: number[] = [];
      for (let r = 0; r < rows.length; r += 2) for (let k = 0; k < rows[r]!.length; k += 4) sample.push(rows[r]![k]!);
      sample.sort((a, b) => a - b);
      const lo = sample.length ? sample[Math.floor(0.02 * (sample.length - 1))]! : 0;
      const hi = sample.length ? Math.max(lo + 1, sample[Math.floor(0.98 * (sample.length - 1))]!) : 1;
      const off = CSI_ROWS - rows.length; // missing (older) rows stay flat and blank
      const p = pos.array as Float32Array;
      const c = colors.array as Float32Array;
      // PlaneGeometry rows run from the far edge (-z after the rotation) to the near one: row 0 = oldest
      for (let r = 0; r < CSI_ROWS; r++) {
        const row = rows[r - off];
        for (let k = 0; k < N_SUB; k++) {
          const i = r * N_SUB + k;
          if (!row) {
            p[i * 3 + 1] = 0;
            c[i * 3] = emptyRGB.r;
            c[i * 3 + 1] = emptyRGB.g;
            c[i * 3 + 2] = emptyRGB.b;
            continue;
          }
          const v = Math.max(0, Math.min(1, ((row[k] ?? lo) - lo) / (hi - lo)));
          p[i * 3 + 1] = v * HEIGHT;
          const [rr, gg, bb] = ramp(v);
          c[i * 3] = rr / 255;
          c[i * 3 + 1] = gg / 255;
          c[i * 3 + 2] = bb / 255;
        }
      }
      pos.needsUpdate = true;
      colors.needsUpdate = true;
      geom.computeBoundingSphere();
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (seen !== buffers.version) {
        seen = buffers.version;
        update();
        dirty = true;
      }
      if (!dirty) return;
      dirty = false;
      placeCamera(camera, orbit);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      detach();
      geom.dispose();
      material.dispose();
      wire.geometry.dispose();
      (wire.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [buffers, theme, webgl]);

  return (
    <div>
      <div
        ref={host}
        role="img"
        aria-label="3D view of the raw Wi-Fi signal: 52 frequency bands over the last 30 seconds. No image of the room or the person."
        className={`relative w-full cursor-grab overflow-hidden rounded-lg bg-surface-2 active:cursor-grabbing ${className}`}
      >
        {!webgl && <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-muted">This browser cannot draw 3D (WebGL is off).</p>}
        {webgl && !result?.csi.length && <p className="pointer-events-none absolute inset-x-0 top-2 px-3 text-sm text-muted">No CSI from the board right now</p>}
      </div>
      <div className="mt-2 flex justify-between text-xs text-subtle">
        <span>52 Wi-Fi bands × last 30 s</span>
        <span>drag to turn · scroll to zoom</span>
      </div>
      <p className="mt-2 text-sm text-muted">Each ridge is one Wi-Fi frequency, newest at the front. A still room is a calm landscape; movement makes it ripple.</p>
    </div>
  );
}
