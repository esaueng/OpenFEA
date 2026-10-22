import type { SolveProgressEvent } from "@openfea/solve-pipeline";
import type { RunVariantResult } from "@openfea/schema";
import { trySolveOpenFeaCoreStudyAutomatic } from "./openfeaCoreSolve";
import type { LocalSolveResult } from "./performanceProtocol";
import {
  createSolveWorkerRequestId,
  isSolveWorkerProgress,
  isSolveWorkerResult,
  isSolveWorkerVariant,
  type SolveWorkerRequest,
  type SolveWorkerResponse,
  type SolveWorkerSolvePayload
} from "./solveProtocol";
import { workerClientError } from "./workerClientError";

/**
 * Client for the dedicated solve worker. Mirrors performanceClient's worker
 * lifecycle handling, plus:
 * - interim progress callbacks from the solver hooks,
 * - cooperative cancel with a terminate+respawn fallback: a blocked worker
 *   thread cannot observe the cancel message, so after
 *   CANCEL_TERMINATE_TIMEOUT_MS the worker is killed and recreated lazily.
 *   Only solve work lives on this worker, so termination never disturbs STL
 *   decode/playback on the shared performance worker.
 * - an inline fallback when Workers are unavailable (tests, SSR), running the
 *   same adapter path with the same hooks.
 */

export const CANCEL_TERMINATE_TIMEOUT_MS = 2000;

export class LocalSolveError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "LocalSolveError";
    this.code = code;
  }
}

export function isCancelledSolveError(error: unknown): boolean {
  return error instanceof LocalSolveError && error.code === "cancelled";
}

export type LocalSolveCompletion = {
  result: LocalSolveResult;
  solverBackend: string;
  /** Peak worker-heap bytes (Chrome-only performance.memory sampling in the worker); measurement telemetry, absent elsewhere. */
  workerPeakHeapBytes?: number;
};

export type LocalSolveHandle = {
  completion: Promise<LocalSolveCompletion>;
  cancel: () => void;
};

type PendingSolve = {
  id: string;
  worker: Worker;
  resolve: (completion: LocalSolveCompletion) => void;
  reject: (error: Error) => void;
  onProgress?: (event: SolveProgressEvent) => void;
  onVariantComplete?: (variant: RunVariantResult, surfaceMesh?: unknown) => void;
  cancelTimer?: ReturnType<typeof setTimeout>;
};

let workerInstance: Worker | null = null;
const retiringWorkers = new Set<Worker>();
const pendingSolves = new Map<string, PendingSolve>();

export function startLocalSolve(
  payload: SolveWorkerSolvePayload,
  onProgress?: (event: SolveProgressEvent) => void,
  onVariantComplete?: (variant: RunVariantResult, surfaceMesh?: unknown) => void
): LocalSolveHandle {
  if (typeof Worker === "undefined") return startInlineSolve(payload, onProgress, onVariantComplete);

  const id = createSolveWorkerRequestId();
  let worker: Worker;
  try {
    worker = getSolveWorker();
  } catch (error) {
    return rejectedSolveHandle(workerClientError(error, "Could not start the solve worker."));
  }
  const completion = new Promise<LocalSolveCompletion>((resolve, reject) => {
    pendingSolves.set(id, { id, worker, resolve, reject, onProgress, onVariantComplete });
  });
  const request: SolveWorkerRequest = { kind: "solve", id, payload };
  try {
    worker.postMessage(request);
  } catch (error) {
    rejectPending(id, workerClientError(error, "Could not send work to the solve worker."));
  }

  return {
    completion,
    cancel: () => {
      const pending = pendingSolves.get(id);
      if (!pending || pending.cancelTimer !== undefined) return;
      // A blocked worker cannot process another solve before cancellation.
      // Detach it now so a replacement solve gets its own worker; the old
      // worker remains owned by its pending requests until it settles or times out.
      if (workerInstance === worker) workerInstance = null;
      retiringWorkers.add(worker);
      // Cooperative first: the solver hooks check shouldCancel between CG
      // iterations / time steps if the worker event loop ever yields.
      try {
        worker.postMessage({ kind: "cancel", id } satisfies SolveWorkerRequest);
      } catch {
        terminateSolveWorker(worker, new LocalSolveError("OpenFEA Core solve cancelled.", "cancelled"));
        return;
      }
      pending.cancelTimer = setTimeout(() => {
        if (!pendingSolves.has(id)) return;
        // Settle every request owned by this worker, without touching a
        // replacement worker that may already be serving a new solve.
        terminateSolveWorker(worker, new LocalSolveError("OpenFEA Core solve cancelled.", "cancelled"));
      }, CANCEL_TERMINATE_TIMEOUT_MS);
    }
  };
}

