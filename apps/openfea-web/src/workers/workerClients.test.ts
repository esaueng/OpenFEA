import { afterEach, describe, expect, test, vi } from "vitest";
import type { SolveWorkerSolvePayload } from "./solveProtocol";

type PostMessage = (message?: unknown, transfer?: unknown) => void;

class ThrowingWorker {
  static instances: ThrowingWorker[] = [];

  readonly addEventListener = vi.fn();
  readonly terminate = vi.fn();
  // Annotated rather than inferred: an always-throwing implementation infers
  // Mock<() => never>, which subclasses cannot override with a mock that
  // sometimes returns normally.
  readonly postMessage = vi.fn<PostMessage>(() => {
    throw new DOMException("The payload could not be cloned.", "DataCloneError");
  });

  constructor() {
    ThrowingWorker.instances.push(this);
  }
}

class MessagingWorker {
  static instances: MessagingWorker[] = [];

  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();
  private messageListener?: (event: MessageEvent) => void;
  private errorListener?: (event: ErrorEvent) => void;

  readonly addEventListener = vi.fn((type: string, listener: EventListener) => {
    if (type === "message") this.messageListener = listener as (event: MessageEvent) => void;
    if (type === "error") this.errorListener = listener as (event: ErrorEvent) => void;
  });

  constructor() {
    MessagingWorker.instances.push(this);
  }

  emitMessage(data: unknown) {
    this.messageListener?.({ data } as MessageEvent);
  }

  emitError(message: string) {
    this.errorListener?.({ message } as ErrorEvent);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  ThrowingWorker.instances = [];
  MessagingWorker.instances = [];
});

