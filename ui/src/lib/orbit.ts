// Drag-to-rotate, wheel/pinch-to-zoom camera for the three.js live views
// (as engine/viz/position.html). No OrbitControls import: a few lines do it.
import type { PerspectiveCamera, Vector3 } from "three";

export interface Orbit {
  theta: number;
  phi: number;
  r: number;
  target: Vector3;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function placeCamera(camera: PerspectiveCamera, o: Orbit): void {
  camera.position.set(
    o.target.x + o.r * Math.sin(o.phi) * Math.cos(o.theta),
    o.target.y + o.r * Math.cos(o.phi),
    o.target.z + o.r * Math.sin(o.phi) * Math.sin(o.theta),
  );
  camera.lookAt(o.target);
}

/** Wires pointer and wheel input on `el` to `o`; `changed` is called after every move. Returns the cleanup. */
export function attachOrbit(el: HTMLElement, o: Orbit, changed: () => void, rRange: [number, number] = [1.5, 25]): () => void {
  const pointers = new Map<number, PointerEvent>();
  let pinch = 0;
  const down = (e: PointerEvent) => {
    pointers.set(e.pointerId, e);
    el.setPointerCapture(e.pointerId);
  };
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = 0;
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch) o.r = clamp((o.r * pinch) / dist, ...rRange);
      pinch = dist;
    } else {
      o.theta -= (e.clientX - prev.clientX) * 0.008;
      o.phi = clamp(o.phi - (e.clientY - prev.clientY) * 0.008, 0.15, 1.5);
    }
    changed();
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    o.r = clamp(o.r * (1 + Math.sign(e.deltaY) * 0.1), ...rRange);
    changed();
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("pointermove", move);
  el.addEventListener("wheel", wheel, { passive: false });
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("wheel", wheel);
  };
}

/** Whether this browser can give a WebGL context (the 3D views are client-only). */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}
