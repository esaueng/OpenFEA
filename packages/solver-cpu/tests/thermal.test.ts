import { describe, expect, test } from "vitest";
import { elevateTet4MeshToTet10, OPENFEA_MODEL_SCHEMA_VERSION, type OpenFEAModelJson } from "@openfea/core";
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

type Point = readonly [number, number, number];
const UNIT_CORNERS: Point[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];

function prescribedTet10Model(
  coordinates: number[],
  elements: number[][],
  temperatures: number[],
  conductivities = elements.map(() => 10)
): OpenFEAModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: OPENFEA_MODEL_SCHEMA_VERSION,
    nodes: { coordinates },
    materials: conductivities.map((thermalConductivity, index) => ({
      name: `material-${index}`, type: "isotropicLinearElastic", youngModulus: 1,
      poissonRatio: 0.25, thermalConductivity
    })),
    elementBlocks: elements.map((connectivity, index) => ({
      name: `solid-${index}`, type: "Tet10", material: `material-${index}`, connectivity
    })),
    nodeSets: temperatures.map((_, index) => ({ name: `node-${index}`, nodes: [index] })),
    boundaryConditions: temperatures.map((value, index) => ({
      name: `temperature-${index}`, type: "prescribedTemperature", nodeSet: `node-${index}`, value
    })),
    elementSets: [],
    loads: [],
    steps: [{
      name: "conduction", type: "steadyStateThermal",
      boundaryConditions: temperatures.map((_, index) => `temperature-${index}`), loads: []
    }]
  };
}

function nodePoints(coordinates: number[]): Point[] {
  return Array.from({ length: coordinates.length / 3 }, (_, index) =>
    coordinates.slice(index * 3, index * 3 + 3) as [number, number, number]);
}

function expectNodalFlux(model: OpenFEAModelJson, expected: Point[]): void {
  const solved = solveSteadyStateThermal(model);
  expect(solved.ok).toBe(true);
  if (!solved.ok) throw new Error(solved.error.message);
  expect(solved.result.heatFlux.length).toBe(expected.length * 3);
  for (const [node, flux] of expected.entries()) {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(solved.result.heatFlux[node * 3 + axis]).toBeCloseTo(flux[axis], 9);
    }
    expect(solved.result.heatFluxMagnitude[node]).toBeCloseTo(Math.hypot(...flux), 9);
  }
}

