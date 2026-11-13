import { describe, expect, test } from "vitest";
import {
  DailyQuotaLedger,
  DEFAULT_PROJECT_BACKUP_DAILY_CAP_BYTES,
  parseDailyCapBytes,
  ProjectBackupDailyQuota,
  secondsUntilNextUtcMidnight,
  utcDay,
  type QuotaStorage
} from "./backupDailyQuota";

/** Async in-memory storage that yields between get and put, like a real backend. */
function memoryQuotaStorage(): QuotaStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
  return {
    values,
    async get<T>(key: string) {
      await tick();
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      await tick();
      values.set(key, structuredClone(value));
    }
  };
}

function clock(iso: string) {
  let now = Date.parse(iso);
  return { now: () => now, set: (next: string) => { now = Date.parse(next); } };
}

describe("daily backup cap configuration", () => {
  test("defaults to 10 GiB when the Wrangler var is unset", () => {
    expect(DEFAULT_PROJECT_BACKUP_DAILY_CAP_BYTES).toBe(10_737_418_240);
    expect(parseDailyCapBytes(undefined)).toEqual({ ok: true, capBytes: 10_737_418_240 });
  });

  test.each([["10737418240", 10_737_418_240], [" 1024 ", 1024], [2048, 2048]])("accepts %j", (raw, capBytes) => {
    expect(parseDailyCapBytes(raw)).toEqual({ ok: true, capBytes });
  });

  test.each(["", "0", "-5", "10GiB", "1e10", "1.5", "0x10", "99999999999999999999", 0, 1.5, Number.NaN, true, {}])(
    "rejects misconfigured value %j instead of guessing",
    (raw) => {
      const parsed = parseDailyCapBytes(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/PROJECT_BACKUP_DAILY_CAP_BYTES/u);
    }
  );

  test("Retry-After counts down to the next UTC midnight", () => {
    expect(secondsUntilNextUtcMidnight(Date.parse("2026-11-13T23:59:30.000Z"))).toBe(30);
    expect(secondsUntilNextUtcMidnight(Date.parse("2026-11-13T23:59:59.900Z"))).toBe(1);
    expect(secondsUntilNextUtcMidnight(Date.parse("2026-11-14T00:00:00.000Z"))).toBe(86_400);
    expect(utcDay(Date.parse("2026-11-13T23:59:59.999Z"))).toBe("2026-11-13");
  });
});

