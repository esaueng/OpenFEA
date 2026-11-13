import { describe, expect, test, vi } from "vitest";
import { singleTetStaticFixture } from "@openfea/examples";
import { automaticTetSolverBackend, buildTet4DofAdjacency, buildTet4ElementData, solveStaticTet4ModelWebGpu, solveTet4MatrixFreeWebGpu, tet4MatrixFreeInternalForce, tet4MatrixFreeMatVec, WEBGPU_DEVICE_LOST_CODE, WEBGPU_OUT_OF_MEMORY_CODE, type Tet4MatrixFreeData } from "../src";

function singleTetData(): { data: Tet4MatrixFreeData; rhs: Float32Array } {
  const connectivity = new Uint32Array([0, 1, 2, 3]);
  const coordinates = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const element = buildTet4ElementData({ coordinates, connectivity, youngModulus: new Float64Array([200e9]), poissonRatio: new Float64Array([0.29]) });
  const constrained = new Uint32Array(12);
  for (let dof = 0; dof < 9; dof += 1) constrained[dof] = 1;
  const rhs = new Float32Array(12);
  rhs[11] = 1000;
  return { data: { dofs: 12, connectivity, ...element, ...buildTet4DofAdjacency(connectivity, 12), constrained }, rhs };
}

/** Minimal GPUDevice fake: records allocations and lets a test drive loss, OOM and readback. */
function fakeGpu(options: { lostReason?: string; oom?: boolean; mapAsync?: () => Promise<void> }) {
  let resolveLost: (info: { reason: string; message: string }) => void = () => undefined;
  const destroyed = vi.fn();
  const device = {
    lost: new Promise<{ reason: string; message: string }>((resolve) => { resolveLost = resolve; }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => (options.oom ? { message: "GPU adapter detail that must not escape" } : null)),
    createBuffer: vi.fn(() => ({ destroy: vi.fn(), mapAsync: options.mapAsync ?? (async () => undefined), getMappedRange: () => new ArrayBuffer(48), unmap: vi.fn() })),
    queue: { writeBuffer: vi.fn(), submit: vi.fn(() => { if (options.lostReason) resolveLost({ reason: options.lostReason, message: "driver detail" }); }) },
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      beginComputePass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() }),
      copyBufferToBuffer: vi.fn(),
      finish: vi.fn()
    })),
    destroy: vi.fn(() => { destroyed(); resolveLost({ reason: "destroyed", message: "" }); })
  };
  return { device, destroyed, navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } } };
}

