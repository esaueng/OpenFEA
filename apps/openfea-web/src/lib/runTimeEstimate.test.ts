import { describe, expect, test } from "vitest";
import { StudySchema, type Study } from "@openfea/schema";

import {
  ASSEMBLY_SECONDS_PER_DOF,
  LADDER_BLOCK_ASPECT_RATIO,
  LADDER_SLENDER_ASPECT_RATIO,
  LONG_RUN_WARNING_SECONDS,
  SLENDER_ASPECT_RATIO_THRESHOLD,
  SOLVE_LADDER_ROWS,
  boundingBoxAspectRatio,
  elementOrderForStudy,
  estimateSolveTime,
  formatSolveTimeRange,
  solveTimeEstimateForStudy,
  type EstimateAnalysis,
  type EstimateElementOrder
} from "./runTimeEstimate";

/**
 * The fit is a DOF^1.5 power law through 1–3 rows per variant. It must land
 * every measured static row within this relative error of the ladder's solve
 * time (the 30k–150k static rows deviate up to ~9% from the fit; the ladder's
 * own run-to-run noise was ~7%).
 */
const LADDER_FIT_REL_TOL = 0.12;

// The ladder's fixtures, by bounding box (mm): block 200 x 100 x 100, slender 1000 x 20 x 20.
const BLOCK_DIMENSIONS = { x: 200, y: 100, z: 100, units: "mm" };
const SLENDER_DIMENSIONS = { x: 1000, y: 20, z: 20, units: "mm" };

const STRUCTURAL: Array<"static" | "modal" | "dynamic"> = ["static", "modal", "dynamic"];

function ladderEstimate(analysis: "static" | "modal" | "dynamic", order: EstimateElementOrder, shape: "block" | "slender", dofs: number) {
  return estimateSolveTime({
    analysis,
    elementOrder: order,
    nodes: dofs / 3,
    aspectRatio: shape === "block" ? LADDER_BLOCK_ASPECT_RATIO : LADDER_SLENDER_ASPECT_RATIO,
    modeCount: 3,
    timeSteps: 20
  })!;
}

