import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SolveWorkerSolvePayload } from "./solveProtocol";

// Glimpse diagnostics from worker clients: fixed codes only, routed through the
// diagnostic sink. analytics.ts connects its consent-gated sender to the sink
// (covered in analytics.test.ts); here a spy is registered instead.
const trackDetail = vi.fn();

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private readonly listeners = new Map<string, (event: unknown) => void>();
  readonly addEventListener = vi.fn((type: string, listener: (event: unknown) => void) => {
    this.listeners.set(type, listener);
  });
  constructor() {
    FakeWorker.instances.push(this);
  }
  emitMessage(data: unknown) {
    const event = { data } as MessageEvent;
    this.listeners.get("message")?.(event);
    this.onmessage?.(event);
  }
  emitError(message = "private worker text at https://example.invalid/worker.js:1") {
    const event = { message, filename: "https://example.invalid/worker.js", lineno: 1 } as ErrorEvent;
    this.listeners.get("error")?.(event);
    this.onerror?.(event);
  }
  lastRequest(): { id: string } {
    return this.postMessage.mock.calls.at(-1)![0] as { id: string };
  }
}

beforeEach(async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const { setFailureDiagnosticSink } = await import("../diagnosticSink");
  setFailureDiagnosticSink(trackDetail);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  trackDetail.mockReset();
  FakeWorker.instances = [];
});

function onlyFixedCodes() {
  for (const call of trackDetail.mock.calls) expect(call).toHaveLength(1);
  return trackDetail.mock.calls.map((call) => call[0] as string);
}

describe("error_worker", () => {
  test("solve worker crash counts once with no message, file or line", async () => {
    const { startLocalSolve } = await import("./solveWorkerClient");
    const handle = startLocalSolve({} as SolveWorkerSolvePayload);
    FakeWorker.instances[0]!.emitError();
    await expect(handle.completion).rejects.toThrow();
    expect(onlyFixedCodes()).toEqual(["error_worker"]);
  });

  test("a solve worker already released after cancellation is not counted", async () => {
    const { startLocalSolve } = await import("./solveWorkerClient");
    const handle = startLocalSolve({} as SolveWorkerSolvePayload);
    const worker = FakeWorker.instances[0]!;
    const id = worker.lastRequest().id;
    handle.cancel();
    worker.emitMessage({ kind: "result", id, ok: false, error: { name: "Error", message: "cancelled", code: "cancelled" } });
    await expect(handle.completion).rejects.toThrow();
    expect(worker.terminate).toHaveBeenCalled();
    worker.emitError();
    expect(trackDetail).not.toHaveBeenCalled();
  });

  test("mesh worker crash counts", async () => {
    const { postMeshWorkerRequest } = await import("./meshWorkerClient");
    const pending = postMeshWorkerRequest("inspectStepFile", { content: new Uint8Array([1]) } as never);
    FakeWorker.instances[0]!.emitError();
    await expect(pending).rejects.toThrow();
    expect(onlyFixedCodes()).toEqual(["error_worker"]);
  });

  test("performance, STEP display and validation worker crashes count", async () => {
    const { postPerformanceWorkerRequest } = await import("./performanceClient");
    const perf = postPerformanceWorkerRequest("prepareResultFrame", { fields: [], framePosition: 0 } as never);
    FakeWorker.instances.at(-1)!.emitError();
    await expect(perf).rejects.toThrow();

    const { readStepFileInDisplayWorker } = await import("./stepDisplayWorkerClient");
    const step = readStepFileInDisplayWorker(new Uint8Array([1]));
    FakeWorker.instances.at(-1)!.emitError();
    await expect(step).rejects.toThrow();

    const { runValidationBenchmarkInWorker } = await import("./validationWorkerClient");
    const validation = runValidationBenchmarkInWorker("x" as never);
    FakeWorker.instances.at(-1)!.emitError();
    await expect(validation).rejects.toThrow();

    expect(onlyFixedCodes()).toEqual(["error_worker", "error_worker", "error_worker"]);
  });

  test("an ordinary failure reply is not a worker failure", async () => {
    const { startLocalSolve } = await import("./solveWorkerClient");
    const handle = startLocalSolve({} as SolveWorkerSolvePayload);
    const worker = FakeWorker.instances[0]!;
    worker.emitMessage({ kind: "result", id: worker.lastRequest().id, ok: false, error: { name: "Error", message: "singular", code: "singular-system" } });
    await expect(handle.completion).rejects.toThrow("singular");
    expect(trackDetail).not.toHaveBeenCalled();
  });
});

describe("error_gpu_lost and error_out_of_memory from solve and mesh failures", () => {
  test.each([
    [{ name: "Error", message: "WebGPU device lost.", code: "webgpu-device-lost" }, "error_gpu_lost"],
    [{ name: "Error", message: "WebGPU buffer allocation failed.", code: "webgpu-out-of-memory" }, "error_out_of_memory"],
    [{ name: "RangeError", message: "Array buffer allocation failed" }, "error_out_of_memory"],
    [{ name: "Error", message: "OpenFEA Core solve failed: Out of memory", code: "solve-failed" }, "error_out_of_memory"]
  ])("solve failure %o maps to %s", async (error, diagnostic) => {
    const { startLocalSolve } = await import("./solveWorkerClient");
    const handle = startLocalSolve({} as SolveWorkerSolvePayload);
    const worker = FakeWorker.instances[0]!;
    worker.emitMessage({ kind: "result", id: worker.lastRequest().id, ok: false, error });
    await expect(handle.completion).rejects.toThrow();
    expect(onlyFixedCodes()).toEqual([diagnostic]);
  });

  test("mesh allocation failure reply counts error_out_of_memory", async () => {
    const { postMeshWorkerRequest } = await import("./meshWorkerClient");
    const pending = postMeshWorkerRequest("inspectStepFile", { content: new Uint8Array([1]) } as never);
    const worker = FakeWorker.instances[0]!;
    worker.emitMessage({ id: worker.lastRequest().id, operation: "inspectStepFile", ok: false, error: { name: "RangeError", message: "Array buffer allocation failed" } });
    await expect(pending).rejects.toThrow("Array buffer allocation failed");
    expect(onlyFixedCodes()).toEqual(["error_out_of_memory"]);
  });

  test("other mesh failures send no memory diagnostic", async () => {
    const { postMeshWorkerRequest } = await import("./meshWorkerClient");
    const pending = postMeshWorkerRequest("inspectStepFile", { content: new Uint8Array([1]) } as never);
    const worker = FakeWorker.instances[0]!;
    worker.emitMessage({ id: worker.lastRequest().id, operation: "inspectStepFile", ok: false, error: { name: "MeshQualityError", message: "bad mesh" } });
    await expect(pending).rejects.toThrow("bad mesh");
    expect(trackDetail).not.toHaveBeenCalled();
  });
});
