import { describe, expect, test } from "vitest";
import { OPENFEA_MODEL_SCHEMA_VERSION, type OpenFEAModelJson } from "@openfea/core";
import { solveDynamicLinearTetMDOF } from "../src";

/** The unit tetrahedron has one uncoupled axial tip DOF: k=200 N/m, m=1/24 kg. */
function stepLoadedTet(): OpenFEAModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: OPENFEA_MODEL_SCHEMA_VERSION,
    nodes: { coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    materials: [{ name: "solid", type: "isotropicLinearElastic", youngModulus: 1000, poissonRatio: 0.25, density: 1 }],
    elementBlocks: [{ name: "tet", type: "Tet4", material: "solid", connectivity: [0, 1, 2, 3] }],
    nodeSets: [{ name: "base", nodes: [0, 1, 2] }, { name: "tip", nodes: [3] }],
    elementSets: [],
    boundaryConditions: [{ name: "fixed", type: "fixed", nodeSet: "base", components: ["x", "y", "z"] }],
    loads: [{ name: "force", type: "nodalForce", nodeSet: "tip", vector: [0, 0, 100] }],
    steps: [{ name: "step", type: "dynamicLinear", boundaryConditions: ["fixed"], loads: ["force"], startTime: 0,
      endTime: 0.002, timeStep: 0.001, outputInterval: 0.001, loadProfile: "step", dampingRatio: 0 }]
  };
}

function supportZ(reaction: Float64Array): number {
  return reaction[2] + reaction[5] + reaction[8];
}

describe("dynamic support reactions", () => {
  test("reports the evolving constrained reaction rather than summing free inertial forces", () => {
    const solved = solveDynamicLinearTetMDOF(stepLoadedTet());
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;

    const stiffness = 200;
    const mass = 1 / 24;
    const omega = Math.sqrt(stiffness / mass);
    const phasePerStep = 2 * Math.atan(omega * 0.001 / 2);
    for (const frame of solved.result.frames) {
      const reaction = frame.reactionForce!;
      const expectedDisplacement = (100 / stiffness) * (1 - Math.cos(frame.frameIndex * phasePerStep));
      expect(frame.displacement.values[11]).toBeCloseTo(expectedDisplacement, 12);
      expect(supportZ(reaction)).toBeCloseTo(-stiffness * expectedDisplacement, 10);
      expect(Array.from(reaction.slice(9))).toEqual([0, 0, 0]);
      expect(supportZ(reaction) + 100 - mass * frame.acceleration.values[11]).toBeCloseTo(0, 10);
    }
    expect(supportZ(solved.result.frames[0]!.reactionForce!)).toBe(0);
    expect(solved.result.coreResult?.summary.reactionForce).toBeCloseTo(0.957700140574419, 10);
    expect(solved.result.coreResult?.summary.reactionForce).toBeCloseTo(
      Math.abs(supportZ(solved.result.frames.at(-1)!.reactionForce!)), 12
    );
    expect(solved.diagnostics.reactionBalance.every((entry) => entry.relativeImbalance < 1e-10)).toBe(true);
  });

  test("includes stiffness-proportional damping in the support reaction and separates free equilibrium", () => {
    const rayleighAlpha = 1.2;
    const rayleighBeta = 0.03;
    const solved = solveDynamicLinearTetMDOF(stepLoadedTet(), { rayleighAlpha, rayleighBeta });
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;

    const stiffness = 200;
    const mass = 1 / 24;
    for (const frame of solved.result.frames) {
      const u = frame.displacement.values[11];
      const v = frame.velocity.values[11];
      const a = frame.acceleration.values[11];
      const expectedReaction = -stiffness * (u + rayleighBeta * v);
      expect(supportZ(frame.reactionForce!)).toBeCloseTo(expectedReaction, 10);
      expect(Array.from(frame.reactionForce!.slice(9))).toEqual([0, 0, 0]);
      expect(supportZ(frame.reactionForce!) + 100 - mass * (a + rayleighAlpha * v)).toBeCloseTo(0, 10);
    }
    const last = solved.result.frames.at(-1)!;
    expect(Math.abs(supportZ(last.reactionForce!) + stiffness * last.displacement.values[11])).toBeGreaterThan(1);
    expect(solved.diagnostics.reactionBalance.every((entry) => entry.relativeImbalance < 1e-10)).toBe(true);
  });

  test("includes forces applied directly to constrained nodes", () => {
    const model = stepLoadedTet();
    model.loads.push({ name: "base-force", type: "nodalForce", nodeSet: "base", vector: [0, 0, 9] });
    model.steps[0]!.loads.push("base-force");
    const solved = solveDynamicLinearTetMDOF(model);
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;

    const first = solved.result.frames[0]!;
    expect(supportZ(first.reactionForce!)).toBeCloseTo(-27, 12);
    expect(Array.from(first.reactionForce!.slice(9))).toEqual([0, 0, 0]);
  });

  test("preserves reaction forces across consistent meter and millimeter unit systems", () => {
    const meters = stepLoadedTet();
    const millimeters = stepLoadedTet();
    millimeters.coordinateSystem = { solverUnits: "mm-N-s-MPa", renderCoordinateSpace: "solver" };
    millimeters.nodes.coordinates = millimeters.nodes.coordinates.map((coordinate) => coordinate * 1000);
    millimeters.materials[0]!.youngModulus /= 1e6;
    millimeters.materials[0]!.density! /= 1e12;
    const options = { rayleighAlpha: 1.2, rayleighBeta: 0.03 };
    const meterSolve = solveDynamicLinearTetMDOF(meters, options);
    const millimeterSolve = solveDynamicLinearTetMDOF(millimeters, options);
    expect(meterSolve.ok).toBe(true);
    expect(millimeterSolve.ok).toBe(true);
    if (!meterSolve.ok || !millimeterSolve.ok) return;

    for (let index = 0; index < meterSolve.result.frames.length; index += 1) {
      const meterFrame = meterSolve.result.frames[index]!;
      const millimeterFrame = millimeterSolve.result.frames[index]!;
      expect(supportZ(millimeterFrame.reactionForce!)).toBeCloseTo(supportZ(meterFrame.reactionForce!), 10);
      expect(millimeterFrame.displacement.values[11] / 1000).toBeCloseTo(meterFrame.displacement.values[11], 12);
    }
    expect(millimeterSolve.result.coreResult?.summary.reactionForce).toBeCloseTo(
      meterSolve.result.coreResult!.summary.reactionForce, 10
    );
  });
});
