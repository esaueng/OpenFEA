// Runs one solve-ladder case through the production CPU solver internals under
// the production BROWSER_SOLVE_LIMITS. Shared by the browser ladder worker and
// the Node reference script so both measure exactly the same code path.
//
// Static solves split the production solveCoreStatic path into its two public
// halves (prepareStaticLinearTetSystem + solvePreparedStaticLoadCase) so that
// assembly and CG time are measured directly instead of inferred from
// throttled progress events. Options are the ones the solve pipeline would
// pass (boundedSolverSettings + sparse mode), so the preconditioner is the
// production auto choice (SSOR) unless a caller overrides it.
import { normalizeModelJson, validateCoreResult } from "@openfea/core";
import { BROWSER_SOLVE_LIMITS, boundedSolverSettings } from "@openfea/solve-pipeline";
import {
  prepareStaticLinearTetSystem,
  solveCoreDynamic,
  solveCoreModal,
  solvePreparedStaticLoadCase,
  type CpuSolverOptions,
  type SolveProgressEvent
} from "@openfea/solver-cpu";
import {
  buildLadderFixture,
  LADDER_STEP_INDEX,
  type LadderAnalysis,
  type LadderFixture,
  type LadderOrder,
  type LadderRung,
  type LadderShape
} from "./solveLadderFixtures";

export type LadderCaseRequest = {
  shape: LadderShape;
  order: LadderOrder;
  rung: LadderRung;
  analysis: LadderAnalysis;
  /** Reference runs only: override the production preconditioner / tolerance. */
  preconditioner?: "jacobi" | "ssor";
  tolerance?: number;
};

export type LadderParity = {
  /** Mean z displacement over the x = L tip nodes (mm). */
  tipMeanUz: number;
  /** Max nodal displacement magnitude (mm). */
  maxDisplacement: number;
  /** Sum of z reactions over the clamp (N); equilibrium requires -appliedFz. */
  reactionZ: number;
  appliedZ: number;
  /** |reactionZ + appliedZ| / |appliedZ|. */
  reactionBalanceRelError: number;
};

export type LadderCaseResult =
  | {
      ok: true;
      caseId: string;
      fixture: Pick<LadderFixture, "id" | "shape" | "order" | "rung" | "grid" | "freeDofs" | "fingerprint"> & {
        totalDofs: number;
        elements: number;
      };
      analysis: LadderAnalysis;
      appliedLimitMaxDofs: number;
      settings: { maxIterations?: number; tolerance?: number; preconditioner: string };
      timings: {
        generateMs: number;
        normalizeMs?: number;
        /** Static: element loop + CSR build + constraint reduction. Modal/dynamic: first->last assemble event. */
        assembleMs?: number;
        /** Static: RHS reduction + preconditioned CG (ends at the final CG progress event). */
        solveMs?: number;
        /** Static: displacement scatter, reactions, stress recovery, Core result build. */
        recoverMs?: number;
        totalSolveMs: number;
      };
      solver: {
        cgIterations?: number;
        /** True residual ||K u - f|| / ||f|| over free DOFs, recomputed after CG (static). */
        finalRelativeResidual?: number;
        matrixNonZeros?: number;
        estimatedMatrixBytes?: number;
        /** Modal: block subspace iterations; inner CG solves are not individually reported. */
        subspaceIterations?: number;
        convergedModeCount?: number;
        frequenciesHz?: number[];
        /** Dynamic: per-frame CG iteration stats over the Newmark steps. */
        frameCount?: number;
        cgIterationsTotal?: number;
        cgIterationsMaxPerStep?: number;
        peakDisplacement?: number;
        meshProjection?: string;
      };
      parity?: LadderParity;
      coreResultValid: boolean;
      heap: { method: string; peakBytes?: number };
    }
  | { ok: false; caseId: string; analysis: LadderAnalysis; error: string; code?: string; timings?: Record<string, number> };

export function ladderCaseId(request: Pick<LadderCaseRequest, "shape" | "order" | "rung" | "analysis">): string {
  return `${request.shape}-${request.order.toLowerCase()}-${request.rung}-${request.analysis}`;
}

type HeapSampler = { sample(): void; peak(): number | undefined; method: string };

