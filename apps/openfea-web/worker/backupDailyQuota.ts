/// <reference types="./worker-configuration" />

// Global daily byte cap for encrypted project backups.
//
// Every accepted upload, from every client, counts against one ledger per UTC
// day. The ledger lives in a single Durable Object instance so reservations
// are strongly consistent: the Worker reserves the declared Content-Length
// BEFORE streaming to R2, commits the stored size on success, and releases the
// reservation on any failure. Concurrent uploads therefore cannot overshoot
// the cap (an eventually consistent KV counter could).
//
// A reservation whose Worker dies before commit/release stays counted until
// the next UTC midnight. That over-counts (refuses earlier), never
// under-counts. An upload still in flight across UTC midnight is dropped from
// the new day's ledger; it is not counted on either day.

export const DEFAULT_PROJECT_BACKUP_DAILY_CAP_BYTES = 10 * 1024 * 1024 * 1024;
export const PROJECT_BACKUP_DAILY_CAP_VAR = "PROJECT_BACKUP_DAILY_CAP_BYTES";
export const BACKUP_DAILY_CAP_REACHED_CODE = "backup_daily_cap_reached";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEDGER_KEY = "ledger";
// One global instance: the cap is shared by all clients.
const QUOTA_OBJECT_NAME = "project-backups-daily-bytes";
const QUOTA_ORIGIN = "https://project-backup-daily-quota.internal";

export type DailyCapConfig = { ok: true; capBytes: number } | { ok: false; reason: string };

/**
 * Parses the Wrangler var. Unset means the 10 GiB default; anything set must
 * be a positive integer byte count (plain digits, no units). A malformed value
 * is a deployment error, so callers fail closed instead of guessing.
 */
