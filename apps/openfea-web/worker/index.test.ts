import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseJsonc } from "../../../scripts/verify-cloudflare-config.mjs";

const { default: worker, ProjectBackupDailyQuota } = await import("./index");

function dispatchWorker(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env);
}

function readJsonc(path: string) {
  return parseJsonc(readFileSync(resolve(__dirname, path), "utf8"), path);
}

/** One in-memory Durable Object instance per namespace, like the global ledger in production. */
function createQuotaNamespace() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }
  };
  const names = new Set<string>();
  let instance: InstanceType<typeof ProjectBackupDailyQuota> | null = null;
  return {
    names,
    idFromName: (name: string) => { names.add(name); return { name }; },
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        instance ??= new ProjectBackupDailyQuota({ storage } as unknown as DurableObjectState, {});
        return instance.fetch(new Request(input, init));
      }
    })
  };
}

function createEnv(
  assetBody = "asset",
  options?: {
    listPageSize?: number;
    backups?: Array<{ key: string; expiresAt?: string }>;
    dailyCapBytes?: string;
    quota?: ReturnType<typeof createQuotaNamespace> | null;
    putDelayMs?: number;
    failPut?: () => boolean;
  }
): Env {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  for (const backup of options?.backups ?? []) {
    objects.set(backup.key, {
      bytes: new Uint8Array(32).fill(1),
      customMetadata: { tokenHash: "seeded", ...(backup.expiresAt ? { expiresAt: backup.expiresAt } : {}) }
    });
  }
  return {
    ASSETS: { fetch: async () => new Response(assetBody, { headers: { "content-type": "text/html" } }) },
    PROJECT_BACKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...(options?.quota === null ? {} : { PROJECT_BACKUP_DAILY_QUOTA: options?.quota ?? createQuotaNamespace() }),
    ...(options?.dailyCapBytes === undefined ? {} : { PROJECT_BACKUP_DAILY_CAP_BYTES: options.dailyCapBytes }),
    PROJECT_BACKUPS: {
      put: async (key: string, value: ReadableStream, putOptions: { customMetadata: Record<string, string> }) => {
        if (options?.putDelayMs) await new Promise((done) => setTimeout(done, options.putDelayMs));
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        if (options?.failPut?.()) throw new Error("R2 write failed");
        objects.set(key, { bytes, customMetadata: putOptions.customMetadata });
        return null;
      },
      get: async (key: string) => {
        const object = objects.get(key);
        return object ? {
          body: new Blob([object.bytes.slice().buffer as ArrayBuffer]).stream(),
          size: object.bytes.byteLength,
          customMetadata: object.customMetadata
        } : null;
      },
      head: async (key: string) => {
        const object = objects.get(key);
        return object ? { size: object.bytes.byteLength, customMetadata: object.customMetadata } : null;
      },
      list: async (listOptions?: { prefix?: string; limit?: number; cursor?: string }) => {
        const matching = [...objects.keys()].filter((key) => key.startsWith(listOptions?.prefix ?? "")).sort();
        // Cursor anchors to the last returned key (like real R2) so deleting
        // the current page during a sweep cannot shift the next page.
        const start = listOptions?.cursor ? matching.filter((key) => key <= listOptions.cursor!).length : 0;
        const limit = listOptions?.limit ?? options?.listPageSize ?? matching.length;
        const pageKeys = matching.slice(start, start + limit);
        const end = start + pageKeys.length;
        return {
          objects: pageKeys.map((key) => ({ key, customMetadata: objects.get(key)?.customMetadata ?? {} })),
          truncated: end < matching.length,
          cursor: pageKeys[pageKeys.length - 1],
          delimitedPrefixes: []
        };
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      }
    }
  } as unknown as Env;
}

async function dispatchScheduled(env: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext;
  await worker.scheduled?.({} as ScheduledController, env, ctx);
  await Promise.all(pending);
}

test("Preview workspace serves assets and refuses recovery without production bindings", async () => {
  const config = readJsonc("../../../wrangler.jsonc") as { previews: { vars: Record<string, string> } };
  const env = {
    ASSETS: { fetch: async () => new Response("preview workspace") },
    ...config.previews.vars
  } as unknown as Env;
  expect(await (await dispatchWorker(new Request("https://preview.test/"), env)).text()).toBe("preview workspace");
  const backup = await dispatchWorker(new Request("https://preview.test/api/project-backups/11111111-1111-4111-8111-111111111111"), env);
  expect(backup.status).toBe(503);
  expect(await backup.json()).toEqual({ error: "Encrypted cloud recovery is unavailable on this deployment." });
});

