import { describe, expect, test, vi } from "vitest";
import type { AutosavedWorkspace } from "./appPersistence";
import { dailyCapReachedMessage, readCloudBackupDescriptor, readCloudBackupPreference, requestPersistentBrowserStorage, restoreEncryptedCloudBackup, saveEncryptedCloudBackup, writeCloudBackupPreference } from "./cloudBackup";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("encrypted cloud backup", () => {
  test("uploads ciphertext only and restores it with the locally retained key", async () => {
    const storage = memoryStorage();
    const snapshot = { version: 1, savedAt: "2026-07-12T12:00:00.000Z" } as AutosavedWorkspace;
    let uploaded: Blob | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        uploaded = init.body as Blob;
        expect(await uploaded.text()).not.toContain(snapshot.savedAt);
        return Response.json({ expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }, { status: 201 });
      }
      return new Response(uploaded, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });

    const descriptor = await saveEncryptedCloudBackup(snapshot, "run-local-1", { fetch: fetchMock as typeof fetch, storage });
    const restored = await restoreEncryptedCloudBackup("run-local-1", { fetch: fetchMock as typeof fetch, storage });

    expect(descriptor.token).not.toBe(descriptor.encryptionKey);
    expect(readCloudBackupDescriptor(storage)).toEqual(descriptor);
    expect(restored).toEqual(snapshot);
  });

  test("does not restore a backup for a different run", async () => {    const storage = memoryStorage();
    await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage,
      fetch: vi.fn(async () => Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 })) as typeof fetch
    });
    const fetchMock = vi.fn();

    await expect(restoreEncryptedCloudBackup("run-local-2", { storage, fetch: fetchMock as typeof fetch })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("deletes the server object when the local recovery key cannot be saved", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 });
    });
    const failingStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); }
    };

    await expect(saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage: failingStorage,
      fetch: fetchMock as typeof fetch
    })).rejects.toThrow(/local recovery key could not be saved/);

    const deletes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "DELETE");
    expect(deletes).toHaveLength(1);
  });

  test("deletes the previous backup only after the replacement is stored", async () => {
    const storage = memoryStorage();
    const putOk = () => Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 });
    const first = await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage,
      fetch: vi.fn(async () => putOk()) as typeof fetch
    });

    const calls: Array<{ url: string; method: string; token: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, token: new Headers(init?.headers).get("x-opencae-backup-token") });
      return method === "DELETE" ? new Response(null, { status: 204 }) : putOk();
    });
    const second = await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-2", { storage, fetch: fetchMock as typeof fetch });
    await vi.waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));

    expect(calls.map((call) => call.method)).toEqual(["PUT", "DELETE"]);
    expect(calls[1]).toEqual({ url: `/api/project-backups/${first.backupId}`, method: "DELETE", token: first.token });
    expect(readCloudBackupDescriptor(storage)).toEqual(second);
  });

  test("keeps the new backup when deleting the previous one fails", async () => {
    const storage = memoryStorage();
    const putOk = () => Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 });
    await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage,
      fetch: vi.fn(async () => putOk()) as typeof fetch
    });

    for (const failure of [
      async () => { throw new TypeError("network down"); },
      async () => Response.json({ error: "boom" }, { status: 500 })
    ]) {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "DELETE" ? failure() : putOk());
      const saved = await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-2", { storage, fetch: fetchMock as typeof fetch });
      await vi.waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
      expect(readCloudBackupDescriptor(storage)).toEqual(saved);
    }
  });

  test("leaves the previous backup alone when the replacement upload fails", async () => {
    const storage = memoryStorage();
    const first = await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage,
      fetch: vi.fn(async () => Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 })) as typeof fetch
    });
    const fetchMock = vi.fn(async () => Response.json({ error: "Cloud backup rate limit exceeded." }, { status: 429 }));

    await expect(saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-2", { storage, fetch: fetchMock as typeof fetch }))
      .rejects.toThrow(/rate limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readCloudBackupDescriptor(storage)).toEqual(first);
  });

  test("explains the shared daily cap and keeps the local project and previous backup", async () => {
    const storage = memoryStorage();
    const first = await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage,
      fetch: vi.fn(async () => Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 })) as typeof fetch
    });
    const fetchMock = vi.fn(async () => Response.json(
      { error: "The shared daily limit for encrypted cloud recovery backups has been reached.", code: "backup_daily_cap_reached", retryAfterSeconds: 4 * 3600 + 5 },
      { status: 507, headers: { "retry-after": String(4 * 3600 + 5) } }
    ));

    const failure = saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-2", { storage, fetch: fetchMock as typeof fetch });

    await expect(failure).rejects.toThrow(
      "Encrypted cloud recovery has reached today's shared storage limit, so this backup was not uploaded. Your project is still open in this browser. Cloud recovery reopens after 00:00 UTC (in about 5 hours)."
    );
    // Only the refused PUT: no retry loop and no deletion of the previous backup.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readCloudBackupDescriptor(storage)).toEqual(first);
  });

  test.each([
    ["3600", "after 00:00 UTC (in about 1 hour)."],
    ["59", "after 00:00 UTC (in about 1 hour)."],
    [null, "after 00:00 UTC."],
    ["soon", "after 00:00 UTC."]
  ])("daily cap message tolerates Retry-After %s", (retryAfter, ending) => {
    const message = dailyCapReachedMessage(retryAfter);
    expect(message.endsWith(ending), message).toBe(true);
  });

  test("requests persistent local storage when the browser supports it", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist } });

    await expect(requestPersistentBrowserStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  test("remembers a validated recovery preference in browser storage", () => {
    const storage = memoryStorage();

    expect(readCloudBackupPreference(storage)).toBeNull();
    expect(writeCloudBackupPreference("local", storage)).toBe(true);
    expect(readCloudBackupPreference(storage)).toBe("local");
    expect(writeCloudBackupPreference("cloud", storage)).toBe(true);
    expect(readCloudBackupPreference(storage)).toBe("cloud");
  });

  test("fails closed when the recovery preference cannot be stored", () => {
    const storage = {
      getItem: () => "unexpected",
      setItem: () => { throw new Error("storage denied"); }
    };

    expect(readCloudBackupPreference(storage)).toBeNull();
    expect(writeCloudBackupPreference("cloud", storage)).toBe(false);
  });
});