export function parseDailyCapBytes(raw: unknown): DailyCapConfig {
  if (raw === undefined || raw === null) return { ok: true, capBytes: DEFAULT_PROJECT_BACKUP_DAILY_CAP_BYTES };
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
  if (text === null || !/^[1-9][0-9]*$/u.test(text)) {
    return { ok: false, reason: `${PROJECT_BACKUP_DAILY_CAP_VAR} must be a positive integer byte count, got ${JSON.stringify(raw)}` };
  }
  const capBytes = Number(text);
  if (!Number.isSafeInteger(capBytes)) {
    return { ok: false, reason: `${PROJECT_BACKUP_DAILY_CAP_VAR} exceeds the largest safe integer` };
  }
  return { ok: true, capBytes };
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nextUtcMidnightMs(nowMs: number): number {
  return (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
}

export function secondsUntilNextUtcMidnight(nowMs: number): number {
  return Math.max(1, Math.ceil((nextUtcMidnightMs(nowMs) - nowMs) / 1000));
}

export type ReserveResult =
  | { ok: true; reservationId: string; day: string }
  | { ok: false; day: string; usedBytes: number; capBytes: number; retryAfterSeconds: number; resetsAt: string };

export interface QuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface LedgerState {
  day: string;
  committedBytes: number;
  reservations: Record<string, number>;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Storage-agnostic ledger. Operations are serialized on an internal queue so
 * read-modify-write cycles never interleave, independent of Durable Object
 * input gates (which also serialize them in production).
 */
export class DailyQuotaLedger {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: QuotaStorage,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  reserve(bytes: number, capBytes: number): Promise<ReserveResult> {
    if (!isPositiveSafeInteger(bytes)) return Promise.reject(new RangeError("Reservation size must be a positive integer."));
    if (!isPositiveSafeInteger(capBytes)) return Promise.reject(new RangeError("Daily cap must be a positive integer."));
    return this.serialize(async () => {
      const nowMs = this.now();
      const state = await this.load(nowMs);
      const usedBytes = state.committedBytes + Object.values(state.reservations).reduce((sum, value) => sum + value, 0);
      if (usedBytes + bytes > capBytes) {
        return {
          ok: false,
          day: state.day,
          usedBytes,
          capBytes,
          retryAfterSeconds: secondsUntilNextUtcMidnight(nowMs),
          resetsAt: new Date(nextUtcMidnightMs(nowMs)).toISOString()
        };
      }
      const reservationId = this.newId();
      state.reservations[reservationId] = bytes;
      await this.storage.put(LEDGER_KEY, state);
      return { ok: true, reservationId, day: state.day };
    });
  }

  /** Converts a reservation into accepted bytes. Unknown ids (released, or from a previous UTC day) are ignored. */
  commit(reservationId: string, storedBytes: number): Promise<{ ok: boolean }> {
    return this.serialize(async () => {
      const state = await this.load(this.now());
      const reserved = state.reservations[reservationId];
      if (reserved === undefined) return { ok: false };
      delete state.reservations[reservationId];
      state.committedBytes += Number.isSafeInteger(storedBytes) && storedBytes > 0 ? storedBytes : reserved;
      await this.storage.put(LEDGER_KEY, state);
      return { ok: true };
    });
  }

  /** Returns a reservation's bytes to the day's budget. Unknown ids are ignored. */
  release(reservationId: string): Promise<{ ok: boolean }> {
    return this.serialize(async () => {
      const state = await this.load(this.now());
      if (state.reservations[reservationId] === undefined) return { ok: false };
      delete state.reservations[reservationId];
      await this.storage.put(LEDGER_KEY, state);
      return { ok: true };
    });
  }

  usage(): Promise<{ day: string; committedBytes: number; reservedBytes: number }> {
    return this.serialize(async () => {
      const state = await this.load(this.now());
      return {
        day: state.day,
        committedBytes: state.committedBytes,
        reservedBytes: Object.values(state.reservations).reduce((sum, value) => sum + value, 0)
      };
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  // A stored ledger from an earlier UTC day is discarded: the cap resets at
  // 00:00 UTC and stale reservations are dropped with it.
  private async load(nowMs: number): Promise<LedgerState> {
    const day = utcDay(nowMs);
    const stored = await this.storage.get<LedgerState>(LEDGER_KEY);
    if (stored && stored.day === day) {
      return { day, committedBytes: stored.committedBytes, reservations: { ...stored.reservations } };
    }
    return { day, committedBytes: 0, reservations: {} };
  }
}

/** Durable Object holding the global per-UTC-day backup byte ledger. */
export class ProjectBackupDailyQuota implements DurableObject {
  private readonly ledger: DailyQuotaLedger;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ledger = new DailyQuotaLedger(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid quota request." }, { status: 400 });
    }
    const operation = new URL(request.url).pathname;
    try {
      if (operation === "/reserve") {
        if (!isPositiveSafeInteger(body.bytes) || !isPositiveSafeInteger(body.capBytes)) {
          return Response.json({ error: "Invalid quota reservation." }, { status: 400 });
        }
        return Response.json(await this.ledger.reserve(body.bytes, body.capBytes));
      }
      if (typeof body.reservationId !== "string") return Response.json({ error: "Invalid quota reservation id." }, { status: 400 });
      if (operation === "/commit") {
        return Response.json(await this.ledger.commit(body.reservationId, typeof body.bytes === "number" ? body.bytes : 0));
      }
      if (operation === "/release") return Response.json(await this.ledger.release(body.reservationId));
      return Response.json({ error: "Unknown quota operation." }, { status: 404 });
    } catch {
      return Response.json({ error: "Quota operation failed." }, { status: 500 });
    }
  }
}

export interface DailyQuotaNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

async function callQuota(namespace: DailyQuotaNamespace, operation: string, payload: Record<string, unknown>): Promise<unknown> {
  const stub = namespace.get(namespace.idFromName(QUOTA_OBJECT_NAME));
  const response = await stub.fetch(`${QUOTA_ORIGIN}/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Backup quota ${operation} failed with HTTP ${response.status}.`);
  return response.json();
}

export async function reserveDailyBackupBytes(namespace: DailyQuotaNamespace, bytes: number, capBytes: number): Promise<ReserveResult> {
  return await callQuota(namespace, "reserve", { bytes, capBytes }) as ReserveResult;
}

export async function commitDailyBackupBytes(namespace: DailyQuotaNamespace, reservationId: string, bytes: number): Promise<void> {
  await callQuota(namespace, "commit", { reservationId, bytes });
}

export async function releaseDailyBackupBytes(namespace: DailyQuotaNamespace, reservationId: string): Promise<void> {
  await callQuota(namespace, "release", { reservationId });
}
