import type { DisplayModel, Study } from "@openfea/schema";

import { studyHasGeneratedMesh } from "../runReadiness";

/**
 * Pre-run solve-time estimate (plan 036 Release A).
 *
 * APPROXIMATION. Every number this module produces is a heuristic fitted to the
 * browser solve ladder in docs/validation/solve-ladder.md (2026-10-21, Chromium
 * 141, 4-core Xeon @ 2.10 GHz container). It is a planning range, not a
 * measurement of this device: browser engine, CPU, thermal state and other tabs
 * all move the real time. It covers assembly and solve only; meshing, result
 * recovery and result upload are not included.
 *
 * Model, per analysis type and element order:
 *
 *   solveSeconds = c_block * (DOF / 30k) ^ DOF_EXPONENT * slenderness(A) * work
 *   slenderness(A) = (max(A, A_block) / A_block) ^ q
 *
 * - `c_block` is the ladder's well-conditioned (block, A = 2) time at 30k DOF.
 * - `q` is fitted so slenderness(A_slender = 50) reproduces the ladder's
 *   slender/block time ratio at the same rung.
 * - `A` is the bounding-box aspect ratio of the display model (longest over
 *   shortest extent). HEURISTIC: it sees a straight bar or a flat plate as
 *   slender, but not a thin-walled part whose bounding box is compact (an
 *   L-bracket of thin plates) or a bar running diagonally across its box.
 *   Bending-dominated slender geometry is what makes CG slow (condition number
 *   grows with L/H), so A is a proxy for conditioning, nothing more.
 * - `work` scales the ladder's workload to the study's: load cases (static),
 *   requested modes (modal) and time steps (dynamic).
 */

/** One measured ladder row: total DOF and the "Solve s" column. */
interface LadderRow {
  /** Case id as it appears in the solve-ladder table. */
  case: string;
  dofs: number;
  solveSeconds: number;
}

type LadderShape = "block" | "slender";
export type EstimateAnalysis = "static" | "modal" | "dynamic" | "thermal";
export type EstimateElementOrder = "Tet4" | "Tet10";

/**
 * Rows copied from the "Full table" of docs/validation/solve-ladder.md
 * (DOF total, Solve s). Static solve is SSOR-CG only; modal and dynamic are the
 * whole solveCore* call with the Jacobi preconditioner (3 modes; 20 Newmark steps).
 */
export const SOLVE_LADDER_ROWS: Record<"static" | "modal" | "dynamic", Record<EstimateElementOrder, Record<LadderShape, readonly LadderRow[]>>> = {
  static: {
    Tet4: {
      block: [
        { case: "block-tet4-30k-static", dofs: 29_478, solveSeconds: 1.6 },
        { case: "block-tet4-75k-static", dofs: 74_589, solveSeconds: 6.9 },
        { case: "block-tet4-150k-static", dofs: 148_857, solveSeconds: 18.5 }
      ],
      slender: [
        { case: "slender-tet4-30k-static", dofs: 29_916, solveSeconds: 27.1 },
        { case: "slender-tet4-75k-static", dofs: 74_880, solveSeconds: 99.2 },
        { case: "slender-tet4-150k-static", dofs: 150_000, solveSeconds: 295 }
      ]
    },
    Tet10: {
      block: [
        { case: "block-tet10-30k-static", dofs: 28_611, solveSeconds: 4.7 },
        { case: "block-tet10-75k-static", dofs: 74_589, solveSeconds: 22.0 },
        { case: "block-tet10-150k-static", dofs: 148_857, solveSeconds: 59.2 }
      ],
      slender: [
        { case: "slender-tet10-30k-static", dofs: 29_841, solveSeconds: 114 },
        { case: "slender-tet10-75k-static", dofs: 74_601, solveSeconds: 467 },
        { case: "slender-tet10-150k-static", dofs: 149_919, solveSeconds: 1_325 }
      ]
    }
  },
  modal: {
    Tet4: {
      block: [{ case: "block-tet4-30k-modal", dofs: 29_478, solveSeconds: 62.5 }],
      slender: [{ case: "slender-tet4-30k-modal", dofs: 29_916, solveSeconds: 1_530 }]
    },
    Tet10: {
      block: [{ case: "block-tet10-30k-modal", dofs: 28_611, solveSeconds: 103 }],
      slender: [{ case: "slender-tet10-30k-modal", dofs: 29_841, solveSeconds: 4_077 }]
    }
  },
  dynamic: {
    Tet4: {
      block: [{ case: "block-tet4-30k-dynamic", dofs: 29_478, solveSeconds: 40.0 }],
      slender: [{ case: "slender-tet4-30k-dynamic", dofs: 29_916, solveSeconds: 373 }]
    },
    Tet10: {
      block: [{ case: "block-tet10-30k-dynamic", dofs: 28_611, solveSeconds: 86.6 }],
      slender: [{ case: "slender-tet10-30k-dynamic", dofs: 29_841, solveSeconds: 883 }]
    }
  }
};

