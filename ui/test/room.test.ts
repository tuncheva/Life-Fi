import { afterEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../src/lib/contracts.gen";
import { DEFAULT_ROOM, distanceRange, positionView, readRoomGeometry, roomDrawing, writeRoomGeometry, type WhereState } from "../src/lib/room";
import { reasonLinks, roomStatus, whereText, type RoomStatus } from "../src/lib/words";

const seeing: RoomStatus = { tone: "present", headline: "Someone is home", detail: null, action: null, blind: false };
const blind: RoomStatus = { tone: "offline", headline: "We cannot see the room right now", detail: null, action: null, blind: true };

type Pos = Record<string, unknown>;
const pos = (over: Pos = {}): Pos => ({ valid: true, d_m: 2.4, d_sd: 0.5, R_db: 3, noise_db: -10, held: false, zone: "middle", people: 1, ...over });
const result = (presence: Result["presence"]["state"], extra: { position?: Pos | null; occupancy?: unknown } = {}): Result =>
  ({ ts: 1000, presence: { state: presence, value: presence === "present", S: 0, B: 0, M: 0 }, health: { warmup: false }, ...extra }) as unknown as Result;

const view = (r: Result | null, status = seeing, heldSince: number | null = null) => positionView({ status, result: r, heldSince });
const here = (w: WhereState) => {
  if (w.kind !== "here") throw new Error(`expected here, got ${w.kind}`);
  return w;
};

describe("positionView", () => {
  it("is blind when the room cannot be seen, whatever the result says", () => {
    expect(view(result("present", { position: pos() }), blind)).toEqual({ kind: "blind", reason: blind.headline });
    expect(view(null).kind).toBe("blind");
  });

  it("follows presence when occupancy is missing", () => {
    expect(view(result("empty")).kind).toBe("nobody");
    expect(view(result("uncertain")).kind).toBe("unsure");
    expect(here(view(result("present"))).distance).toBeNull(); // no position at all
  });

  it("never contradicts presence: disagreements read as unsure", () => {
    expect(view(result("empty", { occupancy: { state: "occupied", p: 0.8 } })).kind).toBe("unsure");
    expect(view(result("empty", { occupancy: { state: "unsure", p: 0.5 } })).kind).toBe("nobody");
    expect(view(result("uncertain", { occupancy: { state: "occupied", p: 0.9 } })).kind).toBe("unsure");
    expect(view(result("present", { occupancy: { state: "empty", p: 0.9 }, position: pos() })).kind).toBe("unsure");
  });

  it("drops the distance when occupancy is unsure", () => {
    expect(here(view(result("present", { occupancy: { state: "unsure", p: 0.5 }, position: pos({ quality: "medium" }) }))).distance).toBeNull();
  });

  it("reads missing quality as low, none as no distance", () => {
    expect(here(view(result("present", { position: pos() }))).distance?.quality).toBe("low");
    expect(here(view(result("present", { position: pos({ quality: "medium" }) }))).distance?.quality).toBe("medium");
    expect(here(view(result("present", { position: pos({ quality: "none" }) }))).distance).toBeNull();
    expect(here(view(result("present", { position: pos({ quality: "high" }) }))).distance?.quality).toBe("low"); // unknown word
  });

  it("needs a valid position with a distance", () => {
    expect(here(view(result("present", { position: pos({ valid: false }) }))).distance).toBeNull();
    expect(here(view(result("present", { position: pos({ d_m: null }) }))).distance).toBeNull();
  });

  it("keeps known reasons only", () => {
    const w = here(view(result("present", { position: pos({ quality_reasons: ["transmitter_not_fixed", "made_up", 3, "low_packet_rate"] }) })));
    expect(w.reasons).toEqual(["transmitter_not_fixed", "low_packet_rate"]);
    expect(w.distance?.reasons).toEqual(["transmitter_not_fixed", "low_packet_rate"]);
  });

  it("shows a spot only when the engine calls it reliable", () => {
    const spot = (s: Pos) => here(view(result("present", { position: pos({ spot: { name: "desk", p: 0.9, d_m: 2, ...s } }) }))).spot;
    expect(spot({})).toBeNull();
    expect(spot({ reliable: false })).toBeNull();
    expect(spot({ reliable: true })).toEqual({ name: "desk", d: 2 });
    expect(spot({ reliable: true, name: "empty" })).toBeNull();
  });

  it("carries heldSince only while held", () => {
    expect(here(view(result("present", { position: pos({ held: true }) }), seeing, 500)).distance).toMatchObject({ held: true, heldSince: 500 });
    expect(here(view(result("present", { position: pos({ held: false }) }), seeing, 500)).distance?.heldSince).toBeNull();
  });

  it("counts at least one person while present", () => {
    expect(here(view(result("present", { position: pos({ people: 0 }) }))).people).toBe(1);
    expect(here(view(result("present", { position: pos({ people: 2 }) }))).people).toBe(2);
  });
});

describe("whereText", () => {
  const w = (over: Partial<Extract<WhereState, { kind: "here" }>> = {}): WhereState => ({ kind: "here", people: 1, distance: null, spot: null, reasons: [], ...over });
  const dist = (quality: "low" | "medium", over = {}) => ({ d: 2.4, sd: 0.5, quality, reasons: [], held: false, heldSince: null, ...over });

  it("says nothing about where without a distance", () => {
    expect(whereText(w())).toEqual({ headline: "Someone is here", detail: "We can't tell where in the room right now", reasons: [] });
  });

  it("gives no number for a low-quality distance", () => {
    const t = whereText(w({ distance: dist("low"), reasons: ["no_distance_fit"] }));
    expect(t.headline).toBe("Someone is here");
    expect(t.detail).toBe("Distance: rough guess only");
    expect(`${t.headline} ${t.detail}`).not.toMatch(/[0-9]/);
    expect(t.reasons).toEqual(["Distance not tuned for this room yet"]);
  });

  it("gives a rounded range for a medium distance", () => {
    expect(whereText(w({ distance: dist("medium") })).headline).toBe("Someone is here, roughly 2 to 3 m from the sensor");
    expect(whereText(w({ distance: dist("medium", { d: 0.7 }) })).headline).toBe("Someone is here, less than 1 m from the sensor");
    expect(whereText(w({ distance: dist("medium"), reasons: ["no_distance_fit"] })).reasons).toEqual([]);
  });

  it("mentions holding, several people and a spot", () => {
    const t = whereText(w({ people: 2, distance: dist("low", { held: true, heldSince: null }), spot: { name: "reading_chair", d: null } }));
    expect(t.headline).toBe("More than one person may be here");
    expect(t.detail).toBe("One sensor can't tell them apart · distance: rough guess only · standing still · probably at the reading chair");
  });

  it("covers the other states", () => {
    expect(whereText({ kind: "nobody" }).headline).toBe("Nobody in the room");
    expect(whereText({ kind: "unsure" }).headline).toBe("Not sure if anyone is there");
    expect(whereText({ kind: "blind", reason: "Can't reach the Life-Fi box" }).headline).toBe("Can't reach the Life-Fi box");
  });

  it("links every reason to its setup step", () => {
    expect(reasonLinks(["transmitter_not_fixed", "no_distance_fit", "no_empty_calibration", "low_packet_rate"]).map((l) => l.href)).toEqual([
      "/setup?step=transmitter",
      "/setup?step=fit",
      "/setup?step=calibrate",
      "/setup?step=sensor",
    ]);
  });
});

describe("roomStatus and positionView agree", () => {
  const status = (r: Result) => roomStatus({ connected: true, status: null, result: r, stale: false, presenceSince: null, profile: "home", now: 2000 });

  it("hedges the headline when presence says empty but occupancy sees someone", () => {
    const r = result("empty", { occupancy: { state: "occupied", p: 0.8 } });
    expect(status(r).headline).toBe("Not sure if anyone is there");
    expect(whereText(view(r, status(r))).headline).toBe("Not sure if anyone is there");
    expect(status(result("empty", { occupancy: { state: "empty", p: 0.9 } })).headline).toBe("Nobody in the room");
    expect(status(result("empty")).headline).toBe("Nobody in the room");
  });

  it("says the room is not watched while the board can't be read, not 'starting up'", () => {
    // the engine keeps ticking in warm-up with no board, inside the watchdog's start-up grace
    const r = { ...result("empty"), health: { ...result("empty").health, warmup: true } } as Result;
    const board = { engine: { connected: true }, server: { sensor_offline: null }, source: { state: "error", error: "no USB serial port found" } };
    const s = roomStatus({ connected: true, status: board as never, result: r, stale: false, presenceSince: null, profile: "home", now: 2000 });
    expect(s.headline).toBe("We cannot see the room right now");
    expect(s.detail).toContain("can't be read (no USB serial port found)");
  });
});

describe("roomDrawing", () => {
  const draw = (position: Pos, extra: { occupancy?: unknown } = {}) => roomDrawing(view(result("present", { position, ...extra })));

  it("draws a ring and a scale for a medium distance", () => {
    expect(draw(pos({ quality: "medium" }))).toEqual({ ring: { d: 2.4, sd: 0.5, held: false, rough: false }, scale: true });
    expect(draw(pos({ quality: "medium", held: true })).ring?.held).toBe(true);
  });

  it("draws a low or missing quality as a wide rough band, without the scale", () => {
    expect(draw(pos({ quality: "low", quality_reasons: ["transmitter_not_fixed"] }))).toEqual({ ring: { d: 2.4, sd: 0.5, held: false, rough: true }, scale: false });
    expect(draw(pos())).toEqual({ ring: { d: 2.4, sd: 0.5, held: false, rough: true }, scale: false }); // an older engine: no quality reads as low
    expect(draw(pos({ quality: "low", d_sd: 0.1 })).ring?.sd).toBe(0.5); // never thinner than the guess deserves
    expect(draw(pos({ quality: "low", d_sd: 0.9 })).ring?.sd).toBe(0.9);
  });

  it("draws nothing without a usable distance", () => {
    expect(draw(pos({ quality: "none" }))).toEqual({ ring: null, scale: false });
    expect(draw(pos({ quality: "medium" }), { occupancy: { state: "unsure", p: 0.5 } })).toEqual({ ring: null, scale: false });
  });

  it("draws nothing for the other states", () => {
    for (const w of [{ kind: "nobody" }, { kind: "unsure" }, { kind: "blind", reason: "x" }] as WhereState[]) expect(roomDrawing(w)).toEqual({ ring: null, scale: false });
  });
});

describe("distanceRange", () => {
  it("rounds to half metres and never collapses", () => {
    expect(distanceRange(2.4, 0.5)).toEqual({ lo: 2, hi: 3 });
    expect(distanceRange(2.4, 0)).toEqual({ lo: 2.5, hi: 3 });
  });
});

describe("room geometry", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubStorage = (init: Record<string, string>) => {
    const store = new Map(Object.entries(init));
    const target = new EventTarget();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
    });
    return store;
  };

  it("is the default on the server", () => {
    expect(readRoomGeometry()).toEqual(DEFAULT_ROOM);
  });

  it("migrates the old router distance once", () => {
    const store = stubStorage({ "lifefi.routerDistance": "5" });
    expect(readRoomGeometry()).toEqual({ ...DEFAULT_ROOM, tx_m: 5 });
    expect(store.has("lifefi.routerDistance")).toBe(false);
    expect(JSON.parse(store.get("lifefi.room")!)).toEqual({ ...DEFAULT_ROOM, tx_m: 5 });
  });

  it("round-trips and repairs broken values", () => {
    stubStorage({});
    writeRoomGeometry({ length_m: 6, width_m: 3.5, tx_m: 2.2 });
    expect(readRoomGeometry()).toEqual({ length_m: 6, width_m: 3.5, tx_m: 2.2 });
    stubStorage({ "lifefi.room": JSON.stringify({ length_m: -1, width_m: "x", tx_m: null }) });
    expect(readRoomGeometry()).toEqual(DEFAULT_ROOM);
    stubStorage({ "lifefi.room": "{not json" });
    expect(readRoomGeometry()).toEqual(DEFAULT_ROOM);
  });
});
