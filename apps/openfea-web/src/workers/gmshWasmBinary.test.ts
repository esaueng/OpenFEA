import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function loadOptions(): Promise<Record<string, unknown>> {
  // Fresh module per test: the loader memoizes the decoded binary per worker.
  vi.resetModules();
  const { gmshWasmModuleOptions } = await import("./gmshWasmBinary");
  return gmshWasmModuleOptions();
}

function manifestResponse(): Response {
  return Response.json({ wasm: "/assets/gmsh-core-test.wasm.gz", encoding: "gzip" });
}

describe("gmsh wasm module options", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { href: "https://fea.esau.app/assets/meshWorker.js" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("production build", () => {
    beforeEach(() => {
      vi.stubEnv("PROD", true);
    });

    test("fails clearly instead of falling back to a raw .wasm the deploy does not ship", async () => {
      const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
      vi.stubGlobal("fetch", fetchMock);

      await expect(loadOptions()).rejects.toThrow(/gmsh meshing manifest \(\/assets\/gmsh-wasm\.json\): Failed to fetch/);
    });

    test("reports a missing manifest with its HTTP status", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));

      await expect(loadOptions()).rejects.toThrow(/gmsh-wasm\.json: HTTP 404/);
    });

    test("rejects an HTML fallback page served in place of the manifest", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })));

      await expect(loadOptions()).rejects.toThrow(/was not served as JSON/);
    });

    test("retries the manifest after a transient failure", async () => {
      vi.resetModules();
      const { gmshWasmModuleOptions } = await import("./gmshWasmBinary");
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(manifestResponse())
        .mockResolvedValueOnce(new Response(WASM_BYTES));
      vi.stubGlobal("fetch", fetchMock);

      await expect(gmshWasmModuleOptions()).rejects.toThrow(/Failed to fetch/);
      const options = await gmshWasmModuleOptions();
      expect(new Uint8Array(options.wasmBinary as ArrayBuffer)).toEqual(WASM_BYTES);
    });

    test("decompresses the gzip module named by the manifest", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("gmsh-wasm.json") ? manifestResponse() : new Response(gzipSync(WASM_BYTES))
      );
      vi.stubGlobal("fetch", fetchMock);

      const options = await loadOptions();

      expect(new Uint8Array(options.wasmBinary as ArrayBuffer)).toEqual(WASM_BYTES);
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        "/assets/gmsh-wasm.json",
        "/assets/gmsh-core-test.wasm.gz"
      ]);
    });
  });

  describe("dev server and tests", () => {
    beforeEach(() => {
      vi.stubEnv("PROD", false);
    });

    test("lets the Emscripten glue load the raw .wasm when no server answers", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

      await expect(loadOptions()).resolves.toEqual({});
    });

    test("treats the dev server's SPA fallback as a missing manifest", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })));

      await expect(loadOptions()).resolves.toEqual({});
    });
  });
});