/** Reference rung the constants are normalised to. */
export const LADDER_REFERENCE_DOFS = 30_000;
/** Ladder block fixture, 200 x 100 x 100 mm: bounding-box aspect 2. */
export const LADDER_BLOCK_ASPECT_RATIO = 2;
/** Ladder slender fixture, 1000 x 20 x 20 mm (L/H = 50). */
export const LADDER_SLENDER_ASPECT_RATIO = 50;
/**
 * Time grows as DOF^1.5. Fitted from the static rows: 30k → 150k (5x DOF) costs
 * 10.9–12.6x time, i.e. exponents 1.48–1.58 across all four static variants.
 * Modal and dynamic were measured at 30k only; using the same exponent for them
 * is an extrapolation (flagged in the estimate).
 */
export const LADDER_DOF_EXPONENT = 1.5;
/** Ladder static DOF span; outside it the DOF scaling is extrapolated. */
export const LADDER_MIN_DOFS = 28_000;
export const LADDER_MAX_DOFS = 150_000;
/**
 * Assembly ("Assemble s" column): 0.4–1.2 s at 30k, 4.3–6.9 s at 150k, so about
 * 4.5e-5 s per DOF, roughly linear.
 */
export const ASSEMBLY_SECONDS_PER_DOF = 4.5e-5;
/** The ladder's modal cases requested 3 modes; the subspace block is modes + 2 (solver-cpu modal.ts). */
export const LADDER_MODAL_BLOCK_SIZE = 5;
/** The ladder's dynamic cases ran 20 Newmark steps. */
export const LADDER_DYNAMIC_STEPS = 20;
/**
 * Mirror of DEFAULT_TET10_PROJECTION_DOF_THRESHOLD in packages/solver-cpu/src/modal.ts:
 * above it a quadratic mesh is solved for modes on its corner-node Tet4 projection.
 */
export const MODAL_TET10_PROJECTION_DOF_THRESHOLD = 50_000;
/**
 * APPROXIMATION: a Tet10 mesh has about 8x the nodes of its Tet4 corner mesh
 * (one per vertex plus one per edge; a tet mesh has ~7 edges per vertex, exactly
 * 7 on the ladder's Kuhn grid).
 */
export const TET10_TO_TET4_NODE_RATIO = 8;
/**
 * Range around the central value. The ladder's own repeat noise was ~7%; the
 * spread here is for device and browser variation, which the ladder did not
 * measure (one machine, Chromium only). A fast desktop can be ~2x faster than
 * the ladder container and a laptop on battery or a phone several times slower.
 */
export const ESTIMATE_RANGE_LOW_FACTOR = 0.5;
export const ESTIMATE_RANGE_HIGH_FACTOR = 2;
/** Wider spread when any input lies outside what the ladder measured. */
export const EXTRAPOLATED_RANGE_LOW_FACTOR = 0.33;
export const EXTRAPOLATED_RANGE_HIGH_FACTOR = 3;

/**
 * HEURISTIC: bounding-box aspect ratio at or above which a part is treated as
 * slender (or thin) for warnings. At 20 the fitted model already puts static
 * solves at ~8–10x a compact part of the same DOF count.
 */
export const SLENDER_ASPECT_RATIO_THRESHOLD = 20;
/** Projected runs longer than this, on a slender part, earn a warning. */
export const LONG_RUN_WARNING_SECONDS = 120;