describe("worker clients", () => {
  test("rejects performance requests when message dispatch fails", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);
    const { postPerformanceWorkerRequest } = await import("./performanceClient");

    await expect(postPerformanceWorkerRequest("prepareResultFrame", { fields: [], framePosition: 0 })).rejects.toThrow("payload could not be cloned");
  });

  test("rejects mesh requests and releases the worker when message dispatch fails", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);
    const { postMeshWorkerRequest } = await import("./meshWorkerClient");

    await expect(postMeshWorkerRequest("inspectStepFile", { stepContent: new ArrayBuffer(8) })).rejects.toThrow("payload could not be cloned");
    expect(ThrowingWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  test("returns a rejected solve completion when initial message dispatch fails", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);
    const { startLocalSolve } = await import("./solveWorkerClient");

    const handle = startLocalSolve({} as SolveWorkerSolvePayload);

    await expect(handle.completion).rejects.toThrow("payload could not be cloned");
  });

  test("hard-cancels a solve when the cooperative cancel message cannot be sent", async () => {
    class CancelThrowingWorker extends ThrowingWorker {
      override readonly postMessage = vi.fn<PostMessage>()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new DOMException("The worker is no longer running.", "InvalidStateError");
        });
    }
    vi.stubGlobal("Worker", CancelThrowingWorker);
    const { isCancelledSolveError, startLocalSolve } = await import("./solveWorkerClient");
    const handle = startLocalSolve({} as SolveWorkerSolvePayload);

    handle.cancel();

    const error = await handle.completion.catch((reason: unknown) => reason);
    expect(isCancelledSolveError(error)).toBe(true);
    expect(CancelThrowingWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  test("delivers streamed dynamic variants before the final solve result", async () => {
    vi.stubGlobal("Worker", MessagingWorker);
    const { startLocalSolve } = await import("./solveWorkerClient");
    const onVariantComplete = vi.fn();
    const handle = startLocalSolve({} as SolveWorkerSolvePayload, undefined, onVariantComplete);
    const worker = MessagingWorker.instances[0]!;
    const request = worker.postMessage.mock.calls[0]?.[0] as { id: string };
    const summary = {
      maxStress: 1,
      maxStressUnits: "MPa",
      maxDisplacement: 1,
      maxDisplacementUnits: "mm",
      safetyFactor: 1,
      reactionForce: 1,
      reactionForceUnits: "N"
    };
    const variant = { id: "case:gust", name: "Gust", kind: "case", caseId: "gust", summary, fields: [] };

    worker.emitMessage({ kind: "variant", id: request.id, variant, surfaceMesh: { id: "surface-1" } });
    expect(onVariantComplete).toHaveBeenCalledWith(variant, { id: "surface-1" });

    worker.emitMessage({
      kind: "result",
      id: request.id,
      ok: true,
      solverBackend: "opencae-core-sparse-tet-dynamic",
      result: { summary, fields: [] }
    });
    await expect(handle.completion).resolves.toMatchObject({ solverBackend: "opencae-core-sparse-tet-dynamic" });
  });

  test("a cancelled solve's fallback cannot terminate a replacement solve", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", MessagingWorker);
    const { CANCEL_TERMINATE_TIMEOUT_MS, isCancelledSolveError, startLocalSolve } = await import("./solveWorkerClient");
    const first = startLocalSolve({} as SolveWorkerSolvePayload);
    const firstError = first.completion.catch((error: unknown) => error);
    first.cancel();
    const replacement = startLocalSolve({} as SolveWorkerSolvePayload);
    const oldWorker = MessagingWorker.instances[0]!;
    const replacementWorker = MessagingWorker.instances[1];
    expect(replacementWorker).toBeDefined();

    await vi.advanceTimersByTimeAsync(CANCEL_TERMINATE_TIMEOUT_MS);
    expect(isCancelledSolveError(await firstError)).toBe(true);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(replacementWorker!.terminate).not.toHaveBeenCalled();
    const request = replacementWorker!.postMessage.mock.calls[0]![0] as { id: string };
    replacementWorker!.emitMessage({ kind: "result", id: request.id, ok: true, result: {}, solverBackend: "cpu" });
    await expect(replacement.completion).resolves.toMatchObject({ solverBackend: "cpu" });
  });

  test("late errors and messages from a retiring worker do not settle replacement work", async () => {
    vi.stubGlobal("Worker", MessagingWorker);
    const { startLocalSolve } = await import("./solveWorkerClient");
    const first = startLocalSolve({} as SolveWorkerSolvePayload);
    const firstError = first.completion.catch((error: unknown) => error);
    first.cancel();
    const onProgress = vi.fn();
    const replacement = startLocalSolve({} as SolveWorkerSolvePayload, onProgress);
    const oldWorker = MessagingWorker.instances[0]!;
    const replacementWorker = MessagingWorker.instances[1];
    expect(replacementWorker).toBeDefined();
    const request = replacementWorker!.postMessage.mock.calls[0]![0] as { id: string };

    oldWorker.emitMessage({ kind: "progress", id: request.id, event: { progress: 0.5 } });
    oldWorker.emitMessage({ kind: "result", id: request.id, ok: true, result: {}, solverBackend: "stale" });
    expect(onProgress).not.toHaveBeenCalled();
    oldWorker.emitError("Old worker failed");
    expect(await firstError).toBeInstanceOf(Error);
    expect(replacementWorker!.terminate).not.toHaveBeenCalled();
    replacementWorker!.emitMessage({ kind: "result", id: request.id, ok: true, result: {}, solverBackend: "cpu" });
    await expect(replacement.completion).resolves.toMatchObject({ solverBackend: "cpu" });
  });

  test("hard termination settles every request belonging to the retiring worker", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", MessagingWorker);
    const { CANCEL_TERMINATE_TIMEOUT_MS, startLocalSolve } = await import("./solveWorkerClient");
    const first = startLocalSolve({} as SolveWorkerSolvePayload);
    const shared = startLocalSolve({} as SolveWorkerSolvePayload);
    const errors = Promise.all([first.completion.catch((error: unknown) => error), shared.completion.catch((error: unknown) => error)]);
    expect(MessagingWorker.instances).toHaveLength(1);
    first.cancel();
    await vi.advanceTimersByTimeAsync(CANCEL_TERMINATE_TIMEOUT_MS);
    for (const error of await errors) expect(error).toBeInstanceOf(Error);
    expect(MessagingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  test("cooperative cancellation releases a retired worker and clears its fallback", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", MessagingWorker);
    const { CANCEL_TERMINATE_TIMEOUT_MS, isCancelledSolveError, startLocalSolve } = await import("./solveWorkerClient");
    const first = startLocalSolve({} as SolveWorkerSolvePayload);
    const firstError = first.completion.catch((error: unknown) => error);
    const oldWorker = MessagingWorker.instances[0]!;
    const request = oldWorker.postMessage.mock.calls[0]![0] as { id: string };
    first.cancel();
    oldWorker.emitMessage({ kind: "result", id: request.id, ok: false, error: { message: "Cancelled", code: "cancelled" } });
    expect(isCancelledSolveError(await firstError)).toBe(true);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CANCEL_TERMINATE_TIMEOUT_MS);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
  });
});
