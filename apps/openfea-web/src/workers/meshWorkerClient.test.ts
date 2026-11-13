import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelMeshWork, meshGeoScriptInWorker } from "./meshWorkerClient";

describe("mesh worker cancellation", () => {
  afterEach(() => {
    cancelMeshWork();
    vi.unstubAllGlobals();
  });

  test("rejects active mesh work as a cancellation and terminates the worker", async () => {
    const terminate = vi.fn();
    class PendingMeshWorker {
      addEventListener() {}
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal("Worker", PendingMeshWorker);

    const pending = meshGeoScriptInWorker({
      geoScript: "SetFactory(\"OpenCASCADE\");",
      elementOrder: 1,
      units: "mm"
    });
    cancelMeshWork("Mesh generation cancelled.");

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "Mesh generation cancelled."
    });
    expect(terminate).toHaveBeenCalledOnce();
  });
});

describe("mesh worker failure messages", () => {
  afterEach(() => {
    cancelMeshWork();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("do not expose local filesystem paths from a module-load failure", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    class FailingMeshWorker {
      addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener); }
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal("Worker", FailingMeshWorker);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = meshGeoScriptInWorker({ geoScript: "SetFactory(\"OpenCASCADE\");", elementOrder: 1, units: "mm" });
    const raw = "Failed to fetch dynamically imported module: http://localhost:5173/@fs/home/alice/src/OpenFEA/node_modules/.pnpm/@loumalouomega+gmsh-wasm@0.4.0/node_modules/@loumalouomega/gmsh-wasm/dist/gmsh-core.mjs?v=a562feab";
    listeners.get("error")?.({ message: raw });

    const error = await pending.then(() => new Error("expected the mesh request to reject"), (reason: unknown) => reason as Error);
    expect(error.message).toBe("Failed to fetch dynamically imported module: gmsh-core.mjs");
    expect(error.message).not.toContain("/home/");
    expect(warn).toHaveBeenCalledWith("[OpenFEA mesh worker]", raw);
  });
});