interface Calibration {
  /** Seconds at LADDER_REFERENCE_DOFS for the block fixture. */
  blockSeconds: number;
  /** Slenderness exponent q. */
  slendernessExponent: number;
}

/** Mean of T / (DOF / 30k)^p over the rows: the time at the 30k reference rung. */
function referenceSeconds(rows: readonly LadderRow[]): number {
  const normalised = rows.map((row) => row.solveSeconds / (row.dofs / LADDER_REFERENCE_DOFS) ** LADDER_DOF_EXPONENT);
  return normalised.reduce((sum, value) => sum + value, 0) / normalised.length;
}

function calibrate(rows: Record<LadderShape, readonly LadderRow[]>): Calibration {
  const blockSeconds = referenceSeconds(rows.block);
  const slenderSeconds = referenceSeconds(rows.slender);
  return {
    blockSeconds,
    slendernessExponent: Math.log(slenderSeconds / blockSeconds) / Math.log(LADDER_SLENDER_ASPECT_RATIO / LADDER_BLOCK_ASPECT_RATIO)
  };
}

/**
 * Fitted constants (computed from SOLVE_LADDER_ROWS, so the table stays the
 * single source). Approximate values:
 *
 * | analysis | order | c_block (s @ 30k) | q    | slender/block |
 * |----------|-------|-------------------|------|---------------|
 * | static   | Tet4  | 1.7               | 0.85 | 15.5x         |
 * | static   | Tet10 | 5.3               | 0.96 | 22x           |
 * | modal    | Tet4  | 64                | 0.99 | 24x           |
 * | modal    | Tet10 | 111               | 1.12 | 37x           |
 * | dynamic  | Tet4  | 41                | 0.69 | 9.1x          |
 * | dynamic  | Tet10 | 93                | 0.70 | 9.6x          |
 */
export const SOLVE_TIME_CALIBRATION: Record<"static" | "modal" | "dynamic", Record<EstimateElementOrder, Calibration>> = {
  static: { Tet4: calibrate(SOLVE_LADDER_ROWS.static.Tet4), Tet10: calibrate(SOLVE_LADDER_ROWS.static.Tet10) },
  modal: { Tet4: calibrate(SOLVE_LADDER_ROWS.modal.Tet4), Tet10: calibrate(SOLVE_LADDER_ROWS.modal.Tet10) },
  dynamic: { Tet4: calibrate(SOLVE_LADDER_ROWS.dynamic.Tet4), Tet10: calibrate(SOLVE_LADDER_ROWS.dynamic.Tet10) }
};

export interface SolveTimeInput {
  analysis: EstimateAnalysis;
  elementOrder: EstimateElementOrder;
  /** Mesh node count from a generated mesh. */
  nodes: number;
  /** Bounding-box aspect ratio (longest / shortest extent); null when unknown. */
  aspectRatio: number | null;
  /** Static: enabled load cases (each is one CG solve). */
  loadCaseCount?: number;
  /** Modal: requested modes. */
  modeCount?: number;
  /** Dynamic: Newmark time steps. */
  timeSteps?: number;
}

export interface SolveTimeEstimate {
  analysis: EstimateAnalysis;
  /** Element order the solve actually runs on (modal may project Tet10 to Tet4). */
  elementOrder: EstimateElementOrder;
  /** Unknowns of the mesh as generated (3 per node structural, 1 per node thermal). */
  dofs: number;
  /** Unknowns the solver works on, after any modal Tet4 projection. */
  solveDofs: number;
  modalProjectedToTet4: boolean;
  aspectRatio: number | null;
  slender: boolean;
  /** Multiplier the slenderness heuristic applied (1 for a compact part). */
  slendernessFactor: number;
  centralSeconds: number;
  lowSeconds: number;
  highSeconds: number;
  /** True when an input lies outside the measured ladder; the range is then wider. */
  extrapolated: boolean;
  extrapolationReasons: string[];
}

/** Longest over shortest bounding-box extent. HEURISTIC proxy for slenderness; null when unknown. */
export function boundingBoxAspectRatio(dimensions: DisplayModel["dimensions"] | undefined): number | null {
  if (!dimensions) return null;
  const extents = [dimensions.x, dimensions.y, dimensions.z];
  if (!extents.every((value) => Number.isFinite(value) && value > 0)) return null;
  return Math.max(...extents) / Math.min(...extents);
}