describe("matrix-free Tet4 backend", () => {
  test("keeps the readback-heavy WebGPU CG route out of automatic execution", () => {
    expect(automaticTetSolverBackend({ elementType: "Tet4", dofs: 150_000, webGpuAvailable: true })).toBe("cpu");
    expect(automaticTetSolverBackend({ elementType: "Tet4", dofs: 150_001, webGpuAvailable: true })).toBe("unsupported");
    expect(automaticTetSolverBackend({ elementType: "Tet4", dofs: 500_001, webGpuAvailable: true })).toBe("unsupported");
    expect(automaticTetSolverBackend({ elementType: "Tet10", dofs: 200_000, webGpuAvailable: true })).toBe("unsupported");
  });

  test("matches symmetry and positive energy without assembling a global matrix", () => {
    const connectivity = new Uint32Array([0, 1, 2, 3]);
    const coordinates = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const element = buildTet4ElementData({ coordinates, connectivity, youngModulus: new Float64Array([200e9]), poissonRatio: new Float64Array([0.29]) });
    const adjacency = buildTet4DofAdjacency(connectivity, 12);
    const data: Tet4MatrixFreeData = { dofs: 12, connectivity, ...element, ...adjacency, constrained: new Uint32Array(12) };
    const x = new Float32Array([0.1, -0.2, 0.05, 0.2, 0.1, 0, -0.1, 0.15, 0.1, 0.05, 0, -0.1]);
    const y = new Float32Array([-0.03, 0.1, 0.2, 0.15, -0.1, 0.04, 0.1, 0.2, -0.05, -0.1, 0.02, 0.08]);
    const kx = tet4MatrixFreeMatVec(data, x), ky = tet4MatrixFreeMatVec(data, y);
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index], 0);
    expect(dot(x, kx)).toBeGreaterThanOrEqual(0);
    expect(dot(x, ky)).toBeCloseTo(dot(y, kx), -2);
  });

  test("recovers physical constrained-row force instead of the Dirichlet identity row", () => {
    const connectivity = new Uint32Array([0, 1, 2, 3]);
    const coordinates = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const element = buildTet4ElementData({ coordinates, connectivity, youngModulus: new Float64Array([200e9]), poissonRatio: new Float64Array([0.29]) });
    const adjacency = buildTet4DofAdjacency(connectivity, 12);
    const constrained = new Uint32Array(12);
    constrained[0] = 1;
    const data: Tet4MatrixFreeData = { dofs: 12, connectivity, ...element, ...adjacency, constrained };
    const displacement = new Float32Array(12);
    displacement[3] = 1e-6;
    expect(tet4MatrixFreeMatVec(data, displacement)[0]).toBe(0);
    expect(Math.abs(tet4MatrixFreeInternalForce(data, displacement)[0])).toBeGreaterThan(0);
  });

  test("returns the exact zero solution without requesting WebGPU for a zero right-hand side", async () => {
    const data: Tet4MatrixFreeData = {
      dofs: 3,
      connectivity: new Uint32Array(0),
      elementData: new Float32Array(0),
      rowPtr: new Uint32Array(4),
      adjacencyElements: new Uint32Array(0),
      adjacencyLocalRows: new Uint32Array(0),
      diagonal: new Float32Array(3),
      constrained: new Uint32Array(3)
    };

    const solved = await solveTet4MatrixFreeWebGpu(data, new Float32Array(3), {
      navigator: {
        gpu: {
          requestAdapter: () => {
            throw new Error("WebGPU must not be requested for an exact zero solve.");
          }
        }
      }
    });

    expect(solved).toMatchObject({ ok: true, iterations: 0, relativeResidual: 0 });
    expect(solved.ok && Array.from(solved.solution)).toEqual([0, 0, 0]);
  });

  test("guards the public WebGPU model entry before GPU allocation", async () => {
    const solved = await solveStaticTet4ModelWebGpu(singleTetStaticFixture, 0, {
      maxDofs: 3,
      navigator: {
        gpu: {
          requestAdapter: () => {
            throw new Error("WebGPU must not be requested for an over-limit model.");
          }
        }
      }
    });

    expect(solved).toEqual({
      ok: false,
      error: {
        code: "max-dofs-exceeded",
        message: "Model has 12 DOFs, which exceeds maxDofs 3."
      }
    });
  });

  test("reports an unexpected WebGPU device loss as a fixed code without driver text", async () => {
    const { data, rhs } = singleTetData();
    const gpu = fakeGpu({ lostReason: "unknown", mapAsync: () => Promise.reject(new DOMException("Device lost: driver detail", "OperationError")) });
    const solved = await solveTet4MatrixFreeWebGpu(data, rhs, { navigator: gpu.navigator });
    expect(solved).toMatchObject({ ok: false, error: { code: WEBGPU_DEVICE_LOST_CODE } });
    expect(JSON.stringify(solved)).not.toContain("driver detail");
    expect(gpu.destroyed).toHaveBeenCalledOnce();
  });

  test("does not classify our own destroy() or other readback failures as device loss", async () => {
    const { data, rhs } = singleTetData();
    const gpu = fakeGpu({ lostReason: "destroyed", mapAsync: () => Promise.reject(new Error("readback failed")) });
    await expect(solveTet4MatrixFreeWebGpu(data, rhs, { navigator: gpu.navigator })).rejects.toThrow("readback failed");
  });

  test("reports GPU buffer allocation failure from the out-of-memory error scope", async () => {
    const { data, rhs } = singleTetData();
    const gpu = fakeGpu({ oom: true });
    const solved = await solveTet4MatrixFreeWebGpu(data, rhs, { navigator: gpu.navigator });
    expect(gpu.device.pushErrorScope).toHaveBeenCalledWith("out-of-memory");
    expect(solved).toMatchObject({ ok: false, error: { code: WEBGPU_OUT_OF_MEMORY_CODE } });
    expect(JSON.stringify(solved)).not.toContain("adapter detail");
    expect(gpu.destroyed).toHaveBeenCalledOnce();
    expect(gpu.device.createShaderModule).not.toHaveBeenCalled();
  });
});