describe("solve-time estimate calibration against the solve ladder", () => {
  test.each(STRUCTURAL.flatMap((analysis) => (["Tet4", "Tet10"] as const).flatMap((order) => (["block", "slender"] as const).flatMap((shape) =>
    SOLVE_LADDER_ROWS[analysis][order][shape].map((row) => ({ analysis, order, shape, row }))))))("reproduces $row.case", ({ analysis, order, shape, row }) => {
    const estimate = ladderEstimate(analysis, order, shape, row.dofs);
    // Assembly is added on top of the solve column; compare the solve part.
    const solveSeconds = estimate.centralSeconds - ASSEMBLY_SECONDS_PER_DOF * estimate.solveDofs;
    expect(Math.abs(solveSeconds - row.solveSeconds) / row.solveSeconds).toBeLessThan(LADDER_FIT_REL_TOL);
    // The measured value always sits inside the presented range.
    expect(row.solveSeconds).toBeGreaterThanOrEqual(estimate.lowSeconds);
    expect(row.solveSeconds).toBeLessThanOrEqual(estimate.highSeconds);
  });

  test.each(STRUCTURAL.flatMap((analysis) => (["Tet4", "Tet10"] as const).map((order) => ({ analysis, order }))))("slender is slower than block for $analysis $order at the same DOF", ({ analysis, order }) => {
    const block = ladderEstimate(analysis, order, "block", 30_000);
    const slender = ladderEstimate(analysis, order, "slender", 30_000);
    // Ladder: static 15–22x, modal 24–37x, dynamic 9–10x.
    expect(slender.centralSeconds / block.centralSeconds).toBeGreaterThan(8);
    expect(slender.slender).toBe(true);
    expect(block.slender).toBe(false);
    expect(block.slendernessFactor).toBe(1);
  });

  test("Tet10 costs more than Tet4 at the same DOF and shape", () => {
    for (const analysis of STRUCTURAL) {
      expect(ladderEstimate(analysis, "Tet10", "slender", 30_000).centralSeconds).toBeGreaterThan(ladderEstimate(analysis, "Tet4", "slender", 30_000).centralSeconds);
    }
  });

  test("slender Tet10 static at the 150k ceiling projects past 20 minutes, block under 2", () => {
    expect(ladderEstimate("static", "Tet10", "slender", 150_000).centralSeconds).toBeGreaterThan(20 * 60);
    expect(ladderEstimate("static", "Tet10", "block", 150_000).centralSeconds).toBeLessThan(LONG_RUN_WARNING_SECONDS);
  });

  test("time grows monotonically with DOF and with aspect ratio", () => {
    const at = (nodes: number, aspectRatio: number) => estimateSolveTime({ analysis: "static", elementOrder: "Tet10", nodes, aspectRatio })!.centralSeconds;
    expect(at(20_000, 10)).toBeLessThan(at(40_000, 10));
    expect(at(20_000, 5)).toBeLessThan(at(20_000, 20));
    // Stubbier than the ladder block is not credited as faster than it.
    expect(at(20_000, 1)).toBe(at(20_000, LADDER_BLOCK_ASPECT_RATIO));
  });

  test("scales modal by requested modes and dynamic by time steps", () => {
    const modal = (modeCount: number) => estimateSolveTime({ analysis: "modal", elementOrder: "Tet4", nodes: 10_000, aspectRatio: 2, modeCount })!.centralSeconds;
    const dynamic = (timeSteps: number) => estimateSolveTime({ analysis: "dynamic", elementOrder: "Tet4", nodes: 10_000, aspectRatio: 2, timeSteps })!.centralSeconds;
    expect(modal(8)).toBeGreaterThan(modal(3));
    expect(dynamic(200)).toBeGreaterThan(5 * dynamic(20));
  });

  test("a large quadratic modal mesh is estimated on its Tet4 projection", () => {
    const estimate = estimateSolveTime({ analysis: "modal", elementOrder: "Tet10", nodes: 40_000, aspectRatio: 2, modeCount: 3 })!;
    expect(estimate.modalProjectedToTet4).toBe(true);
    expect(estimate.elementOrder).toBe("Tet4");
    expect(estimate.solveDofs).toBeLessThan(estimate.dofs);
    const small = estimateSolveTime({ analysis: "modal", elementOrder: "Tet10", nodes: 10_000, aspectRatio: 2, modeCount: 3 })!;
    expect(small.modalProjectedToTet4).toBe(false);
    expect(small.elementOrder).toBe("Tet10");
  });

  test("thermal uses one unknown per node and is labelled as extrapolated", () => {
    const thermal = estimateSolveTime({ analysis: "thermal", elementOrder: "Tet10", nodes: 50_000, aspectRatio: 2 })!;
    const structural = estimateSolveTime({ analysis: "static", elementOrder: "Tet10", nodes: 50_000, aspectRatio: 2 })!;
    expect(thermal.dofs).toBe(50_000);
    expect(structural.dofs).toBe(150_000);
    expect(thermal.extrapolated).toBe(true);
    expect(thermal.extrapolationReasons.join(" ")).toContain("Thermal solves were not benchmarked");
    expect(structural.extrapolated).toBe(false);
    expect(thermal.highSeconds / thermal.lowSeconds).toBeGreaterThan(structural.highSeconds / structural.lowSeconds);
  });

  test("unknown extents fall back to the compact-part fit with a wider range", () => {
    const estimate = estimateSolveTime({ analysis: "static", elementOrder: "Tet4", nodes: 20_000, aspectRatio: null })!;
    expect(estimate.slender).toBe(false);
    expect(estimate.slendernessFactor).toBe(1);
    expect(estimate.extrapolated).toBe(true);
  });

  test("returns no estimate without a node count", () => {
    expect(estimateSolveTime({ analysis: "static", elementOrder: "Tet4", nodes: 0, aspectRatio: 2 })).toBeNull();
  });
});

