import { describe, expect, test } from "vitest";
import {
  elevateTet4MeshToTet10,
  normalizeModelJson,
  validateCoreResult,
  type OpenFEAModelJson
} from "@openfea/core";
import { singleTetStaticFixture } from "@openfea/examples";
import { linearizeTet10ModelForModal, solveModalLinearTet, solveModalSubspace, toCsrMatrix, createSparseMatrixBuilder, addSparseEntry } from "../src";
import { assembleLumpedMass, prepareStructuralSystem, type PreparedStructuralSystem } from "../src/structural-system";
import { createSlenderSquareCantileverModal } from "./helpers";

function diagonalSystem(stiffness: number[], mass: number[]): PreparedStructuralSystem {
  const builder = createSparseMatrixBuilder(stiffness.length);
  stiffness.forEach((value, index) => addSparseEntry(builder, index, index, value));
  const matrix = toCsrMatrix(builder);
  return {
    stiffness: matrix,
    fullStiffness: matrix,
    fullLoad: new Float64Array(stiffness.length),
    load: new Float64Array(stiffness.length),
    mass: Float64Array.from(mass),
    fullMass: Float64Array.from(mass),
    totalMass: mass.reduce((sum, value) => sum + value, 0) / 3,
    free: Int32Array.from(stiffness.map((_value, index) => index)),
    constraints: new Map()
  };
}

const modalFixture: OpenFEAModelJson = {
  ...singleTetStaticFixture,
  schemaVersion: "0.3.0",
  materials: [{ ...singleTetStaticFixture.materials[0], density: 1200 }],
  loads: [],
  steps: [{
    name: "modes",
    type: "modal",
    boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
    modeCount: 3
  }]
};