describe("Tet10 nodal heat-flux recovery", () => {
  test("preserves the quadratic manufactured field's gradient and peak instead of its centroid flux", () => {
    const mesh = elevateTet4MeshToTet10({ coordinates: UNIT_CORNERS.flat(), elements: [[0, 1, 2, 3]] });
    const points = nodePoints(mesh.coordinates);
    const model = prescribedTet10Model(mesh.coordinates, mesh.elements, points.map(([x]) => x * x));
    model.elementSets = [{ name: "all", elements: [0] }];
    model.loads = [{ name: "source", type: "volumetricHeatGeneration", elementSet: "all", generation: -20 }];
    model.steps[0].loads = ["source"];

    expectNodalFlux(model, points.map(([x]) => [-20 * x, 0, 0]));
    const solved = solveSteadyStateThermal(model);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(Array.from(solved.result.temperature)).toEqual(points.map(([x]) => x * x));
    expect(Math.max(...solved.result.heatFluxMagnitude)).toBeCloseTo(20, 10);
    expect(solved.diagnostics.energyBalanceRelativeError).toBeLessThan(1e-12);
  });

  test("recovers off-axis quadratic gradients on an affine skewed element", () => {
    const corners = [[0.3, -0.2, 0.1], [2, 0.25, 0.1], [0.4, 1.5, 0.3], [0.2, 0.1, 1.8]];
    const mesh = elevateTet4MeshToTet10({ coordinates: corners.flat(), elements: [[0, 1, 2, 3]] });
    const points = nodePoints(mesh.coordinates);
    const model = prescribedTet10Model(mesh.coordinates, mesh.elements,
      points.map(([x, y, z]) => 3 + x * x + 2 * y * y + 3 * z * z + 4 * x * y - 2 * x * z + 6 * y * z));

    expectNodalFlux(model, points.map(([x, y, z]) => [
      -10 * (2 * x + 4 * y - 2 * z),
      -10 * (4 * y + 4 * x + 6 * z),
      -10 * (6 * z - 2 * x + 6 * y)
    ]));
  });

  test("evaluates each curved element node's physical Jacobian", () => {
    const mesh = elevateTet4MeshToTet10({ coordinates: UNIT_CORNERS.flat(), elements: [[0, 1, 2, 3]] });
    const reference = nodePoints(mesh.coordinates);
    // Isoparametric map x=xi*(1+0.4*eta), y=eta, z=zeta; T=xi^2.
    // Its physical gradient follows analytically from xi=x/(1+0.4*y).
    const curvature = 0.4;
    const coordinates = reference.flatMap(([xi, eta, zeta]) => [xi * (1 + curvature * eta), eta, zeta]);
    const model = prescribedTet10Model(coordinates, mesh.elements, reference.map(([xi]) => xi * xi));

    expectNodalFlux(model, reference.map(([xi, eta]) => [
      -20 * xi / (1 + curvature * eta),
      20 * curvature * xi * xi / (1 + curvature * eta),
      0
    ]));
  });

  test("volume-weights distinct material fluxes at shared vertices and midside nodes", () => {
    const mesh = elevateTet4MeshToTet10({
      coordinates: [...UNIT_CORNERS.flat(), 0, 0, -2],
      elements: [[0, 1, 2, 3], [0, 2, 1, 4]]
    });
    const points = nodePoints(mesh.coordinates);
    const model = prescribedTet10Model(mesh.coordinates, mesh.elements, points.map(([x, y, z]) => x * x + 2 * y * y + 3 * z * z), [10, 40]);
    const first = new Set(mesh.elements[0]);
    const second = new Set(mesh.elements[1]);
    const shared = mesh.elements[0].filter((node) => second.has(node));
    expect(shared).toHaveLength(6);

    expectNodalFlux(model, points.map(([x, y, z], node) => {
      // The lower tetrahedron has twice the volume: (10*V + 40*2V)/(3V)=30.
      const conductivity = first.has(node) && second.has(node) ? 30 : first.has(node) ? 10 : 40;
      return [-2 * conductivity * x, -4 * conductivity * y, -6 * conductivity * z];
    }));
  });

  test("preserves equivalent SI and millimeter heat-flux units", () => {
    const mesh = elevateTet4MeshToTet10({ coordinates: UNIT_CORNERS.flat(), elements: [[0, 1, 2, 3]] });
    const temperatures = nodePoints(mesh.coordinates).map(([x, y, z]) => x * x + 2 * y * y + 3 * z * z);
    const meter = prescribedTet10Model(mesh.coordinates.map((value) => value * 0.01), mesh.elements, temperatures, [10]);
    meter.coordinateSystem = { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" };
    const millimeter = prescribedTet10Model(mesh.coordinates.map((value) => value * 10), mesh.elements, temperatures, [0.01]);
    millimeter.coordinateSystem = { solverUnits: "mm-N-s-MPa", renderCoordinateSpace: "solver" };
    const si = solveSteadyStateThermal(meter);
    const mm = solveSteadyStateThermal(millimeter);
    expect(si.ok).toBe(true);
    expect(mm.ok).toBe(true);
    if (!si.ok || !mm.ok) return;
    expect(si.result.units.heatFlux).toBe("W/m^2");
    expect(mm.result.units.heatFlux).toBe("W/mm^2");
    for (let index = 0; index < si.result.heatFlux.length; index += 1) {
      expect(mm.result.heatFlux[index] * 1e6).toBeCloseTo(si.result.heatFlux[index], 8);
    }
    for (let node = 0; node < temperatures.length; node += 1) {
      expect(mm.result.temperature[node]).toBeCloseTo(si.result.temperature[node], 10);
      expect(mm.result.heatFluxMagnitude[node] * 1e6).toBeCloseTo(si.result.heatFluxMagnitude[node], 8);
    }
  });
});

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