describe("bounding-box slenderness heuristic", () => {
  test("measures the ladder fixtures as 2:1 and 50:1", () => {
    expect(boundingBoxAspectRatio(BLOCK_DIMENSIONS)).toBe(2);
    expect(boundingBoxAspectRatio(SLENDER_DIMENSIONS)).toBe(50);
  });

  test("treats a thin plate as slender and ignores unusable extents", () => {
    expect(boundingBoxAspectRatio({ x: 200, y: 200, z: 5, units: "mm" })).toBeGreaterThanOrEqual(SLENDER_ASPECT_RATIO_THRESHOLD);
    expect(boundingBoxAspectRatio({ x: 200, y: 0, z: 5, units: "mm" })).toBeNull();
    expect(boundingBoxAspectRatio(undefined)).toBeNull();
  });
});

describe("range formatting", () => {
  test("rounds to coarse units instead of implying precision", () => {
    expect(formatSolveTimeRange({ lowSeconds: 1, highSeconds: 6 })).toBe("under 10 s");
    expect(formatSolveTimeRange({ lowSeconds: 12, highSeconds: 47 })).toBe("about 10–45 s");
    expect(formatSolveTimeRange({ lowSeconds: 33, highSeconds: 132 })).toBe("about 35 s – 2 min");
    expect(formatSolveTimeRange({ lowSeconds: 660, highSeconds: 2640 })).toBe("about 11–44 min");
    expect(formatSolveTimeRange({ lowSeconds: 2056, highSeconds: 8222 })).toBe("about 34 min – 2.5 h");
  });
});

const baseStudy = StudySchema.parse({
  id: "study-estimate",
  projectId: "project-estimate",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [],
  materialAssignments: [],
  namedSelections: [],
  contacts: [],
  constraints: [],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
});

function meshedStudy(type: Study["type"], nodes: number, elementOrder?: 1 | 2): Study {
  return StudySchema.parse({
    ...baseStudy,
    type,
    solverSettings: {},
    meshSettings: { preset: "medium", status: "complete", summary: { nodes, elements: nodes, warnings: [], source: "wasm_gmsh", ...(elementOrder ? { density: { elementOrder } } : {}) } }
  });
}

describe("study-level estimate", () => {
  test("waits for a generated mesh instead of estimating from preset counts", () => {
    expect(solveTimeEstimateForStudy(baseStudy, { dimensions: SLENDER_DIMENSIONS })).toBeNull();
    const presetOnly = StudySchema.parse({ ...baseStudy, meshSettings: { preset: "medium", status: "complete", summary: { nodes: 42381, elements: 26944, warnings: [], source: "preset_estimate" } } });
    expect(solveTimeEstimateForStudy(presetOnly, { dimensions: SLENDER_DIMENSIONS })).toBeNull();
  });

  test.each([
    ["static_stress", "static"],
    ["modal_analysis", "modal"],
    ["dynamic_structural", "dynamic"],
    ["steady_state_thermal", "thermal"]
  ] as const)("maps %s to the %s fit, slender slower than block", (type, analysis: EstimateAnalysis) => {
    const study = meshedStudy(type, 10_000, 2);
    const block = solveTimeEstimateForStudy(study, { dimensions: BLOCK_DIMENSIONS })!;
    const slender = solveTimeEstimateForStudy(study, { dimensions: SLENDER_DIMENSIONS })!;
    expect(block.analysis).toBe(analysis);
    expect(slender.centralSeconds).toBeGreaterThan(block.centralSeconds * 5);
  });

  test("reads the element order the mesh was actually built with", () => {
    expect(elementOrderForStudy(meshedStudy("static_stress", 1000, 1))).toBe("Tet4");
    expect(elementOrderForStudy(meshedStudy("static_stress", 1000, 2))).toBe("Tet10");
    // Requested order before meshing; default is quadratic like the mesher.
    expect(elementOrderForStudy({ ...baseStudy, solverSettings: { elementOrder: 1 } as Study["solverSettings"] })).toBe("Tet4");
    expect(elementOrderForStudy(baseStudy)).toBe("Tet10");
    // The structured block grid is always Tet10.
    expect(elementOrderForStudy({ ...baseStudy, meshSettings: { preset: "medium", status: "complete", summary: { nodes: 10, elements: 4, warnings: [], source: "core_solver" } } })).toBe("Tet10");
  });
});
