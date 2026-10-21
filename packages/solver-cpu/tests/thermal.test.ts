import { describe, expect, test } from "vitest";
import { OPENFEA_MODEL_SCHEMA_VERSION, type OpenFEAModelJson } from "@openfea/core";
import { solveSteadyStateThermal } from "../src";

function singleTetThermalModel(): OpenFEAModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: OPENFEA_MODEL_SCHEMA_VERSION,
    nodes: { coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    materials: [{
      name: "thermal-solid",
      type: "isotropicLinearElastic",
      youngModulus: 1,
      poissonRatio: 0.25,
      thermalConductivity: 10
    }],
    elementBlocks: [{ name: "solid", type: "Tet4", material: "thermal-solid", connectivity: [0, 1, 2, 3] }],
    nodeSets: [{ name: "cold", nodes: [0, 2, 3] }, { name: "hot", nodes: [1] }],
    elementSets: [],
    boundaryConditions: [
      { name: "cold-temperature", type: "prescribedTemperature", nodeSet: "cold", value: 0 },
      { name: "hot-temperature", type: "prescribedTemperature", nodeSet: "hot", value: 100 }
    ],
    loads: [],
    steps: [{
      name: "conduction",
      type: "steadyStateThermal",
      boundaryConditions: ["cold-temperature", "hot-temperature"],
      loads: []
    }]
  };
}

describe("steady-state thermal", () => {
  test("recovers the exact linear temperature and Fourier heat flux in a Tet4", () => {
    const model = singleTetThermalModel();

    const solved = solveSteadyStateThermal(model);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(Array.from(solved.result.temperature)).toEqual([0, 100, 0, 0]);
    for (let node = 0; node < 4; node += 1) {
      expect(solved.result.heatFlux[node * 3]).toBeCloseTo(-1000, 10);
      expect(solved.result.heatFlux[node * 3 + 1]).toBeCloseTo(0, 10);
      expect(solved.result.heatFlux[node * 3 + 2]).toBeCloseTo(0, 10);
      expect(solved.result.heatFluxMagnitude[node]).toBeCloseTo(1000, 10);
    }
    expect(solved.diagnostics.energyBalanceRelativeError).toBeLessThan(1e-12);
  });

  test("honors a lower maxDofs request but cannot raise the thermal ceiling", () => {
    const lowered = solveSteadyStateThermal(singleTetThermalModel(), { maxDofs: 3 });
    expect(lowered.ok).toBe(false);
    if (!lowered.ok) expect(lowered.error.message).toBe("Thermal model has 4 DOFs, which exceeds maxDofs 3.");

    // One node past the 150k ceiling; only the DOF count matters because the cap is checked before assembly.
    const oversized = singleTetThermalModel();
    oversized.nodes.coordinates = new Array(150_001 * 3).fill(0).map((_, index) => index < 12 ? oversized.nodes.coordinates[index]! : index);
    const raised = solveSteadyStateThermal(oversized, { maxDofs: 1_000_000 });
    expect(raised.ok).toBe(false);
    if (!raised.ok) {
      expect(raised.error.code).toBe("max-dofs-exceeded");
      expect(raised.error.message).toBe("Thermal model has 150001 DOFs, which exceeds maxDofs 150000.");
    }
  });
});
