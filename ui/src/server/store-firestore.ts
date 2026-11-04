// Firestore implementation of the event store (track FB). History is buffered per minute and
// written as one doc (`history/{minuteStartMs}` with up to 12 rows), ~1.4k writes a day instead of
// ~17k, inside the Spark free tier. Everything else is one doc per alert / transition / event.
// Writes go through a BulkWriter (retried, never awaited by the caller); failures are logged.
import { cert, getApps, initializeApp, applicationDefault, type App } from "firebase-admin/app";
import { getFirestore, type BulkWriter, type CollectionReference, type Firestore } from "firebase-admin/firestore";
import type { Alert } from "./alerts";
import type { Logger } from "./log";
import {
  pickFields,
  toVitalsRow,
  transitionTime,
  type EventKind,
  type HistoryField,
  type HistoryRow,
  type Store,
  type StoreEvent,
  type VitalsRow,
} from "./store";

const MINUTE = 60_000;
const DELETE_PAGE = 400;
const HISTORY_CACHE_MS = 26 * 3600_000;
const EVENTS_CACHE_MS = 7 * 86_400_000;
const EVENTS_CACHE_MAX = 5000;

export interface FirebaseEnv {
  projectId: string;
  clientEmail: string | null;
  privateKey: string | null;
  prefix: string;
  emulator: boolean;
}

/**
 * The service-account key as PEM. .env files keep it on one line with literal "\n", often quoted;
 * a key pasted without its BEGIN/END lines (just the base64 body) is wrapped back.
 */