function rejectedSolveHandle(error: Error): LocalSolveHandle {
  return {
    completion: Promise.reject(error),
    cancel: () => undefined
  };
}

function startInlineSolve(
  payload: SolveWorkerSolvePayload,
  onProgress?: (event: SolveProgressEvent) => void,
  onVariantComplete?: (variant: RunVariantResult, surfaceMesh?: unknown) => void
): LocalSolveHandle {
  let cancelled = false;
  const completion = new Promise<LocalSolveCompletion>((resolve, reject) => {
    // Deferred one tick so callers can subscribe/cancel before the synchronous
    // solve blocks this thread.
    const solve = async () => {
      if (cancelled) {
        reject(new LocalSolveError("OpenFEA Core solve cancelled.", "cancelled"));
        return;
      }
      try {
        const outcome = await trySolveOpenFeaCoreStudyAutomatic({
          study: payload.study,
          runId: payload.runId,
          displayModel: payload.displayModel,
          customMaterials: payload.customMaterials,
          hooks: {
            onProgress,
            shouldCancel: () => cancelled
          },
          onVariantComplete
        });
        if (!outcome.ok) {
          reject(new LocalSolveError(outcome.reason, outcome.code));
          return;
        }
        resolve({ result: outcome.result, solverBackend: outcome.solverBackend });
      } catch (error) {
        reject(error instanceof Error ? error : new LocalSolveError(String(error)));
      }
    };
    // solve() settles the completion promise itself and never rejects.
    setTimeout(() => void solve(), 0);
  });
  return {
    completion,
    cancel: () => {
      cancelled = true;
    }
  };
}

function getSolveWorker(): Worker {
  if (workerInstance) return workerInstance;
  const worker = new Worker(new URL("./solveWorker.ts", import.meta.url), { type: "module", name: "openfea-solve-worker" });
  worker.addEventListener("message", (event) => handleSolveWorkerMessage(worker, event));
  worker.addEventListener("error", (event) => handleSolveWorkerError(worker, event));
  workerInstance = worker;
  return worker;
}

function handleSolveWorkerMessage(worker: Worker, event: MessageEvent<SolveWorkerResponse>): void {
  const response = event.data;
  if (isSolveWorkerProgress(response)) {
    const pending = pendingSolves.get(response.id);
    if (pending?.worker === worker) pending.onProgress?.(response.event);
    return;
  }
  if (isSolveWorkerVariant(response)) {
    const pending = pendingSolves.get(response.id);
    if (pending?.worker === worker) pending.onVariantComplete?.(response.variant, response.surfaceMesh);
    return;
  }
  if (!isSolveWorkerResult(response)) return;
  const pending = pendingSolves.get(response.id);
  if (!pending || pending.worker !== worker) return;
  clearPending(pending);
  if (response.ok) {
    pending.resolve({
      result: response.result,
      solverBackend: response.solverBackend,
      ...(response.workerPeakHeapBytes !== undefined ? { workerPeakHeapBytes: response.workerPeakHeapBytes } : {})
    });
    return;
  }
  pending.reject(new LocalSolveError(response.error.message, response.error.code));
}

function handleSolveWorkerError(worker: Worker, event: ErrorEvent): void {
  if (worker !== workerInstance && !retiringWorkers.has(worker)) return;
  terminateSolveWorker(worker, new LocalSolveError(event.message || "Solve worker failed."));
}

function terminateSolveWorker(worker: Worker, error: Error): void {
  retiringWorkers.delete(worker);
  if (workerInstance === worker) workerInstance = null;
  worker.terminate();
  for (const pending of [...pendingSolves.values()]) {
    if (pending.worker !== worker) continue;
    clearPending(pending);
    pending.reject(error);
  }
}

function rejectPending(id: string, error: Error): void {
  const pending = pendingSolves.get(id);
  if (!pending) return;
  clearPending(pending);
  pending.reject(error);
}

function clearPending(pending: PendingSolve): void {
  if (pending.cancelTimer !== undefined) clearTimeout(pending.cancelTimer);
  pendingSolves.delete(pending.id);
  if (retiringWorkers.has(pending.worker) && ![...pendingSolves.values()].some((item) => item.worker === pending.worker)) {
    retiringWorkers.delete(pending.worker);
    pending.worker.terminate();
  }
}