/** performance.memory is Chrome-only and may be absent inside workers; it excludes ArrayBuffer backing stores. */
export function createHeapSampler(): HeapSampler {
  const read = (): number | undefined => {
    const memory = (globalThis.performance as unknown as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
    if (typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)) return memory.usedJSHeapSize;
    const nodeProcess = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number; arrayBuffers: number } } }).process;
    if (typeof nodeProcess?.memoryUsage === "function") {
      const usage = nodeProcess.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    }
    return undefined;
  };
  const first = read();
  const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
  let peak = first;
  return {
    method: first === undefined
      ? "unavailable"
      : isNode
        ? "process.memoryUsage heapUsed+arrayBuffers (sampled at progress events)"
        : "performance.memory.usedJSHeapSize (sampled at progress events; excludes ArrayBuffers)",
    sample() {
      const value = read();
      if (value !== undefined && (peak === undefined || value > peak)) peak = value;
    },
    peak: () => peak
  };
}

export function runLadderCase(request: LadderCaseRequest): LadderCaseResult {
  const caseId = ladderCaseId(request);
  const generateStart = performance.now();
  const fixture = buildLadderFixture(request.shape, request.order, request.rung);
  const generateMs = performance.now() - generateStart;
  const heap = createHeapSampler();
  const stepIndex = LADDER_STEP_INDEX[request.analysis];
  const pipelineType = request.analysis === "static" ? "static_stress" : request.analysis === "modal" ? "modal_analysis" : "dynamic_structural";
  const bounded = boundedSolverSettings(pipelineType, { stepIndex }, fixture.model, BROWSER_SOLVE_LIMITS);
  const progress = { assembleFirst: undefined as number | undefined, assembleLast: undefined as number | undefined, solveLast: undefined as number | undefined, maxIteration: 0 };
  const hooks = {
    onProgress(event: SolveProgressEvent) {
      const now = performance.now();
      heap.sample();
      if (event.phase === "assemble") {
        progress.assembleFirst ??= now;
        progress.assembleLast = now;
      } else if (event.phase === "solve") {
        progress.solveLast = now;
        if (typeof event.iteration === "number" && event.iteration > progress.maxIteration) progress.maxIteration = event.iteration;
      }
    }
  };
  const options: CpuSolverOptions = {
    ...(bounded as CpuSolverOptions),
    stepIndex,
    hooks,
    ...(request.preconditioner ? { preconditioner: request.preconditioner } : {}),
    ...(request.tolerance !== undefined ? { tolerance: request.tolerance } : {})
  };
  const fixtureSummary = {
    id: fixture.id,
    shape: fixture.shape,
    order: fixture.order,
    rung: fixture.rung,
    grid: fixture.grid,
    freeDofs: fixture.freeDofs,
    fingerprint: fixture.fingerprint,
    totalDofs: fixture.grid.dofs,
    elements: fixture.model.elementBlocks[0]!.connectivity.length / (fixture.order === "Tet10" ? 10 : 4)
  };
  const fail = (error: string, code?: string, timings?: Record<string, number>): LadderCaseResult =>
    ({ ok: false, caseId, analysis: request.analysis, error, ...(code ? { code } : {}), ...(timings ? { timings } : {}) });

  if (request.analysis === "static") {
    const normalizeStart = performance.now();
    const normalized = normalizeModelJson(fixture.model);
    const normalizeMs = performance.now() - normalizeStart;
    if (!normalized.ok) return fail(`Model normalization failed: ${normalized.report.errors.map((issue) => issue.code).join(", ")}`, "invalid-model");
    heap.sample();
    const assembleStart = performance.now();
    const prepared = prepareStaticLinearTetSystem(normalized.model, ["clamp"], options);
    const assembleMs = performance.now() - assembleStart;
    heap.sample();
    if (!prepared.ok) return fail(prepared.error.message, prepared.error.code, { generateMs, normalizeMs, assembleMs });
    const solveStart = performance.now();
    progress.solveLast = undefined;
    const solved = solvePreparedStaticLoadCase(prepared.system, ["tipShear"], options);
    const solveEnd = performance.now();
    heap.sample();
    if (!solved.ok) return fail(solved.error.message, solved.error.code, { generateMs, normalizeMs, assembleMs, solveMs: solveEnd - solveStart });
    const cgEnd = progress.solveLast ?? solveEnd;
    const diagnostics = solved.diagnostics;
    const coreResult = solved.result.coreResult;
    return {
      ok: true,
      caseId,
      fixture: fixtureSummary,
      analysis: "static",
      appliedLimitMaxDofs: BROWSER_SOLVE_LIMITS.maxDofs,
      settings: { maxIterations: options.maxIterations, tolerance: options.tolerance, preconditioner: diagnostics.preconditioner ?? "unknown" },
      timings: {
        generateMs,
        normalizeMs,
        assembleMs,
        solveMs: cgEnd - solveStart,
        recoverMs: solveEnd - cgEnd,
        totalSolveMs: normalizeMs + assembleMs + (solveEnd - solveStart)
      },
      solver: {
        cgIterations: diagnostics.iterations,
        finalRelativeResidual: diagnostics.relativeResidual,
        matrixNonZeros: diagnostics.matrixNonZeros,
        estimatedMatrixBytes: diagnostics.estimatedMatrixBytes
      },
      parity: staticParity(fixture, solved.result.displacement, solved.result.reactionForce),
      coreResultValid: coreResult ? validateCoreResult(coreResult).ok : false,
      heap: { method: heap.method, peakBytes: heap.peak() }
    };
  }

  const solveStart = performance.now();
  if (request.analysis === "modal") {
    const solved = solveCoreModal(fixture.model, options);
    const totalSolveMs = performance.now() - solveStart;
    heap.sample();
    if (!solved.ok) return fail(solved.error.message, solved.error.code, { generateMs, totalSolveMs });
    const diagnostics = solved.diagnostics;
    const frequencies = solved.result.summary.modes.map((mode) => mode.frequencyHz);
    return {
      ok: true,
      caseId,
      fixture: fixtureSummary,
      analysis: "modal",
      appliedLimitMaxDofs: BROWSER_SOLVE_LIMITS.maxDofs,
      settings: { maxIterations: options.maxIterations, tolerance: options.tolerance, preconditioner: options.preconditioner ?? "jacobi (modal default)" },
      timings: { generateMs, ...assembleSpan(progress), totalSolveMs },
      solver: {
        subspaceIterations: diagnostics.subspaceIterations,
        convergedModeCount: diagnostics.convergedModeCount,
        frequenciesHz: frequencies,
        ...(diagnostics.meshProjection ? { meshProjection: `${diagnostics.meshProjection.sourceElementOrder}->${diagnostics.meshProjection.solveElementOrder} (${diagnostics.meshProjection.solveDofs} solve DOFs)` } : {})
      },
      // solveCoreModal already rejects results that fail validateCoreResult.
      coreResultValid: true,
      heap: { method: heap.method, peakBytes: heap.peak() }
    };
  }

  const solved = solveCoreDynamic(fixture.model, options);
  const totalSolveMs = performance.now() - solveStart;
  heap.sample();
  if (!solved.ok) return fail(solved.error.message, solved.error.code, { generateMs, totalSolveMs });
  const diagnostics = solved.diagnostics;
  const iterations = diagnostics.convergence.map((entry) => entry.iterations);
  return {
    ok: true,
    caseId,
    fixture: fixtureSummary,
    analysis: "dynamic",
    appliedLimitMaxDofs: BROWSER_SOLVE_LIMITS.maxDofs,
    settings: { maxIterations: options.maxIterations, tolerance: options.tolerance, preconditioner: diagnostics.preconditioner ?? options.preconditioner ?? "jacobi (dynamic default)" },
    timings: { generateMs, ...assembleSpan(progress), totalSolveMs },
    solver: {
      frameCount: diagnostics.frameCount,
      cgIterationsTotal: iterations.reduce((sum, value) => sum + value, 0),
      cgIterationsMaxPerStep: iterations.length ? Math.max(...iterations) : 0,
      peakDisplacement: diagnostics.peakDisplacement,
      finalRelativeResidual: diagnostics.convergence.at(-1)?.relativeResidual
    },
    coreResultValid: true,
    heap: { method: heap.method, peakBytes: heap.peak() }
  };
}