export function isSlenderAspectRatio(aspectRatio: number | null): boolean {
  return aspectRatio !== null && aspectRatio >= SLENDER_ASPECT_RATIO_THRESHOLD;
}

export function estimateSolveTime(input: SolveTimeInput): SolveTimeEstimate | null {
  if (!Number.isFinite(input.nodes) || input.nodes <= 0) return null;
  const extrapolationReasons: string[] = [];
  const thermal = input.analysis === "thermal";
  const dofs = Math.round(input.nodes * (thermal ? 1 : 3));
  let solveDofs = dofs;
  let elementOrder = input.elementOrder;
  const modalProjectedToTet4 = input.analysis === "modal" && elementOrder === "Tet10" && dofs > MODAL_TET10_PROJECTION_DOF_THRESHOLD;
  if (modalProjectedToTet4) {
    elementOrder = "Tet4";
    solveDofs = Math.max(1, Math.round(dofs / TET10_TO_TET4_NODE_RATIO));
  }

  // Thermal was not on the ladder: reuse the static SSOR constants per unknown.
  const calibration = SOLVE_TIME_CALIBRATION[input.analysis === "thermal" ? "static" : input.analysis][elementOrder];
  if (thermal) extrapolationReasons.push("Thermal solves were not benchmarked; the static structural fit is reused per unknown.");
  if (input.analysis === "modal" || input.analysis === "dynamic") {
    if (Math.abs(solveDofs - LADDER_REFERENCE_DOFS) / LADDER_REFERENCE_DOFS > 0.1) {
      extrapolationReasons.push("Modal and dynamic solves were benchmarked at about 30k DOF only.");
    }
  } else if (solveDofs < LADDER_MIN_DOFS || solveDofs > LADDER_MAX_DOFS) {
    extrapolationReasons.push("Model size is outside the benchmarked 30k–150k DOF range.");
  }

  const aspectRatio = input.aspectRatio;
  if (aspectRatio === null) extrapolationReasons.push("Model extents are unknown, so slenderness is not accounted for.");
  else if (aspectRatio > LADDER_SLENDER_ASPECT_RATIO) extrapolationReasons.push("The part is more slender than the benchmarked 50:1 bar.");
  const slendernessFactor = aspectRatio === null
    ? 1
    : (Math.max(aspectRatio, LADDER_BLOCK_ASPECT_RATIO) / LADDER_BLOCK_ASPECT_RATIO) ** calibration.slendernessExponent;

  let work = 1;
  if (input.analysis === "static" || thermal) work = Math.max(1, Math.round(input.loadCaseCount ?? 1));
  if (input.analysis === "modal") work = (Math.max(1, Math.round(input.modeCount ?? 3)) + 2) / LADDER_MODAL_BLOCK_SIZE;
  if (input.analysis === "dynamic") work = Math.max(1, Math.round(input.timeSteps ?? LADDER_DYNAMIC_STEPS)) / LADDER_DYNAMIC_STEPS;

  const solveSeconds = calibration.blockSeconds * (solveDofs / LADDER_REFERENCE_DOFS) ** LADDER_DOF_EXPONENT * slendernessFactor * work;
  const centralSeconds = solveSeconds + ASSEMBLY_SECONDS_PER_DOF * solveDofs;
  const extrapolated = extrapolationReasons.length > 0;
  return {
    analysis: input.analysis,
    elementOrder,
    dofs,
    solveDofs,
    modalProjectedToTet4,
    aspectRatio,
    slender: isSlenderAspectRatio(aspectRatio),
    slendernessFactor,
    centralSeconds,
    lowSeconds: centralSeconds * (extrapolated ? EXTRAPOLATED_RANGE_LOW_FACTOR : ESTIMATE_RANGE_LOW_FACTOR),
    highSeconds: centralSeconds * (extrapolated ? EXTRAPOLATED_RANGE_HIGH_FACTOR : ESTIMATE_RANGE_HIGH_FACTOR),
    extrapolated,
    extrapolationReasons
  };
}

