import { describe, expect, test } from "vitest";
import { OPENFEA_MODEL_SCHEMA_VERSION, type OpenFEAModelJson } from "@openfea/core";
import {
  CooAccumulator,
  conjugateGradientConvergenceDiagnostics,
  csrMatVec,
  norm,
  solveConjugateGradient,
  solveDynamicLinearTetMDOF,
  solveStaticLinearTet,
  solveSteadyStateThermal,
  SPARSE_ALGEBRA_POLICY,
  type CsrMatrix
} from "../src";
import { createStructuredCantileverModel, dynamicLoadedModel } from "./helpers";

/**
 * Grounded 1D spring chain whose spring stiffnesses jump between exact powers
 * of ten. The large stiffness contrast makes CG's recursively updated residual
 * drift from the true residual b − Ax within a few dozen iterations.
 */
function gradedSpringChain(nodeCount: number, maxExponent: number, stride: number): CsrMatrix {
  const coo = new CooAccumulator(nodeCount);
  for (let spring = 0; spring <= nodeCount; spring += 1) {
    const stiffness = 10 ** ((spring * stride) % (maxExponent + 1));
    const left = spring - 1;
    const right = spring;
    if (left >= 0) coo.addEntry(left, left, stiffness);
    if (right < nodeCount) coo.addEntry(right, right, stiffness);
    if (left >= 0 && right < nodeCount) {
      coo.addEntry(left, right, -stiffness);
      coo.addEntry(right, left, -stiffness);
    }
  }
  return coo.finalizeCsr();
}

function chainRhs(nodeCount: number): Float64Array {
  return Float64Array.from({ length: nodeCount }, (_, index) => 1 + (index % 3));
}

function independentTrueRelativeResidual(matrix: CsrMatrix, rhs: Float64Array, solution: Float64Array): number {
  const product = csrMatVec(matrix, solution);
  const residual = rhs.map((value, index) => value - product[index]);
  return norm(residual) / norm(rhs);
}

