// Failure sites in worker clients and the viewer report fixed Glimpse
// diagnostic codes here instead of importing analytics directly. Some of those
// modules are also bundled into Web Workers, where analytics never runs; there
// no sink is registered and reports are no-ops. analytics.ts registers the
// consent-gated sender on the main thread.
export type FailureDiagnostic = "error_gpu_lost" | "error_out_of_memory" | "error_worker";

let sink: ((code: FailureDiagnostic) => void) | null = null;

export function setFailureDiagnosticSink(next: ((code: FailureDiagnostic) => void) | null): void {
  sink = next;
}

/** Fixed code only. The registered sender never throws (see analytics.ts). */
export function reportFailureDiagnostic(code: FailureDiagnostic): void {
  sink?.(code);
}

/**
 * Counts `error_gpu_lost` when a WebGL canvas loses its context unexpectedly.
 * Renderer teardown (three's forceContextLoss, a detached canvas) is not a loss.
 */
export function watchWebGlContextLoss(renderer: { domElement: EventTarget & { isConnected?: boolean }; forceContextLoss?: () => void }): void {
  let intentional = false;
  const force = renderer.forceContextLoss;
  if (force) {
    renderer.forceContextLoss = function (this: unknown) {
      intentional = true;
      force.call(this);
    };
  }
  renderer.domElement.addEventListener("webglcontextlost", () => {
    if (!intentional && renderer.domElement.isConnected !== false) reportFailureDiagnostic("error_gpu_lost");
  });
}

// Engine signals for a failed allocation, matched locally only and never sent:
// V8 "Array buffer allocation failed" / "Invalid array buffer length",
// SpiderMonkey and JavaScriptCore "out of memory", Emscripten "Cannot enlarge
// memory arrays" / "Aborted(OOM)", C++ std::bad_alloc from gmsh-wasm, and a
// refused WebAssembly.Memory.grow ("Maximum memory size exceeded").
const ALLOCATION_FAILURE = /allocation failed|array buffer length|out of memory|enlarge memory|\(oom\)|bad_alloc|maximum memory size/i;

/**
 * True when a worker failure reply ({name, message}, as posted by the mesh and
 * solve workers) or a thrown error came from a failed memory allocation. Only
 * error classes engines use for allocation failures qualify, so an unrelated
 * validation message mentioning memory is not misclassified.
 */
export function isAllocationFailure(error: unknown): boolean {
  const { name, message } = Object(error) as { name?: unknown; message?: unknown };
  return /^(Range|Internal|Runtime)?Error$/.test(String(name)) && ALLOCATION_FAILURE.test(String(message));
}