describe("block shift-invert modal solver", () => {
  test("solves exact generalized eigenproblems with scaled residuals and M-orthogonality", () => {
    const system = diagonalSystem([4, 18, 48], [1, 2, 3]);
    const solved = solveModalSubspace(system, 3);

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.modes.map((mode) => mode.eigenvalue)).toEqual(expect.arrayContaining([
      expect.closeTo(4, 10),
      expect.closeTo(9, 10),
      expect.closeTo(16, 10)
    ]));
    for (const mode of solved.modes) expect(mode.scaledResidual).toBeLessThanOrEqual(1e-6);
    for (let left = 0; left < solved.modes.length; left += 1) {
      for (let right = 0; right < solved.modes.length; right += 1) {
        const product = massDot(system.mass, solved.modes[left].vector, solved.modes[right].vector);
        expect(product).toBeCloseTo(left === right ? 1 : 0, 10);
      }
    }
  });

  test("retains a repeated-mode subspace deterministically", () => {
    const first = solveModalSubspace(diagonalSystem([4, 4, 9, 16], [1, 1, 1, 1]), 3);
    const second = solveModalSubspace(diagonalSystem([4, 4, 9, 16], [1, 1, 1, 1]), 3);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.modes.map((mode) => mode.eigenvalue)).toEqual(second.modes.map((mode) => mode.eigenvalue));
    expect(first.modes[0].eigenvalue).toBeCloseTo(4, 10);
    expect(first.modes[1].eigenvalue).toBeCloseTo(4, 10);
    expect(Math.abs(dot(first.modes[0].vector, first.modes[1].vector))).toBeLessThan(1e-10);
  });

  test("converges all six requested modes including nearly repeated pairs", () => {
    const eigenvalues = [4, 4 + 1e-8, 16, 16 + 1e-8, 64, 100, 256, 1024];
    const system = diagonalSystem(eigenvalues, eigenvalues.map(() => 1));
    const solved = solveModalSubspace(system, 6);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.requestedModeCount).toBe(6);
    expect(solved.modes).toHaveLength(6);
    expect(solved.warning).toBeUndefined();
    solved.modes.forEach((mode, index) => {
      expect(mode.modeIndex).toBe(index + 1);
      expect(mode.eigenvalue).toBeCloseTo(eigenvalues[index], 7);
      expect(mode.scaledResidual).toBeLessThanOrEqual(1e-6);
      for (let other = 0; other < solved.modes.length; other += 1) {
        expect(massDot(system.mass, mode.vector, solved.modes[other].vector)).toBeCloseTo(index === other ? 1 : 0, 9);
      }
    });
  });

  test("accepts a tolerance below machine precision at the rounding floor instead of dropping every mode", () => {
    const system = diagonalSystem([4, 18, 48, 100, 300], [1, 2, 3, 1, 1]);
    const solved = solveModalSubspace(system, 3, { tolerance: 1e-17 });

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    // Before the floor-aware test this ran all 30 passes and returned no modes.
    expect(solved.modes).toHaveLength(3);
    expect(solved.warning).toBeUndefined();
    expect(solved.subspaceIterations).toBeLessThan(30);
    expect(solved.modes.map((mode) => mode.eigenvalue)).toEqual([
      expect.closeTo(4, 12),
      expect.closeTo(9, 12),
      expect.closeTo(16, 12)
    ]);
    expect(solved.precisionLimitedModes?.map((mode) => mode.modeIndex)).toEqual([1, 2, 3]);
    for (const mode of solved.modes) {
      expect(mode.scaledResidual).toBeLessThanOrEqual(mode.residualFloor);
      // gamma_n for a 1-entry row plus the mass term: a few machine epsilons.
      expect(mode.residualFloor).toBeLessThan(8 * Number.EPSILON);
    }
    expect(solved.precisionLimitWarning).toContain("double-precision residual floor");
  });

  test("keeps the requested tolerance and reports no precision limit on well-conditioned systems", () => {
    const solved = solveModalSubspace(diagonalSystem([4, 18, 48, 100, 300], [1, 2, 3, 1, 1]), 3);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.subspaceIterations).toBe(1);
    expect(solved.precisionLimitedModes).toBeUndefined();
    expect(solved.precisionLimitWarning).toBeUndefined();
    for (const mode of solved.modes) expect(mode.scaledResidual).toBeLessThanOrEqual(1e-6);
  });

  test(
    "converges the near-degenerate first bending pair of a slender cantilever below its rounding floor",
    { timeout: 30_000 },
    () => {
      const solved = slenderModalSolve("mm");
      expect(solved.ok).toBe(true);
      if (!solved.ok) return;
      const { diagnostics, result } = solved;
      // Before the fix this fixture reproduced solve-ladder finding 4: all 30
      // passes ran, the y/z pair stalled above the requested 1e-8 and only
      // mode 3 was returned with a partial-convergence warning.
      expect(diagnostics.requestedModeCount).toBe(3);
      expect(diagnostics.convergedModeCount).toBe(3);
      expect(diagnostics.partialConvergenceWarning).toBeUndefined();
      expect(diagnostics.subspaceIterations).toBeLessThan(SLENDER_MODAL_ITERATION_CAP);
      expect(result.modes.map((mode) => mode.modeIndex)).toEqual([1, 2, 3]);

      // The pair is accepted at its floor, labeled, and nothing else is.
      const limited = diagnostics.precisionLimitedModes ?? [];
      expect(limited.map((mode) => mode.modeIndex)).toEqual([1, 2]);
      for (const mode of limited) {
        expect(mode.scaledResidual).toBeGreaterThan(SLENDER_MODAL_TOLERANCE);
        expect(mode.scaledResidual).toBeLessThanOrEqual(mode.residualFloor);
      }
      expect(result.modes[2].scaledResidual).toBeLessThanOrEqual(SLENDER_MODAL_TOLERANCE);
      expect(diagnostics.precisionLimitWarning).toContain("modes 1, 2");
      expect(result.coreResult?.summary.warning).toContain("double-precision residual floor");
      expect(validateCoreResult(result.coreResult!).ok).toBe(true);

      // Near-degenerate y/z pair, then the first second-bending mode.
      const [first, second, third] = result.modes.map((mode) => mode.frequencyHz);
      expect(Math.abs(second - first) / first).toBeLessThan(0.01);
      expect(relativeError(first, eulerBernoulliCantileverHz(0))).toBeLessThan(SLENDER_TET10_EULER_BERNOULLI_TOLERANCE);
      expect(relativeError(second, eulerBernoulliCantileverHz(0))).toBeLessThan(SLENDER_TET10_EULER_BERNOULLI_TOLERANCE);
      expect(relativeError(third, eulerBernoulliCantileverHz(1))).toBeLessThan(SLENDER_TET10_EULER_BERNOULLI_TOLERANCE);
    }
  );

  test("returns unit-independent slender frequencies and floors in mm-N-s-MPa and m-N-s-Pa", { timeout: 30_000 }, () => {
    const millimetre = slenderModalSolve("mm");
    const metre = slenderModalSolve("m");
    expect(millimetre.ok && metre.ok).toBe(true);
    if (!millimetre.ok || !metre.ok) return;
    expect(metre.diagnostics.convergedModeCount).toBe(millimetre.diagnostics.convergedModeCount);
    expect(metre.result.modes.map((mode) => mode.modeIndex)).toEqual(millimetre.result.modes.map((mode) => mode.modeIndex));
    millimetre.result.modes.forEach((mode, index) => {
      expect(relativeError(metre.result.modes[index].frequencyHz, mode.frequencyHz)).toBeLessThan(MODAL_UNIT_EQUIVALENCE_TOLERANCE);
    });
    const floors = (solve: typeof millimetre) => solve.ok ? (solve.diagnostics.precisionLimitedModes ?? []) : [];
    expect(floors(metre).map((mode) => mode.modeIndex)).toEqual(floors(millimetre).map((mode) => mode.modeIndex));
    floors(millimetre).forEach((mode, index) => {
      // The floor is a dimensionless ratio of stiffness products, so it does
      // not scale with units. It is not rotation-invariant inside the
      // near-degenerate pair, and rounding can rotate the y/z split slightly
      // (about 1% here), so compare magnitudes, not digits.
      const ratio = floors(metre)[index].residualFloor / mode.residualFloor;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);
    });
  });

  test("maps singular constrained systems to the supports-step diagnostic", () => {
    const solved = solveModalSubspace(diagonalSystem([4, 0, 9], [1, 1, 1]), 2);
    expect(solved.ok).toBe(false);
    expect(solved.ok ? undefined : solved.error.code).toBe("insufficient-modal-constraints");
    expect(solved.ok ? undefined : solved.error.message).toContain("Supports step");
  });

  test("honors cooperative cancellation between subspace iterations", () => {
    const solved = solveModalSubspace(diagonalSystem([4, 9, 16], [1, 1, 1]), 2, { hooks: { shouldCancel: () => true } });
    expect(solved.ok).toBe(false);
    expect(solved.ok ? undefined : solved.error.code).toBe("cancelled");
  });

  test("reports nested CG work against the enclosing modal workload", () => {
    const progress: Array<{ completed: number; total: number; iteration?: number }> = [];
    const solved = solveModalSubspace(diagonalSystem([4, 9, 16], [1, 1, 1]), 2, {
      maxCgIterations: 10_000,
      hooks: { onProgress: (event) => progress.push(event) }
    });

    expect(solved.ok).toBe(true);
    expect(progress.some((event) => event.iteration !== undefined)).toBe(true);
    expect(progress.every((event) => event.total === 30)).toBe(true);
    expect(progress.every((event) => event.completed >= 0 && event.completed <= event.total)).toBe(true);
  });

  test("exports normalized signed vector mode shapes and a valid modal result contract", () => {
    const solved = solveModalLinearTet(modalFixture, { maxDofs: 100_000 });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.result.modes.length).toBeGreaterThan(0);
    for (const mode of solved.result.modes) {
      let maxVector = 0;
      let largestComponent = 0;
      for (let node = 0; node < mode.shape.length / 3; node += 1) {
        maxVector = Math.max(maxVector, Math.hypot(mode.shape[node * 3], mode.shape[node * 3 + 1], mode.shape[node * 3 + 2]));
      }
      for (const component of mode.shape) {
        if (Math.abs(component) > Math.abs(largestComponent)) largestComponent = component;
      }
      expect(maxVector).toBeCloseTo(1, 10);
      expect(largestComponent).toBeGreaterThan(0);
    }
    expect(solved.result.coreResult?.analysisType).toBe("modal_analysis");
    expect(validateCoreResult(solved.result.coreResult!).ok).toBe(true);
  });

  test("conserves Tet4 and Tet10 mass under shared HRZ assembly", () => {
    const tet4 = normalizeModelJson(modalFixture);
    expect(tet4.ok).toBe(true);
    if (!tet4.ok) return;
    const tet4Mass = assembleLumpedMass(tet4.model, "Modal");
    expect(tet4Mass.ok).toBe(true);
    if (!tet4Mass.ok) return;
    expect(tet4Mass.totalMass).toBeCloseTo(200, 10);

    const elevated = elevateTet4MeshToTet10({
      coordinates: modalFixture.nodes.coordinates,
      elements: [modalFixture.elementBlocks[0].connectivity]
    });
    const tet10Model: OpenFEAModelJson = {
      ...modalFixture,
      nodes: { coordinates: elevated.coordinates },
      elementBlocks: [{ ...modalFixture.elementBlocks[0], type: "Tet10", connectivity: elevated.elements.flat() }]
    };
    const tet10 = normalizeModelJson(tet10Model);
    expect(tet10.ok).toBe(true);
    if (!tet10.ok) return;
    const tet10Mass = assembleLumpedMass(tet10.model, "Modal");
    expect(tet10Mass.ok).toBe(true);
    if (!tet10Mass.ok) return;
    expect(tet10Mass.totalMass).toBeCloseTo(tet4Mass.totalMass, 10);
  });

  test("projects oversized Tet10 modal meshes to explicit corner-node Tet4 models", () => {
    const elevated = elevateTet4MeshToTet10({
      coordinates: modalFixture.nodes.coordinates,
      elements: [modalFixture.elementBlocks[0].connectivity]
    });
    const normalized = normalizeModelJson({
      ...modalFixture,
      nodes: { coordinates: elevated.coordinates },
      elementBlocks: [{ ...modalFixture.elementBlocks[0], type: "Tet10", connectivity: elevated.elements.flat() }]
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const projected = linearizeTet10ModelForModal(normalized.model, 1);
    expect(projected.projection).toEqual({
      sourceElementOrder: "Tet10",
      solveElementOrder: "Tet4",
      sourceDofs: normalized.model.counts.nodes * 3,
      solveDofs: modalFixture.nodes.coordinates.length,
      reason: "local-modal-performance"
    });
    expect(projected.model.elementBlocks[0].type).toBe("Tet4");
    expect(Array.from(projected.model.elementBlocks[0].connectivity)).toEqual(modalFixture.elementBlocks[0].connectivity);
    expect(projected.model.surfaceFacets.every((facet) => facet.nodes.length === 3)).toBe(true);
    expect(projected.model.counts.elements).toBe(normalized.model.counts.elements);
  });

  test("reports source and solved DOFs and applies the shared cap to the solved model", () => {
    const solved = solveModalLinearTet(modalFixture, { modeCount: 1 });

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.diagnostics.dofLimit).toEqual({
      maximum: 150_000,
      appliedTo: "solve_model",
      sourceDofs: 12,
      solveDofs: 12
    });
  });

  test("keeps the compatibility frequency estimate within modal calibration tolerance", () => {
    const system = diagonalSystem([4, 100, 400], [1, 1, 1]);
    system.load.set([1, 1, 1]);
    const compatibility = solveModalSubspace(system, 1, {
      frequencyEstimateSeed: system.load,
      frequencyEstimateIterations: 4
    });
    const modal = solveModalSubspace(system, 1);
    expect(compatibility.ok && modal.ok).toBe(true);
    if (!compatibility.ok || !modal.ok) return;
    const compatibilityOmega = Math.sqrt(compatibility.modes[0].eigenvalue);
    const modalOmega = Math.sqrt(modal.modes[0].eigenvalue);
    expect(Math.abs(compatibilityOmega - modalOmega) / modalOmega).toBeLessThan(1e-6);
  });
});