describe("CG true-residual verification", () => {
  test("reports the true residual and partial convergence when the recursive residual drifts below tolerance", () => {
    const tolerance = SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance;
    const matrix = gradedSpringChain(48, 6, 5);
    const rhs = chainRhs(48);

    const result = solveConjugateGradient(matrix, rhs, { tolerance, preconditioner: "jacobi", maxIterations: 5_000 });

    // A drifted solve is still usable and must not fail outright.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The defect: CG's own residual claims convergence...
    expect(result.recursiveRelativeResidual).toBeLessThanOrEqual(tolerance);
    // ...but the recomputed residual does not support it, and the diagnostics say so.
    expect(result.trueRelativeResidual).toBeGreaterThan(tolerance);
    expect(result.trueRelativeResidual).toBeGreaterThan(10 * result.recursiveRelativeResidual);
    expect(result.converged).toBe(false);
    expect(result.relativeResidual).toBe(result.trueRelativeResidual);
    expect(result.trueRelativeResidual).toBeCloseTo(independentTrueRelativeResidual(matrix, rhs, result.solution), 15);
    expect(result.restartCycles).toBeGreaterThanOrEqual(1);
    expect(result.restartCycles).toBeLessThanOrEqual(SPARSE_ALGEBRA_POLICY.trueResidualRestartCycles);

    const diagnostics = conjugateGradientConvergenceDiagnostics([result]);
    expect(diagnostics.converged).toBe(false);
    expect(diagnostics.trueRelativeResidual).toBe(result.trueRelativeResidual);
    expect(diagnostics.partialConvergenceWarning).toMatch(/partially converged/);
    expect(diagnostics.partialConvergenceWarning).toContain(result.trueRelativeResidual.toExponential(2));
  });

  test("recovers the requested tolerance by restarting from the true residual", () => {
    const tolerance = SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance;
    const matrix = gradedSpringChain(48, 4, 3);
    const rhs = chainRhs(48);

    const result = solveConjugateGradient(matrix, rhs, { tolerance, preconditioner: "jacobi", maxIterations: 5_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restartCycles).toBeGreaterThanOrEqual(1);
    expect(result.converged).toBe(true);
    expect(result.trueRelativeResidual).toBeLessThanOrEqual(tolerance);
    expect(independentTrueRelativeResidual(matrix, rhs, result.solution)).toBeLessThanOrEqual(tolerance);
    expect(conjugateGradientConvergenceDiagnostics([result]).partialConvergenceWarning).toBeUndefined();
  });

  test("bounds restart work to a fraction of the first cycle", () => {
    const matrix = gradedSpringChain(96, 8, 5);
    const rhs = chainRhs(96);
    let firstRecursiveConvergence: number | undefined;
    const tolerance = SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance;
    const result = solveConjugateGradient(matrix, rhs, {
      tolerance,
      preconditioner: "ssor",
      maxIterations: 5_000,
      hooks: {
        onProgress: (event) => {
          // The restart emits the (above-tolerance) true residual off the 25-iteration cadence.
          if (firstRecursiveConvergence === undefined && event.iteration !== undefined && event.iteration % 25 !== 0) {
            firstRecursiveConvergence = event.iteration;
          }
        }
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok || firstRecursiveConvergence === undefined) throw new Error("expected a restarted solve");
    expect(result.converged).toBe(false);
    const perCycle = Math.ceil(SPARSE_ALGEBRA_POLICY.trueResidualRestartIterationFraction * firstRecursiveConvergence);
    expect(result.iterations).toBeLessThanOrEqual(firstRecursiveConvergence + result.restartCycles * perCycle);
  });

  test("well-conditioned solves stay converged with matching residuals and no restarts", () => {
    const coo = new CooAccumulator(3);
    for (const [row, col, value] of [[0, 0, 4], [0, 1, -1], [1, 0, -1], [1, 1, 4], [1, 2, -1], [2, 1, -1], [2, 2, 3]] as const) {
      coo.addEntry(row, col, value);
    }
    const result = solveConjugateGradient(coo.finalizeCsr(), new Float64Array([15, 10, 10]), { tolerance: 1e-12, preconditioner: "ssor" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.converged).toBe(true);
    expect(result.restartCycles).toBe(0);
    expect(result.trueRelativeResidual).toBeLessThanOrEqual(1e-12);
    expect(result.recursiveRelativeResidual).toBeLessThanOrEqual(1e-12);
  });

  test("summarizes several solves by their worst true residual", () => {
    const sample = { recursiveRelativeResidual: 5e-11, tolerance: 1e-10, restartCycles: 1 };
    const summary = conjugateGradientConvergenceDiagnostics([
      { ...sample, trueRelativeResidual: 8e-11, converged: true },
      { ...sample, trueRelativeResidual: 3e-7, converged: false },
      { ...sample, trueRelativeResidual: 2e-8, converged: false }
    ], "Dynamic Newmark CG");

    expect(summary.converged).toBe(false);
    expect(summary.trueRelativeResidual).toBe(3e-7);
    expect(summary.trueResidualRestarts).toBe(3);
    expect(summary.partialConvergenceWarning).toContain("2 of 3 linear solves");
    expect(summary.partialConvergenceWarning).toContain("3.00e-7");
    expect(conjugateGradientConvergenceDiagnostics([])).toEqual({
      converged: true,
      trueRelativeResidual: 0,
      recursiveRelativeResidual: 0,
      trueResidualRestarts: 0
    });
  });
});

describe("static solve convergence diagnostics", () => {
  test("labels a slender cantilever whose true residual stays above tolerance instead of claiming convergence", () => {
    // 40:1 slender Tet4 cantilever: SSOR-CG's recursive residual reaches the
    // default tolerance while ‖Ku − f‖/‖f‖ stays above it (docs/validation/solve-ladder.md finding 3).
    const model = createStructuredCantileverModel({ length: 40, width: 1, height: 1, force: 100, xDivisions: 40, yDivisions: 1, zDivisions: 1 });
    const result = solveStaticLinearTet(model, { method: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagnostics = result.diagnostics;
    const tolerance = SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance;
    expect(diagnostics.recursiveRelativeResidual).toBeLessThanOrEqual(tolerance);
    expect(diagnostics.trueRelativeResidual).toBeGreaterThan(tolerance);
    // No prescribed displacements, so the full-model and reduced-system true residuals agree.
    expect(diagnostics.relativeResidual).toBeCloseTo(diagnostics.trueRelativeResidual ?? Number.NaN, 15);
    expect(diagnostics.converged).toBe(false);
    expect(diagnostics.partialConvergenceWarning).toMatch(/^Static sparse CG partially converged/);
    // The warning travels with the solver diagnostics in the Core result, where reports read it.
    const coreDiagnostics = result.result.coreResult?.diagnostics as Array<{ partialConvergenceWarning?: string }>;
    expect(coreDiagnostics.some((entry) => entry.partialConvergenceWarning === diagnostics.partialConvergenceWarning)).toBe(true);
  });

  test("keeps well-conditioned static solves converged without a warning", () => {
    const model = createStructuredCantileverModel({ length: 4, width: 1, height: 1, force: 100, xDivisions: 4, yDivisions: 1, zDivisions: 1 });
    const result = solveStaticLinearTet(model, { method: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.converged).toBe(true);
    expect(result.diagnostics.trueRelativeResidual).toBeLessThanOrEqual(SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance);
    expect(result.diagnostics.partialConvergenceWarning).toBeUndefined();
  });
});

describe("thermal and dynamic convergence diagnostics", () => {
  test("steady thermal reports the true residual alongside the recursive one", () => {
    const model: OpenFEAModelJson = {
      schema: "opencae.model",
      schemaVersion: OPENFEA_MODEL_SCHEMA_VERSION,
      nodes: { coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      materials: [{ name: "solid", type: "isotropicLinearElastic", youngModulus: 1, poissonRatio: 0.25, thermalConductivity: 10 }],
      elementBlocks: [{ name: "solid", type: "Tet4", material: "solid", connectivity: [0, 1, 2, 3] }],
      nodeSets: [{ name: "cold", nodes: [0, 2] }, { name: "hot", nodes: [1] }],
      elementSets: [],
      boundaryConditions: [
        { name: "cold-temperature", type: "prescribedTemperature", nodeSet: "cold", value: 0 },
        { name: "hot-temperature", type: "prescribedTemperature", nodeSet: "hot", value: 100 }
      ],
      loads: [],
      steps: [{ name: "conduction", type: "steadyStateThermal", boundaryConditions: ["cold-temperature", "hot-temperature"], loads: [] }]
    };
    const solved = solveSteadyStateThermal(model);

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.diagnostics.freeDofs).toBe(1);
    expect(solved.diagnostics.converged).toBe(true);
    expect(solved.diagnostics.relativeResidual).toBe(solved.diagnostics.trueRelativeResidual);
    expect(solved.diagnostics.trueRelativeResidual).toBeLessThanOrEqual(SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance);
    expect(typeof solved.diagnostics.recursiveRelativeResidual).toBe("number");
    expect(solved.diagnostics.partialConvergenceWarning).toBeUndefined();
  });

  test("dynamic Newmark diagnostics gate converged on every step's true residual", () => {
    const solved = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"));

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.diagnostics.converged).toBe(true);
    expect(solved.diagnostics.trueRelativeResidual).toBeLessThanOrEqual(SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance);
    expect(solved.diagnostics.partialConvergenceWarning).toBeUndefined();
  });
});