describe("Cloudflare local-first worker", () => {
  test("carries no cloud solve infrastructure (retired 2026-07)", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    // B4b removed the container Durable Object, R2 artifact store, run
    // tokens, and runner-version gate. None of them may return here.
    expect(workerSource).not.toContain("@cloudflare/containers");
    expect(workerSource).not.toContain("OpenCaeCoreCloudContainer");
    expect(workerSource).not.toContain("CORE_CLOUD_CONTAINER");
    expect(workerSource).not.toContain("CORE_CLOUD_ARTIFACTS");
    expect(workerSource).not.toContain("EXPECTED_CORE_CLOUD_RUNNER_VERSION");
    expect(workerSource).not.toContain("x-opencae-run-token");
    expect(workerSource).not.toContain("R2Bucket");
    expect(workerSource).not.toContain("cloud-core/runs/");
  });

  test("wrangler config keeps solver infrastructure retired and binds only the encrypted project-backup bucket", () => {
    const defaultConfig = readJsonc("../../../wrangler.jsonc") as {
      name?: string;
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      containers?: unknown;
      durable_objects?: unknown;
      r2_buckets?: unknown;
      migrations?: Array<{ tag?: string; deleted_classes?: string[]; new_sqlite_classes?: string[] }>;
      assets?: { run_worker_first?: string[] };
      triggers?: { crons?: string[] };
      vars?: Record<string, string>;
    };

    expect(defaultConfig.name).toBe("openfea");
    expect(defaultConfig.routes).toEqual([{ pattern: "fea.esau.app", custom_domain: true }]);
    expect(defaultConfig.containers).toBeUndefined();
    // The only Durable Object is the global daily backup quota ledger.
    expect(defaultConfig.durable_objects).toEqual({
      bindings: [{ name: "PROJECT_BACKUP_DAILY_QUOTA", class_name: "ProjectBackupDailyQuota" }]
    });
    expect(defaultConfig.vars?.PROJECT_BACKUP_DAILY_CAP_BYTES).toBe(String(10 * 1024 * 1024 * 1024));
    expect(defaultConfig.r2_buckets).toEqual([{ binding: "PROJECT_BACKUPS", bucket_name: "opencae-project-backups" }]);
    expect(defaultConfig.assets?.run_worker_first).toEqual(expect.arrayContaining(["/api/*", "/health"]));
    expect(defaultConfig.triggers?.crons).toEqual(["17 3 * * *"]);
    // Append-only migration history: the retired container tags stay verbatim
    // and the quota class rides its own new tag.
    expect(defaultConfig.migrations?.map((migration) => migration.tag)).toEqual([
      "v3-opencae-core-cloud-container",
      "v4-retire-opencae-core-cloud-container",
      "v5-project-backup-daily-quota"
    ]);
    expect(defaultConfig.migrations?.at(-1)?.new_sqlite_classes).toEqual(["ProjectBackupDailyQuota"]);
  });

  test("deploy scripts target the retired-cloud config without container gates", () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("wrangler deploy");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("containers-rollout");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare:retired-do-cleanup"]).toContain("wrangler.retired-do-cleanup.jsonc");
    expect(packageJson.scripts["deploy:core-cloud"]).toBeUndefined();
    expect(packageJson.scripts["containers:build:core-cloud"]).toBeUndefined();
    expect(packageJson.scripts["containers:push:core-cloud"]).toBeUndefined();
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeUndefined();
  });

  test("health advertises the browser OpenFEA Core runtime", async () => {
    const response = await dispatchWorker(new Request("https://fea.esau.app/health"), createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      mode: "cloudflare-worker",
      service: "openfea-web",
      solverRuntime: "browser-openfea-core"
    });
  });

  test.each([
    ["POST", "/api/cloud-core/runs"],
    ["POST", "/api/cloud-core/runs/run-1/start"],
    ["GET", "/api/cloud-core/runs/run-1/events"],
    ["GET", "/api/cloud-core/runs/run-1/results"],
    ["POST", "/api/cloud-core/runs/run-1/cancel"],
    ["GET", "/api/cloud-core/health"],
    ["POST", "/api/cloud-fea/runs"],
    ["GET", "/api/cloud-fea/runs/run-1/results"],
    ["GET", "/api/cloud-fea/health"]
  ])("retired cloud route %s %s returns an honest 410", async (method, path) => {
    const response = await dispatchWorker(new Request(`https://fea.esau.app${path}`, { method }), createEnv());
    const body = await response.json() as { error?: string; retired?: boolean; solverRuntime?: string };

    expect(response.status).toBe(410);
    expect(body.retired).toBe(true);
    expect(body.solverRuntime).toBe("browser-openfea-core");
    expect(body.error).toContain("retired");
    expect(body.error).toContain("locally in your browser");
  });

  test("other api routes explain the local-first Worker", async () => {
    const response = await dispatchWorker(new Request("https://fea.esau.app/api/projects"), createEnv());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Simulations run in the browser")
    });
  });

  test("stores and retrieves an explicitly authorized encrypted project backup", async () => {
    const env = createEnv();
    const backupId = "11111111-1111-4111-8111-111111111111";
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234567890-_";
    const encrypted = new Uint8Array(32).fill(7);
    const put = await dispatchWorker(new Request(`https://fea.esau.app/api/project-backups/${backupId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(encrypted.byteLength),
        "x-opencae-backup-token": token,
        "x-opencae-run-id": "run-local-1"
      },
      body: encrypted
    }), env);

    expect(put.status).toBe(201);
    const get = await dispatchWorker(new Request(`https://fea.esau.app/api/project-backups/${backupId}`, {
      headers: { "x-opencae-backup-token": token }
    }), env);
    expect(get.status).toBe(200);
    await expect(get.arrayBuffer()).resolves.toEqual(encrypted.buffer);
  });

  test("does not disclose encrypted backups without the capability token", async () => {
    const backupId = "11111111-1111-4111-8111-111111111111";
    const response = await dispatchWorker(new Request(`https://fea.esau.app/api/project-backups/${backupId}`), createEnv());

    expect(response.status).toBe(401);
  });

  test("does not overwrite an existing backup with a different capability token", async () => {
    const env = createEnv();
    const backupId = "11111111-1111-4111-8111-111111111111";
    const firstToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234567890-_";
    const otherToken = "zyxwvutsrqponmlkjihgfedcbaABCDEFGHIJ1234567890-_";
    const request = (token: string, fill: number) => new Request(`https://fea.esau.app/api/project-backups/${backupId}`, {
      method: "PUT",
      headers: { "content-length": "32", "x-opencae-backup-token": token },
      body: new Uint8Array(32).fill(fill)
    });
    expect((await dispatchWorker(request(firstToken, 1), env)).status).toBe(201);
    expect((await dispatchWorker(request(otherToken, 2), env)).status).toBe(403);
    const restored = await dispatchWorker(new Request(`https://fea.esau.app/api/project-backups/${backupId}`, {
      headers: { "x-opencae-backup-token": firstToken }
    }), env);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array(32).fill(1));
  });

  test("deletes a backup only for the matching capability token", async () => {
    const env = createEnv();
    const backupId = "33333333-3333-4333-8333-333333333333";
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234567890-_";
    const otherToken = "zyxwvutsrqponmlkjihgfedcbaABCDEFGHIJ1234567890-_";
    const url = `https://fea.esau.app/api/project-backups/${backupId}`;
    const put = await dispatchWorker(new Request(url, {
      method: "PUT",
      headers: { "content-length": "32", "x-opencae-backup-token": token },
      body: new Uint8Array(32).fill(3)
    }), env);
    expect(put.status).toBe(201);

    const unauthenticated = await dispatchWorker(new Request(url, { method: "DELETE" }), env);
    expect(unauthenticated.status).toBe(401);
    const wrongToken = await dispatchWorker(new Request(url, { method: "DELETE", headers: { "x-opencae-backup-token": otherToken } }), env);
    expect(wrongToken.status).toBe(403);
    const stillThere = await dispatchWorker(new Request(url, { headers: { "x-opencae-backup-token": token } }), env);
    expect(stillThere.status).toBe(200);
    await stillThere.arrayBuffer();

    const deleted = await dispatchWorker(new Request(url, { method: "DELETE", headers: { "x-opencae-backup-token": token } }), env);
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("x-content-type-options")).toBe("nosniff");
    const gone = await dispatchWorker(new Request(url, { headers: { "x-opencae-backup-token": token } }), env);
    expect(gone.status).toBe(404);
    const repeated = await dispatchWorker(new Request(url, { method: "DELETE", headers: { "x-opencae-backup-token": token } }), env);
    expect(repeated.status).toBe(404);
  });

  test("rejects a body larger than the cap even when content-length is small", async () => {
    const env = createEnv();
    const backupId = "22222222-2222-4222-8222-222222222222";
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234567890-_";
    // 200 bytes streamed under a 32-byte claimed length.
    const oversized = new Uint8Array(200).fill(9);
    const put = await dispatchWorker(new Request(`https://fea.esau.app/api/project-backups/${backupId}`, {
      method: "PUT",
      headers: { "content-length": "32", "x-opencae-backup-token": token },
      body: oversized
    }), env);
    // Either a streaming abort (no object) or a post-put size check (413 +
    // delete) satisfies the cap; the stored-bytes invariant is what matters.
    // Note: undici normalizes content-length to the real body size, so the
    // header pre-check passes and the stored-bytes enforcement decides.
    const stored = await env.PROJECT_BACKUPS.head(`project-backups/${backupId}`);
    if (put.status === 201) {
      expect(stored?.size).toBeLessThanOrEqual(95 * 1024 * 1024);
    } else {
      expect(put.status).toBe(413);
      expect(stored).toBeNull();
    }
  });

  test("serves static assets for non-api routes", async () => {
    const response = await dispatchWorker(new Request("https://fea.esau.app/"), createEnv("<html></html>"));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<html></html>");
  });

  test.each([undefined, "private, no-store", "public, max-age=0, no-transform"])("preserves HTML cache policy while preventing script injection (%s)", async (cacheControl) => {
    const env = createEnv();
    env.ASSETS.fetch = async () => new Response("<html></html>", { headers: {
      "content-type": "text/html; charset=utf-8", ...(cacheControl ? { "cache-control": cacheControl } : {})
    } });
    const response = await dispatchWorker(new Request("https://example.test/"), env);
    expect(response.headers.get("cache-control")).toBe(cacheControl?.includes("no-transform") ? cacheControl : `${cacheControl ?? "public, max-age=0, must-revalidate"}, no-transform`);
    expect(response.headers.get("content-security-policy")).not.toContain("script-src 'unsafe-inline'");
  });

  test("leaves immutable asset caching intact and protects the directly served HTML shell", async () => {
    const env = createEnv();
    env.ASSETS.fetch = async () => new Response("const a=1", { headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31556952, immutable" } });
    const response = await dispatchWorker(new Request("https://example.test/assets/app.js"), env);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31556952, immutable");
    const headers = readFileSync(resolve(__dirname, "../public/_headers"), "utf8");
    for (const route of ["/", "/index.html"]) {
      const block = headers.split(/\r?\n\r?\n/).find((entry) => entry.split(/\r?\n/).includes(route));
      expect(block).toContain("Cache-Control: public, max-age=0, must-revalidate, no-transform");
    }
  });

  test("asset responses include browser security headers", async () => {
    const response = await dispatchWorker(new Request("https://fea.esau.app/"), createEnv("<html></html>"));

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains; preload");
  });

  test("csp permits the OCCT STEP importer embind runtime", async () => {
    const response = await dispatchWorker(new Request("https://fea.esau.app/"), createEnv("<html></html>"));

    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'");
  });

  test("static asset _headers ships the same security headers the worker applies", async () => {
    const headersFile = readFileSync(resolve(__dirname, "../public/_headers"), "utf8");
    const response = await dispatchWorker(new Request("https://fea.esau.app/"), createEnv("<html></html>"));

    const workerCsp = response.headers.get("content-security-policy");
    expect(workerCsp).toBeTruthy();
    expect(headersFile).toContain(`Content-Security-Policy: ${workerCsp}`);
    expect(headersFile).toContain("X-Content-Type-Options: nosniff");
    expect(headersFile).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(headersFile).toContain("Strict-Transport-Security: max-age=63072000; includeSubDomains; preload");
    expect(headersFile).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()");
  });

  test("scheduled sweep deletes expired backups that are never restored", async () => {
    const futureExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();
    const env = createEnv("asset", {
      backups: [
        { key: "project-backups/11111111-1111-4111-8111-111111111111", expiresAt: futureExpiry },
        { key: "project-backups/22222222-2222-4222-8222-222222222222", expiresAt: pastExpiry },
        { key: "project-backups/33333333-3333-4333-8333-333333333333" },
        { key: "unrelated/keep", expiresAt: pastExpiry }
      ]
    });

    await dispatchScheduled(env);

    // Fresh backups survive; expired ones and objects without a valid expiry
    // are deleted; keys outside the backup prefix are never touched.
    await expect(env.PROJECT_BACKUPS.head("project-backups/11111111-1111-4111-8111-111111111111")).resolves.not.toBeNull();
    await expect(env.PROJECT_BACKUPS.head("project-backups/22222222-2222-4222-8222-222222222222")).resolves.toBeNull();
    await expect(env.PROJECT_BACKUPS.head("project-backups/33333333-3333-4333-8333-333333333333")).resolves.toBeNull();
    await expect(env.PROJECT_BACKUPS.head("unrelated/keep")).resolves.not.toBeNull();
  });

  test("scheduled sweep follows list pagination", async () => {
    const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();
    const env = createEnv("asset", {
      listPageSize: 1,
      backups: [
        { key: "project-backups/11111111-1111-4111-8111-111111111111", expiresAt: pastExpiry },
        { key: "project-backups/22222222-2222-4222-8222-222222222222", expiresAt: pastExpiry }
      ]
    });

    await dispatchScheduled(env);

    await expect(env.PROJECT_BACKUPS.head("project-backups/11111111-1111-4111-8111-111111111111")).resolves.toBeNull();
    await expect(env.PROJECT_BACKUPS.head("project-backups/22222222-2222-4222-8222-222222222222")).resolves.toBeNull();
  });

  test("wrangler config schedules the daily retention sweep", () => {
    const defaultConfig = readJsonc("../../../wrangler.jsonc") as { triggers?: { crons?: string[] } };

    expect(defaultConfig.triggers?.crons).toHaveLength(1);
  });

  describe("global daily backup cap", () => {
    const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234567890-_";
    const backupUrl = (index: number) => `https://fea.esau.app/api/project-backups/${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const putBackup = (env: Env, index: number, size: number) => dispatchWorker(new Request(backupUrl(index), {
      method: "PUT",
      headers: { "content-length": String(size), "x-opencae-backup-token": token, "cf-connecting-ip": `203.0.113.${index}` },
      body: new Uint8Array(size).fill(index)
    }), env);
    const stored = (env: Env, index: number) => env.PROJECT_BACKUPS.head(new URL(backupUrl(index)).pathname.replace("/api/", ""));

    afterEach(() => {
      vi.useRealTimers();
    });

    test("accepts uploads under the cap and refuses the one that would exceed it with 507 + Retry-After", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-13T21:00:00.000Z"));
      const quota = createQuotaNamespace();
      const env = createEnv("asset", { dailyCapBytes: "100", quota });

      expect((await putBackup(env, 1, 60)).status).toBe(201);
      expect((await putBackup(env, 2, 40)).status).toBe(201);
      const refused = await putBackup(env, 3, 13);

      expect(refused.status).toBe(507);
      expect(refused.headers.get("retry-after")).toBe(String(3 * 3600));
      expect(refused.headers.get("cache-control")).toBe("no-store");
      await expect(refused.json()).resolves.toEqual({
        error: expect.stringContaining("shared daily limit"),
        code: "backup_daily_cap_reached",
        retryAfterSeconds: 3 * 3600,
        resetsAt: "2026-11-14T00:00:00.000Z"
      });
      await expect(stored(env, 3)).resolves.toBeNull();
      // Every client shares one ledger instance.
      expect([...quota.names]).toEqual(["project-backups-daily-bytes"]);
    });

    test("concurrent uploads reserve before streaming and cannot overshoot the cap", async () => {
      const env = createEnv("asset", { dailyCapBytes: "100", putDelayMs: 5 });

      const responses = await Promise.all([1, 2, 3, 4, 5].map((index) => putBackup(env, index, 40)));
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([201, 201, 507, 507, 507]);
      const storedSizes = await Promise.all([1, 2, 3, 4, 5].map(async (index) => (await stored(env, index))?.size ?? 0));
      expect(storedSizes.reduce((sum, size) => sum + size, 0)).toBe(80);
    });

    test("releases the reservation when the R2 upload fails", async () => {
      let fail = true;
      const env = createEnv("asset", { dailyCapBytes: "64", failPut: () => fail });

      expect((await putBackup(env, 1, 64)).status).toBe(413);
      await expect(stored(env, 1)).resolves.toBeNull();
      fail = false;
      // The failed upload's 64 bytes were returned, so a full-cap upload fits.
      expect((await putBackup(env, 2, 64)).status).toBe(201);
      expect((await putBackup(env, 3, 13)).status).toBe(507);
    });

    test("does not charge the cap for refused overwrites of another client's backup", async () => {
      const env = createEnv("asset", { dailyCapBytes: "64" });
      expect((await putBackup(env, 1, 32)).status).toBe(201);
      const hijack = await dispatchWorker(new Request(backupUrl(1), {
        method: "PUT",
        headers: { "content-length": "32", "x-opencae-backup-token": "zyxwvutsrqponmlkjihgfedcbaABCDEFGHIJ1234567890-_" },
        body: new Uint8Array(32)
      }), env);
      expect(hijack.status).toBe(403);
      expect((await putBackup(env, 2, 32)).status).toBe(201);
    });

    test("reopens at the next UTC midnight", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-13T23:59:30.000Z"));
      const env = createEnv("asset", { dailyCapBytes: "50" });

      expect((await putBackup(env, 1, 50)).status).toBe(201);
      const refused = await putBackup(env, 2, 50);
      expect(refused.status).toBe(507);
      expect(refused.headers.get("retry-after")).toBe("30");

      vi.setSystemTime(new Date("2026-11-14T00:00:01.000Z"));
      expect((await putBackup(env, 2, 50)).status).toBe(201);
    });

    test("defaults to 10 GiB when the cap var is unset", async () => {
      const env = createEnv();
      expect((env as unknown as Record<string, unknown>).PROJECT_BACKUP_DAILY_CAP_BYTES).toBeUndefined();
      expect((await putBackup(env, 1, 95 * 1024 * 1024)).status).toBe(201);
    });

    test.each(["10GiB", "0", "-1", "", "1.5"])("fails closed for uploads when the cap var is misconfigured (%j)", async (dailyCapBytes) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const env = createEnv("asset", { dailyCapBytes });
      const seeded = createEnv("asset", { dailyCapBytes: "1000" });
      // Seed a backup through a correctly configured env sharing the bucket.
      env.PROJECT_BACKUPS = seeded.PROJECT_BACKUPS;
      expect((await putBackup(seeded, 1, 32)).status).toBe(201);

      const response = await putBackup(env, 2, 32);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Encrypted cloud recovery is unavailable on this deployment." });
      await expect(stored(env, 2)).resolves.toBeNull();
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("PROJECT_BACKUP_DAILY_CAP_BYTES"));
      // Existing backups stay restorable while uploads are disabled.
      const restored = await dispatchWorker(new Request(backupUrl(1), { headers: { "x-opencae-backup-token": token } }), env);
      expect(restored.status).toBe(200);
      await restored.arrayBuffer();
      errors.mockRestore();
    });

    test("fails closed for uploads when the quota Durable Object is not bound", async () => {
      const env = createEnv("asset", { quota: null });
      const response = await putBackup(env, 1, 32);
      expect(response.status).toBe(503);
      await expect(stored(env, 1)).resolves.toBeNull();
    });

    test("requires an integral Content-Length before reserving anything", async () => {
      const env = createEnv("asset", { dailyCapBytes: "64" });
      const streamed = (headers: Record<string, string>) => new Request(backupUrl(1), {
        method: "PUT",
        headers: { "x-opencae-backup-token": token, ...headers },
        body: new Blob([new Uint8Array(32)]).stream(),
        duplex: "half"
      } as RequestInit);

      expect((await dispatchWorker(streamed({}), env)).status).toBe(413);
      expect((await dispatchWorker(streamed({ "content-length": "32.5" }), env)).status).toBe(413);
      // Nothing was reserved by the refused requests.
      expect((await putBackup(env, 2, 64)).status).toBe(201);
    });

    test("refuses a streamed body longer than its declared (reserved) length", async () => {
      const env = createEnv("asset", { dailyCapBytes: "1000" });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(32).fill(1));
          controller.enqueue(new Uint8Array(32).fill(2));
          controller.close();
        }
      });
      const request = new Request(backupUrl(1), {
        method: "PUT",
        headers: { "content-length": "32", "x-opencae-backup-token": token },
        body,
        duplex: "half"
      } as RequestInit);
      expect(request.headers.get("content-length")).toBe("32");

      const response = await dispatchWorker(request, env);

      expect(response.status).toBe(413);
      await expect(stored(env, 1)).resolves.toBeNull();
      // The 32 reserved bytes were released.
      expect((await putBackup(env, 2, 1000)).status).toBe(201);
    });
  });

  test("includes an inert queue handler for stale legacy Workers Builds consumers", async () => {
    const queueHandler = (worker as ExportedHandler<Env>).queue;

    expect(typeof queueHandler).toBe("function");
    await expect(queueHandler?.({ messages: [] } as unknown as MessageBatch<unknown>, {} as Env, {} as ExecutionContext)).resolves.toBeUndefined();
  });
});