export function pemKey(raw: string | undefined): string | null {
  const v = raw?.trim().replace(/^"|"$/g, "").replace(/\\n/g, "\n").trim();
  if (!v) return null;
  if (v.includes("-----BEGIN")) return v.endsWith("\n") ? v : `${v}\n`;
  const body = v.replace(/\s+/g, "");
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** Null when Firebase is not configured (no project id, or neither a key nor ADC nor the emulator). */
export function firebaseEnv(env: Record<string, string | undefined> = process.env): FirebaseEnv | null {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) return null;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim() || null;
  const privateKey = pemKey(env.FIREBASE_PRIVATE_KEY);
  const emulator = !!env.FIRESTORE_EMULATOR_HOST;
  if (!emulator && !(clientEmail && privateKey) && !env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  return { projectId, clientEmail, privateKey, prefix: env.FIRESTORE_COLLECTION_PREFIX ?? "lifefi_", emulator };
}

function firebaseApp(fe: FirebaseEnv): App {
  const existing = getApps().find((a) => a.name === "lifefi");
  if (existing) return existing;
  const credential = fe.clientEmail && fe.privateKey ? cert({ projectId: fe.projectId, clientEmail: fe.clientEmail, privateKey: fe.privateKey }) : fe.emulator ? undefined : applicationDefault();
  return initializeApp({ projectId: fe.projectId, ...(credential ? { credential } : {}) }, "lifefi");
}

/** The rows of a minute doc: a map keyed by t (an array in docs written before the merge fix). */
export function docRows(v: unknown): HistoryRow[] {
  if (Array.isArray(v)) return v as HistoryRow[];
  return v && typeof v === "object" ? Object.values(v as Record<string, HistoryRow>) : [];
}

export class FirestoreStore implements Store {
  readonly kind = "firestore" as const;
  private readonly db: Firestore;
  private writer: BulkWriter;
  private readonly col: { history: CollectionReference; alerts: CollectionReference; alertLog: CollectionReference; events: CollectionReference };
  private minute: number | null = null;
  private buffer = new Map<number, HistoryRow>();
  private readonly flushTimer: NodeJS.Timeout;

  constructor(
    fe: FirebaseEnv,
    private readonly log: Logger,
    warm = true,
  ) {
    this.db = getFirestore(firebaseApp(fe));
    try {
      this.db.settings({ ignoreUndefinedProperties: true });
    } catch {
      // already initialised (dev hot reload)
    }
    this.col = {
      history: this.db.collection(`${fe.prefix}history`),
      alerts: this.db.collection(`${fe.prefix}alerts`),
      alertLog: this.db.collection(`${fe.prefix}alert_log`),
      events: this.db.collection(`${fe.prefix}events`),
    };
    this.writer = this.newWriter();
    // a minute with no later row would otherwise wait for the next one
    this.flushTimer = setInterval(() => {
      if (this.minute !== null && Date.now() - this.minute > 2 * MINUTE) this.flushMinute();
      this.pruneCache();
    }, MINUTE);
    this.flushTimer.unref();
    if (warm) this.ready = this.warm();
  }

  // ---- in-memory cache --------------------------------------------------------
  // The dashboard polls history every 15-60 s and events every 30 s; one read per doc would use up
  // the Spark free tier (50k reads/day) in hours. The last HISTORY_CACHE_MS of history and
  // EVENTS_CACHE_MS of events are loaded once and kept in memory with every write; older
  // ranges still go to Firestore.

  private readonly ramHistory = new Map<number, HistoryRow>();
  private ramEvents: StoreEvent[] = [];
  /** Reads with `from` at or after these come from memory (Infinity until the warm-up is done). */
  private historyFrom = Infinity;
  private eventsFrom = Infinity;
  /** Resolves when the cache is loaded (or failed to load: then reads keep going to Firestore). */
  readonly ready: Promise<void> = Promise.resolve();

  private async warm(now = Date.now()): Promise<void> {
    try {
      const hFrom = now - HISTORY_CACHE_MS;
      const eFrom = now - EVENTS_CACHE_MS;
      const [h, e] = await Promise.all([
        this.col.history.where("t", ">=", Math.floor(hFrom / MINUTE) * MINUTE).get(),
        this.col.events.where("t", ">=", eFrom).orderBy("t", "desc").limit(EVENTS_CACHE_MAX).get(),
      ]);
      for (const d of h.docs) for (const r of docRows(d.get("rows"))) if (!this.ramHistory.has(r.t)) this.ramHistory.set(r.t, r);
      const stored = e.docs.map((d) => d.data() as StoreEvent).reverse();
      // events written while warming are already in ramEvents; keep each once
      const seen = new Set(this.ramEvents.map((x) => `${x.t}|${x.kind}`));
      this.ramEvents = [...stored.filter((x) => !seen.has(`${x.t}|${x.kind}`)), ...this.ramEvents].sort((a, b) => a.t - b.t);
      this.historyFrom = hFrom;
      // a full page means older events exist that are not cached
      this.eventsFrom = e.size >= EVENTS_CACHE_MAX ? (stored[0]?.t ?? now) : eFrom;
      this.log.info({ history_rows: this.ramHistory.size, events: this.ramEvents.length, reads: h.size + e.size }, "firestore cache warm");
    } catch (err) {
      this.log.warn({ error: (err as Error)?.message ?? String(err) }, "firestore cache warm-up failed; reads go to Firestore");
    }
  }

  private pruneCache(now = Date.now()): void {
    if (this.historyFrom !== Infinity) {
      this.historyFrom = Math.max(this.historyFrom, now - HISTORY_CACHE_MS);
      for (const t of this.ramHistory.keys()) if (t < this.historyFrom) this.ramHistory.delete(t);
    }
    if (this.eventsFrom !== Infinity) {
      this.eventsFrom = Math.max(this.eventsFrom, now - EVENTS_CACHE_MS);
      this.ramEvents = this.ramEvents.filter((e) => e.t >= this.eventsFrom);
    }
  }

  private newWriter(): BulkWriter {
    const w = this.db.bulkWriter();
    w.onWriteError((err) => {
      if (err.failedAttempts < 3) return true;
      this.log.warn({ path: err.documentRef.path, error: err.message }, "firestore write dropped");
      return false;
    });
    return w;
  }

  private flushSoon: NodeJS.Timeout | null = null;
  /** Per alert id, the last write: the next one waits for it (BulkWriter does not keep order per doc). */
  private readonly alertChain = new Map<string, Promise<void>>();

  /** BulkWriter sends only full batches (20) on its own, so queued writes are flushed within a second. */
  private queue(p: Promise<unknown>): void {
    p.catch(() => {}); // logged by onWriteError
    if (this.flushSoon) return;
    this.flushSoon = setTimeout(() => {
      this.flushSoon = null;
      this.writer.flush().catch(() => {});
    }, 1000);
    this.flushSoon.unref();
  }

  // ---- history ----------------------------------------------------------------

  addHistory(r: HistoryRow): void {
    const m = Math.floor(r.t / MINUTE) * MINUTE;
    if (this.minute !== null && m !== this.minute) this.flushMinute();
    this.minute = m;
    const row = { ...r, heart_bpm: r.heart_bpm ?? null, heart_valid: r.heart_valid ?? null };
    this.buffer.set(r.t, row);
    this.ramHistory.set(r.t, row);
  }

  private flushMinute(): void {
    if (this.minute === null || !this.buffer.size) return;
    const rows = this.buffer;
    // rows keyed by t and merged: a late row (replay jumping back, a restart in the same minute)
    // adds or replaces its own key instead of overwriting the minute
    const write = this.writer.set(this.col.history.doc(String(this.minute)), { t: this.minute, rows: Object.fromEntries([...rows].map(([t, r]) => [String(t), r])) }, { merge: true });
    // readable until Firestore has it
    this.inflight.add(rows);
    this.queue(write.finally(() => this.inflight.delete(rows)));
    this.buffer = new Map();
    this.minute = null;
  }

  private readonly inflight = new Set<Map<number, HistoryRow>>();

  private async rows(from: number, to: number): Promise<HistoryRow[]> {
    if (from >= this.historyFrom) return [...this.ramHistory.values()].filter((r) => r.t >= from && r.t <= to).sort((a, b) => a.t - b.t);
    const snap = await this.col.history.where("t", ">=", Math.floor(from / MINUTE) * MINUTE).where("t", "<=", to).orderBy("t").get();
    const byT = new Map<number, HistoryRow>();
    for (const d of snap.docs) for (const r of docRows(d.get("rows"))) byT.set(r.t, r);
    // minutes queued or not written yet win over what is stored
    for (const m of [...this.inflight, this.buffer]) for (const r of m.values()) byT.set(r.t, r);
    return [...byT.values()].filter((r) => r.t >= from && r.t <= to).sort((a, b) => a.t - b.t);
  }

  async queryHistory(from: number, to: number, fields?: HistoryField[]): Promise<Partial<HistoryRow>[]> {
    return (await this.rows(from, to)).map((r) => pickFields(r, fields));
  }

  async vitalsRows(from: number, to: number): Promise<VitalsRow[]> {
    return (await this.rows(from, to)).filter((r) => r.t < to).map(toVitalsRow);
  }

  /** Minute docs stored (each holds up to 12 rows); only logged at boot. */
  async historySize(): Promise<number> {
    return (await this.col.history.count().get()).data().count;
  }

  private async deleteOlder(col: CollectionReference, field: string, cutoff: number, countRows = false): Promise<number> {
    let gone = 0;
    for (;;) {
      const snap = await col.where(field, "<", cutoff).limit(DELETE_PAGE).get();
      if (snap.empty) return gone;
      const batch = this.db.batch();
      for (const d of snap.docs) {
        batch.delete(d.ref);
        gone += countRows ? docRows(d.get("rows")).length : 1;
      }
      await batch.commit();
      if (snap.size < DELETE_PAGE) return gone;
    }
  }

  async purge(retentionDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - retentionDays * 86_400_000;
    const rows = await this.deleteOlder(this.col.history, "t", cutoff, true);
    await this.deleteOlder(this.col.alerts, "created_at", cutoff);
    await this.deleteOlder(this.col.alertLog, "t", cutoff);
    await this.deleteOlder(this.col.events, "t", cutoff);
    for (const t of this.ramHistory.keys()) if (t < cutoff) this.ramHistory.delete(t);
    this.ramEvents = this.ramEvents.filter((e) => e.t >= cutoff);
    return rows;
  }

  // ---- alerts -----------------------------------------------------------------

  saveAlert(a: Alert): void {
    const snap = structuredClone(a);
    const ref = this.col.alerts.doc(a.id);
    // after the previous write of this alert, so the stored state is the latest one
    const next = (this.alertChain.get(a.id) ?? Promise.resolve()).then(() => {
      const w = this.writer.set(ref, snap);
      this.queue(w);
      return w.then(
        () => {},
        () => {},
      );
    });
    this.alertChain.set(a.id, next);
    void next.then(() => {
      if (this.alertChain.get(a.id) === next) this.alertChain.delete(a.id);
    });
    this.queue(this.writer.create(this.col.alertLog.doc(), { alert_id: a.id, state: a.state, t: transitionTime(a), config_hash: a.config_hash }));
  }

  async loadAlerts(limit = 500): Promise<Alert[]> {
    const snap = await this.col.alerts.orderBy("created_at", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data() as Alert);
  }

  // ---- events -----------------------------------------------------------------

  addEvent(e: StoreEvent): void {
    const copy = structuredClone(e);
    this.queue(this.writer.create(this.col.events.doc(), copy));
    this.ramEvents.push(copy);
    if (this.ramEvents.length > EVENTS_CACHE_MAX * 2) this.ramEvents.splice(0, this.ramEvents.length - EVENTS_CACHE_MAX);
  }

  async queryEvents(from: number, to: number, kind?: EventKind): Promise<StoreEvent[]> {
    if (from >= this.eventsFrom) return this.ramEvents.filter((e) => e.t >= from && e.t <= to && (!kind || e.kind === kind)).sort((a, b) => a.t - b.t);
    // the newest 2000 (single-field index only); kind is filtered here, so no composite index is needed
    const snap = await this.col.events.where("t", ">=", from).where("t", "<=", to).orderBy("t", "desc").limit(2000).get();
    return snap.docs
      .map((d) => d.data() as StoreEvent)
      .filter((e) => !kind || e.kind === kind)
      .reverse();
  }

  /** Writes the open minute and waits for every queued write (tests, shutdown). */
  async flush(): Promise<void> {
    this.flushMinute();
    // chained alert writes enqueue only after the one before them is written
    while (this.alertChain.size) {
      const pending = [...this.alertChain.values()];
      await this.writer.flush();
      await Promise.all(pending);
    }
    await this.writer.flush();
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    if (this.flushSoon) clearTimeout(this.flushSoon);
    await this.flush();
    const w = this.writer;
    this.writer = this.newWriter();
    await w.close();
  }
}