describe("daily backup quota ledger", () => {
  test("accepts uploads under the cap and refuses one that would exceed it", async () => {
    const time = clock("2026-11-13T12:00:00.000Z");
    const ledger = new DailyQuotaLedger(memoryQuotaStorage(), time.now);

    const first = await ledger.reserve(60, 100);
    expect(first.ok).toBe(true);
    if (first.ok) await ledger.commit(first.reservationId, 60);
    expect((await ledger.reserve(40, 100)).ok).toBe(true);

    const refused = await ledger.reserve(1, 100);
    expect(refused).toEqual({
      ok: false,
      day: "2026-11-13",
      usedBytes: 100,
      capBytes: 100,
      retryAfterSeconds: 12 * 3600,
      resetsAt: "2026-11-14T00:00:00.000Z"
    });
  });

  test("concurrent reservations never exceed the cap", async () => {
    const storage = memoryQuotaStorage();
    const ledger = new DailyQuotaLedger(storage, clock("2026-11-13T08:00:00.000Z").now);

    const results = await Promise.all(Array.from({ length: 25 }, () => ledger.reserve(30, 200)));

    expect(results.filter((result) => result.ok)).toHaveLength(6);
    expect(await ledger.usage()).toMatchObject({ reservedBytes: 180, committedBytes: 0 });
  });

  test("released reservations return their bytes; commit records the stored size", async () => {
    const ledger = new DailyQuotaLedger(memoryQuotaStorage(), clock("2026-11-13T08:00:00.000Z").now);
    const failed = await ledger.reserve(100, 100);
    expect(failed.ok).toBe(true);
    expect((await ledger.reserve(1, 100)).ok).toBe(false);

    if (failed.ok) expect(await ledger.release(failed.reservationId)).toEqual({ ok: true });
    const retried = await ledger.reserve(100, 100);
    expect(retried.ok).toBe(true);
    if (retried.ok) await ledger.commit(retried.reservationId, 70);

    expect(await ledger.usage()).toEqual({ day: "2026-11-13", committedBytes: 70, reservedBytes: 0 });
    // Releasing twice or an unknown id is a no-op.
    if (failed.ok) expect(await ledger.release(failed.reservationId)).toEqual({ ok: false });
  });

  test("resets at UTC midnight and drops the previous day's reservations", async () => {
    const time = clock("2026-11-13T23:59:00.000Z");
    const storage = memoryQuotaStorage();
    const ledger = new DailyQuotaLedger(storage, time.now);
    const pending = await ledger.reserve(100, 100);
    expect((await ledger.reserve(1, 100)).ok).toBe(false);

    time.set("2026-11-14T00:00:01.000Z");
    expect((await ledger.reserve(100, 100)).ok).toBe(true);
    // A late commit from yesterday's reservation is not charged to today.
    if (pending.ok) expect(await ledger.commit(pending.reservationId, 100)).toEqual({ ok: false });
    expect(await ledger.usage()).toEqual({ day: "2026-11-14", committedBytes: 0, reservedBytes: 100 });
  });

  test("persists across Durable Object restarts", async () => {
    const storage = memoryQuotaStorage();
    const time = clock("2026-11-13T10:00:00.000Z");
    const before = new DailyQuotaLedger(storage, time.now);
    const reservation = await before.reserve(80, 100);
    if (reservation.ok) await before.commit(reservation.reservationId, 80);

    const after = new DailyQuotaLedger(storage, time.now);
    expect((await after.reserve(21, 100)).ok).toBe(false);
    expect((await after.reserve(20, 100)).ok).toBe(true);
  });

  test("rejects non-integer reservation sizes and caps", async () => {
    const ledger = new DailyQuotaLedger(memoryQuotaStorage());
    await expect(ledger.reserve(0, 100)).rejects.toThrow(RangeError);
    await expect(ledger.reserve(1.5, 100)).rejects.toThrow(RangeError);
    await expect(ledger.reserve(10, Number.NaN)).rejects.toThrow(RangeError);
  });
});

describe("ProjectBackupDailyQuota Durable Object", () => {
  function createObject() {
    return new ProjectBackupDailyQuota({ storage: memoryQuotaStorage() } as unknown as DurableObjectState, {});
  }
  const post = (object: ProjectBackupDailyQuota, path: string, body: unknown) =>
    object.fetch(new Request(`https://quota.internal${path}`, { method: "POST", body: JSON.stringify(body) }));

  test("reserves, refuses, and releases over its fetch protocol", async () => {
    const object = createObject();
    const reserved = await (await post(object, "/reserve", { bytes: 50, capBytes: 50 })).json() as { ok: boolean; reservationId: string };
    expect(reserved.ok).toBe(true);
    expect(await (await post(object, "/reserve", { bytes: 1, capBytes: 50 })).json()).toMatchObject({ ok: false, usedBytes: 50 });
    expect(await (await post(object, "/release", { reservationId: reserved.reservationId })).json()).toEqual({ ok: true });
    expect(await (await post(object, "/reserve", { bytes: 50, capBytes: 50 })).json()).toMatchObject({ ok: true });
  });

  test("rejects malformed quota requests", async () => {
    const object = createObject();
    expect((await post(object, "/reserve", { bytes: -1, capBytes: 50 })).status).toBe(400);
    expect((await post(object, "/reserve", { bytes: 1, capBytes: "50" })).status).toBe(400);
    expect((await post(object, "/commit", { reservationId: 7 })).status).toBe(400);
    expect((await post(object, "/unknown", { reservationId: "x" })).status).toBe(404);
    expect((await post(object, "/reserve", [1, 2])).status).toBe(400);
    expect((await object.fetch(new Request("https://quota.internal/reserve"))).status).toBe(405);
  });
});