export function estimateAnalysisForStudy(study: Pick<Study, "type">): EstimateAnalysis {
  if (study.type === "modal_analysis") return "modal";
  if (study.type === "dynamic_structural") return "dynamic";
  if (study.type === "steady_state_thermal") return "thermal";
  return "static";
}

/**
 * Element order the mesh carries. A generated mesh records the order it was
 * actually built with (`density.elementOrder`, which can differ from the
 * request when Tet10 would exceed the DOF ceiling); the structured block grid is
 * always Tet10. Otherwise this mirrors `requestedElementOrder` in
 * @openfea/mesh-intake (default 2), without pulling that package into the panel chunk.
 */
export function elementOrderForStudy(study: Pick<Study, "meshSettings" | "solverSettings">): EstimateElementOrder {
  const summary = study.meshSettings.summary;
  const recorded = (summary?.density as Record<string, unknown> | undefined)?.elementOrder;
  if (recorded === 1 || recorded === "1") return "Tet4";
  if (recorded === 2 || recorded === "2") return "Tet10";
  if (summary?.source === "core_solver") return "Tet10";
  const settings = study.solverSettings as Record<string, unknown> | undefined;
  const requested = settings?.elementOrder ?? settings?.meshOrder;
  return requested === 1 || requested === "1" ? "Tet4" : "Tet10";
}

function dynamicTimeSteps(study: Study): number | undefined {
  if (study.type !== "dynamic_structural") return undefined;
  const { startTime, endTime, timeStep } = study.solverSettings;
  if (![startTime, endTime, timeStep].every(Number.isFinite) || timeStep <= 0 || endTime <= startTime) return undefined;
  return Math.ceil((endTime - startTime) / timeStep - 1e-9);
}

function enabledLoadCaseCount(study: Study): number {
  if (study.type !== "static_stress" && study.type !== "dynamic_structural") return 1;
  return study.loadCases?.filter((loadCase) => loadCase.enabled !== false).length || 1;
}

/**
 * The estimate for a study as it stands. Null until a real mesh exists: preset
 * node counts are planning placeholders, and a time estimate built on them
 * would add false precision to a guess.
 */
export function solveTimeEstimateForStudy(study: Study, displayModel: Pick<DisplayModel, "dimensions"> | null | undefined): SolveTimeEstimate | null {
  if (!studyHasGeneratedMesh(study)) return null;
  const nodes = study.meshSettings.summary?.nodes;
  if (typeof nodes !== "number") return null;
  const analysis = estimateAnalysisForStudy(study);
  return estimateSolveTime({
    analysis,
    elementOrder: elementOrderForStudy(study),
    nodes,
    aspectRatio: boundingBoxAspectRatio(displayModel?.dimensions),
    loadCaseCount: enabledLoadCaseCount(study),
    ...(study.type === "modal_analysis" ? { modeCount: study.solverSettings.modeCount } : {}),
    ...(study.type === "dynamic_structural" ? { timeSteps: dynamicTimeSteps(study) } : {})
  });
}

function formatDurationPart(seconds: number): { value: number; unit: "s" | "min" | "h" } {
  if (seconds < 60) return { value: Math.max(5, Math.round(seconds / 5) * 5), unit: "s" };
  if (seconds < 90 * 60) return { value: Math.max(1, Math.round(seconds / 60)), unit: "min" };
  return { value: Math.round((seconds / 3600) * 2) / 2, unit: "h" };
}

/**
 * Coarse range text, e.g. "about 2–7 min" or "about 30 s – 2 min". Values are
 * rounded (5 s, whole minutes, half hours) so the copy does not imply precision
 * the fit does not have.
 */
export function formatSolveTimeRange(estimate: Pick<SolveTimeEstimate, "lowSeconds" | "highSeconds">): string {
  if (estimate.highSeconds < 10) return "under 10 s";
  const low = formatDurationPart(estimate.lowSeconds);
  const high = formatDurationPart(estimate.highSeconds);
  if (low.unit === high.unit) {
    return low.value === high.value ? `about ${low.value} ${low.unit}` : `about ${low.value}–${high.value} ${high.unit}`;
  }
  return `about ${low.value} ${low.unit} – ${high.value} ${high.unit}`;
}

export function formatAspectRatio(aspectRatio: number): string {
  return `${Math.round(aspectRatio)}:1`;
}
