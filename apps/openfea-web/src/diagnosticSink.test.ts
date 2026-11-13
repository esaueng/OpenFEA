import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBGPU_DEVICE_LOST_CODE, WEBGPU_OUT_OF_MEMORY_CODE } from "./workers/openfeaCoreSolve";
import { isAllocationFailure, reportFailureDiagnostic, setFailureDiagnosticSink } from "./diagnosticSink";

class InternalError extends Error { override name = "InternalError"; }
class RuntimeError extends Error { override name = "RuntimeError"; }

afterEach(() => setFailureDiagnosticSink(null));

describe("failure diagnostic sink", () => {
  it("is a no-op until analytics registers a sender (as inside Web Workers)", () => {
    expect(() => reportFailureDiagnostic("error_worker")).not.toThrow();
    const sink = vi.fn();
    setFailureDiagnosticSink(sink);
    reportFailureDiagnostic("error_worker");
    expect(sink).toHaveBeenCalledExactlyOnceWith("error_worker");
  });

  it("uses the WebGPU solver's fixed failure codes", () => {
    expect([WEBGPU_DEVICE_LOST_CODE, WEBGPU_OUT_OF_MEMORY_CODE]).toEqual(["webgpu-device-lost", "webgpu-out-of-memory"]);
  });
});

describe("allocation failure classification", () => {
  it("recognises engine and wasm allocation failures, including posted {name, message} replies", () => {
    expect(isAllocationFailure(new RangeError("Array buffer allocation failed"))).toBe(true);
    expect(isAllocationFailure(new RangeError("Invalid array buffer length"))).toBe(true);
    expect(isAllocationFailure(new RangeError("Out of memory"))).toBe(true);
    expect(isAllocationFailure(new InternalError("out of memory"))).toBe(true);
    expect(isAllocationFailure(new RuntimeError("Aborted(OOM). Build with -sASSERTIONS for more info."))).toBe(true);
    expect(isAllocationFailure(new Error("Cannot enlarge memory arrays to size 4294967296 bytes"))).toBe(true);
    expect(isAllocationFailure(new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded"))).toBe(true);
    expect(isAllocationFailure({ name: "RangeError", message: "Array buffer allocation failed" })).toBe(true);
    expect(isAllocationFailure({ name: "Error", message: "std::bad_alloc" })).toBe(true);
  });

  it("does not misclassify ordinary failures", () => {
    expect(isAllocationFailure(new RangeError("Invalid typed array length: -1"))).toBe(false);
    expect(isAllocationFailure(new Error("Tet4 element must have positive finite volume."))).toBe(false);
    expect(isAllocationFailure({ name: "MeshQualityError", message: "out of memory budget for quality" })).toBe(false);
    expect(isAllocationFailure(new TypeError("out of memory"))).toBe(false);
    expect(isAllocationFailure(undefined)).toBe(false);
    expect(isAllocationFailure({ message: 42 })).toBe(false);
    expect(isAllocationFailure("out of memory")).toBe(false);
  });
});