function assembleSpan(progress: { assembleFirst?: number; assembleLast?: number }): { assembleMs?: number } {
  return progress.assembleFirst !== undefined && progress.assembleLast !== undefined
    ? { assembleMs: progress.assembleLast - progress.assembleFirst }
    : {};
}

function staticParity(fixture: LadderFixture, displacement: Float64Array, reactionForce: Float64Array): LadderParity {
  let tipSum = 0;
  for (const node of fixture.tipNodes) tipSum += displacement[node * 3 + 2]!;
  let maxDisplacement = 0;
  for (let node = 0; node < displacement.length / 3; node += 1) {
    const magnitude = Math.hypot(displacement[node * 3]!, displacement[node * 3 + 1]!, displacement[node * 3 + 2]!);
    if (magnitude > maxDisplacement) maxDisplacement = magnitude;
  }
  const fixedNodes = fixture.model.nodeSets.find((set) => set.name === "fixedNodes")!.nodes;
  let reactionZ = 0;
  for (const node of fixedNodes) reactionZ += reactionForce[node * 3 + 2]!;
  const appliedZ = fixture.appliedForce[2];
  return {
    tipMeanUz: tipSum / fixture.tipNodes.length,
    maxDisplacement,
    reactionZ,
    appliedZ,
    reactionBalanceRelError: Math.abs(reactionZ + appliedZ) / Math.abs(appliedZ)
  };
}