/**
 * Slender square cantilever, L/H = 50, the solve-ladder "slender" shape at test
 * size: Tet10, 7 cells along the axis and one Kuhn-split cell per section
 * (405 DOFs). Tet10 is used because Tet4 at test-sized meshes locks in bending
 * (26.0 Hz against 16.3 Hz at 1,377 DOFs), which would swamp the check. Its
 * y/z bending pair is near-degenerate (16.60 / 16.66 Hz) and its rounding floor
 * (scaled residual ~8e-8 under Jacobi-CG) sits above SLENDER_MODAL_TOLERANCE.
 * That reproduces at test size the 30k-DOF ladder case, where the same pair
 * stalled at 2.5e-6 / 2.0e-6 against the 1e-6 default: before the fix this
 * fixture ran all 30 passes and returned only mode 3.
 */
const SLENDER_MODAL_TOLERANCE = 1e-8;
const SLENDER_MODAL_ITERATION_CAP = 30;
/**
 * The coarse 7-cell Tet10 mesh is 1.8% / 2.2% (first bending pair) and 3.2%
 * (second bending) stiffer than Euler-Bernoulli (16.31 / 102.20 Hz). Beam
 * theory also omits shear and rotary inertia, about 0.1% at L/H = 50. 4%
 * bounds the discretization error without admitting a wrong mode: the next
 * mode family is six times higher.
 */
const SLENDER_TET10_EULER_BERNOULLI_TOLERANCE = 0.04;
/**
 * Units change only rounding. The Rayleigh quotients of these slender modes
 * carry the same cancellation as their residuals (eps x rounding scale, about
 * 1e-9 here), so frequencies agree to ~1e-9, not to machine precision. A unit
 * conversion error would be off by orders of magnitude.
 */
const MODAL_UNIT_EQUIVALENCE_TOLERANCE = 1e-7;
/** Clamped-free roots beta_n * L of cos(bL) cosh(bL) = -1. */
const CANTILEVER_BETA_L = [1.8751040687119611, 4.6940911329741745];

const slenderSolves = new Map<"mm" | "m", ReturnType<typeof solveModalLinearTet>>();

function slenderModalSolve(units: "mm" | "m"): ReturnType<typeof solveModalLinearTet> {
  const cached = slenderSolves.get(units);
  if (cached) return cached;
  const solved = solveModalLinearTet(
    createSlenderSquareCantileverModal({ xDivisions: 7, sectionDivisions: 1, order: "Tet10", units, modeCount: 3 }),
    { modalTolerance: SLENDER_MODAL_TOLERANCE, maxSubspaceIterations: SLENDER_MODAL_ITERATION_CAP }
  );
  slenderSolves.set(units, solved);
  return solved;
}

/** Euler-Bernoulli bending frequency of the 1000 x 20 x 20 mm steel cantilever (Hz). */
function eulerBernoulliCantileverHz(modeNumber: number): number {
  const length = 1000;
  const side = 20;
  const youngModulus = 200_000;
  const density = 7.85e-9;
  const secondMoment = side ** 4 / 12;
  const betaL = CANTILEVER_BETA_L[modeNumber];
  return (betaL ** 2 / (2 * Math.PI * length ** 2)) * Math.sqrt((youngModulus * secondMoment) / (density * side * side));
}

function relativeError(value: number, reference: number): number {
  return Math.abs(value - reference) / Math.abs(reference);
}

function massDot(mass: Float64Array, left: Float64Array, right: Float64Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += mass[index] * left[index] * right[index];
  return result;
}

function dot(left: Float64Array, right: Float64Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}
