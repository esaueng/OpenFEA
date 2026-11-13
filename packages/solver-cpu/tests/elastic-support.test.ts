import { describe, expect, test } from "vitest";
import { elevateTet4MeshToTet10, extractBoundarySurfaceFacets, type OpenFEAModelJson, type SurfaceFacetJson } from "@openfea/core";
import { solveModalLinearTet, solveStaticLinearTet } from "../src";
import { assembleElasticSupportStiffness } from "../src/elastic-support";
import { getNormalizedModel } from "../src/solver";

// Elastic (Winkler foundation) supports, plan 036 R1.5. A stiff block on a
// soft foundation under a uniform top load: with Poisson's ratio 0 the exact
// solution is uniaxial, the base settles F / (k_n A) and the top a further
// F h / (E A). Both are linear fields, so Tet4 and Tet10 reproduce them up to
// the linear-solve tolerance.

/** Relative tolerance against the closed form; limited by the CG relative residual (1e-10). */
const FOUNDATION_CLOSED_FORM_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance between the m-N-s-Pa and mm-N-s-MPa models. */
const UNIT_EQUIVALENCE_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance on the resultant of the foundation reaction against the applied load. */
const REACTION_BALANCE_RELATIVE_TOLERANCE = 1e-8;
/** The bounce mode of a stiff block on springs matches sqrt(k_n A / m) within this fraction. */
const BOUNCE_FREQUENCY_RELATIVE_TOLERANCE = 0.01;

const SIDE_M = 0.1;
const HEIGHT_M = 0.05;
const YOUNG_PA = 200e9;
const DENSITY = 7850;
const NORMAL_STIFFNESS = 2e8; // N/m^3
const TANGENTIAL_STIFFNESS = 1e8; // N/m^3
const FORCE_N = 1_000;
const AREA_M2 = SIDE_M * SIDE_M;

type Order = "Tet4" | "Tet10";
type Units = "m" | "mm";

describe("elastic support face matrix", () => {
  test("Tri3 and Tri6 face matrices integrate k over the area and lump like the consistent load vector", () => {
    for (const order of ["Tet4", "Tet10"] as const) {
      const model = normalized(blockModel({ order, units: "m" }));
      const assembled = assembleElasticSupportStiffness(model, ["foundation"]);
      expect(assembled.ok).toBe(true);
      if (!assembled.ok) return;
      const matrix = assembled.assembly.matrix!;
      expect(assembled.assembly.diagnostics?.area).toBeCloseTo(AREA_M2, 12);
      // A rigid unit translation along z (the base normal) meets k_n A in total
      // and nothing in x or y; along x it meets k_t A.
      const forceZ = applyUniform(matrix, model.counts.nodes, 2);
      expect(relative(sumComponent(forceZ, 2), NORMAL_STIFFNESS * AREA_M2)).toBeLessThan(1e-12);
      expect(Math.abs(sumComponent(forceZ, 0)) + Math.abs(sumComponent(forceZ, 1))).toBeLessThan(1e-6);
      const forceX = applyUniform(matrix, model.counts.nodes, 0);
      expect(relative(sumComponent(forceX, 0), TANGENTIAL_STIFFNESS * AREA_M2)).toBeLessThan(1e-12);
      // Symmetric.
      expect(isSymmetric(matrix)).toBe(true);
      if (order === "Tet10") {
        // Uniform settlement loads Tri6 corners with zero and midsides with
        // area / 3 (the consistent uniform-traction vector). Elevation appends
        // midside nodes after the (cells + 1)^3 grid vertices.
        const vertexCount = 3 ** 3;
        let midsideTotal = 0;
        for (let node = 0; node < model.counts.nodes; node += 1) {
          const value = forceZ[node * 3 + 2]!;
          if (node < vertexCount) expect(Math.abs(value)).toBeLessThan(1e-6 * NORMAL_STIFFNESS * AREA_M2);
          else midsideTotal += value;
        }
        expect(relative(midsideTotal, NORMAL_STIFFNESS * AREA_M2)).toBeLessThan(1e-12);
      }
    }
  });
});

describe("block on an elastic foundation (plan 036 R1.5 gate)", () => {
  for (const order of ["Tet4", "Tet10"] as const) {
    test(`${order}: base settles F/(k A) and the top adds F h/(E A)`, () => {
      const solved = solveStaticLinearTet(blockModel({ order, units: "m" }));
      if (!solved.ok) throw new Error(solved.error.message);
      const model = normalized(blockModel({ order, units: "m" }));
      const base = nodesAtZ(model, 0).map((node) => solved.result.displacement[node * 3 + 2]!);
      const top = nodesAtZ(model, HEIGHT_M).map((node) => solved.result.displacement[node * 3 + 2]!);
      const settlement = -FORCE_N / (NORMAL_STIFFNESS * AREA_M2);
      const compression = -FORCE_N * HEIGHT_M / (YOUNG_PA * AREA_M2);
      for (const value of base) expect(relative(value, settlement)).toBeLessThan(FOUNDATION_CLOSED_FORM_RELATIVE_TOLERANCE);
      for (const value of top) expect(relative(value, settlement + compression)).toBeLessThan(FOUNDATION_CLOSED_FORM_RELATIVE_TOLERANCE);
      // No lateral motion: the uniaxial state is exact with nu = 0.
      const lateral = Math.max(...Array.from({ length: model.counts.nodes }, (_, node) => Math.hypot(solved.result.displacement[node * 3]!, solved.result.displacement[node * 3 + 1]!)));
      expect(lateral).toBeLessThan(1e-9 * Math.abs(settlement));
    });
  }

  test("the foundation reaction balances the applied load and is reported as the support reaction", () => {
    const solved = solveStaticLinearTet(blockModel({ order: "Tet10", units: "m" }));
    if (!solved.ok) throw new Error(solved.error.message);
    const balance = solved.diagnostics.reactionBalance!;
    expect(balance.appliedLoad[2]).toBeCloseTo(-FORCE_N, 9);
    expect(relative(balance.reaction[2], FORCE_N)).toBeLessThan(REACTION_BALANCE_RELATIVE_TOLERANCE);
    expect(balance.relativeError).toBeLessThan(REACTION_BALANCE_RELATIVE_TOLERANCE);
    expect(solved.diagnostics.constrainedDofs).toBe(0);
    expect(solved.diagnostics.elasticSupports).toMatchObject({ supportCount: 1, formulation: "consistent-face-winkler-foundation" });
  });

  test("an mm-N-s-MPa model with k in N/mm^3 settles exactly as the m-N-s-Pa model", () => {
    for (const order of ["Tet4", "Tet10"] as const) {
      const metres = solveStaticLinearTet(blockModel({ order, units: "m" }));
      const millimetres = solveStaticLinearTet(blockModel({ order, units: "mm" }));
      if (!metres.ok || !millimetres.ok) throw new Error("solve failed");
      expect(relative(millimetres.diagnostics.maxDisplacement / 1000, metres.diagnostics.maxDisplacement)).toBeLessThan(UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
      expect(relative(millimetres.diagnostics.reactionBalance!.reaction[2], metres.diagnostics.reactionBalance!.reaction[2])).toBeLessThan(UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
    }
  });
});

describe("modal analysis on an elastic foundation", () => {
  test("has no zero-frequency rigid-body modes, and its bounce mode is sqrt(k_n A / m)", () => {
    const solved = solveModalLinearTet(blockModel({ order: "Tet4", units: "m", step: "modal", cells: 2 }), { modeCount: 6 });
    if (!solved.ok) throw new Error(solved.error.message);
    const mass = DENSITY * AREA_M2 * HEIGHT_M;
    const bounceHz = Math.sqrt((NORMAL_STIFFNESS * AREA_M2) / mass) / (2 * Math.PI);
    const frequencies = solved.result.modes.map((mode) => mode.frequencyHz);
    expect(frequencies).toHaveLength(6);
    // Rigid-body modes would sit at ~0 Hz; every foundation mode is a finite
    // fraction of the bounce frequency.
    for (const frequency of frequencies) expect(frequency).toBeGreaterThan(0.1 * bounceHz);
    expect(Math.min(...frequencies.map((frequency) => relative(frequency, bounceHz)))).toBeLessThan(BOUNCE_FREQUENCY_RELATIVE_TOLERANCE);
  });
});

function blockModel(options: { order: Order; units: Units; step?: "static" | "modal"; cells?: number }): OpenFEAModelJson {
  const scale = options.units === "mm" ? 1000 : 1;
  const cells = options.cells ?? 2;
  const nx = cells;
  const nz = cells;
  const nodeId = (i: number, j: number, k: number) => i + (nx + 1) * (j + (nx + 1) * k);
  const coordinates: number[] = [];
  for (let k = 0; k <= nz; k += 1) for (let j = 0; j <= nx; j += 1) for (let i = 0; i <= nx; i += 1) {
    coordinates.push((i * SIDE_M) / nx * scale, (j * SIDE_M) / nx * scale, (k * HEIGHT_M) / nz * scale);
  }
  const tets: number[][] = [];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let k = 0; k < nz; k += 1) for (let j = 0; j < nx; j += 1) for (let i = 0; i < nx; i += 1) {
    for (const permutation of permutations) {
      const corner = [i, j, k];
      const path = [nodeId(i, j, k)];
      for (const axis of permutation) {
        corner[axis]! += 1;
        path.push(nodeId(corner[0]!, corner[1]!, corner[2]!));
      }
      tets.push(positive(path, coordinates));
    }
  }
  const material = {
    name: "block",
    type: "isotropicLinearElastic" as const,
    youngModulus: options.units === "mm" ? YOUNG_PA / 1e6 : YOUNG_PA,
    poissonRatio: 0,
    density: options.units === "mm" ? DENSITY * 1e-12 : DENSITY,
    yieldStrength: options.units === "mm" ? 250 : 250e6
  };
  let model: OpenFEAModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.4.0",
    nodes: { coordinates },
    materials: [material],
    elementBlocks: [{ name: "block", type: "Tet4", material: "block", connectivity: tets.flat() }],
    nodeSets: [],
    elementSets: [],
    boundaryConditions: [],
    loads: [],
    steps: [],
    coordinateSystem: { solverUnits: options.units === "mm" ? "mm-N-s-MPa" : "m-N-s-Pa", renderCoordinateSpace: "solver" }
  };
  let surfaceFacets: SurfaceFacetJson[] = extractBoundarySurfaceFacets(model);
  if (options.order === "Tet10") {
    const elevated = elevateTet4MeshToTet10({ coordinates, elements: tets, facets: surfaceFacets.map((facet) => facet.nodes) });
    model = { ...model, nodes: { coordinates: elevated.coordinates }, elementBlocks: [{ name: "block", type: "Tet10", material: "block", connectivity: elevated.elements.flat() }] };
    surfaceFacets = surfaceFacets.map((facet, index) => ({ ...facet, nodes: elevated.facets[index]! }));
  }
  const atZ = (z: number) => surfaceFacets.filter((facet) => facet.nodes.slice(0, 3).every((node) => Math.abs(model.nodes.coordinates[node * 3 + 2]! - z * scale) < 1e-9 * scale)).map((facet) => facet.id);
  const stiffnessScale = options.units === "mm" ? 1e-9 : 1; // N/m^3 -> N/mm^3
  const boundaryConditions: OpenFEAModelJson["boundaryConditions"] = [{
    name: "foundation",
    type: "elasticSupport",
    surfaceSet: "base",
    normalStiffness: NORMAL_STIFFNESS * stiffnessScale,
    tangentialStiffness: TANGENTIAL_STIFFNESS * stiffnessScale
  }];
  const loads: OpenFEAModelJson["loads"] = options.step === "modal" ? [] : [{ name: "top", type: "surfaceForce", surfaceSet: "top", totalForce: [0, 0, -FORCE_N] }];
  return {
    ...model,
    surfaceFacets,
    surfaceSets: [{ name: "base", facets: atZ(0) }, { name: "top", facets: atZ(HEIGHT_M) }],
    boundaryConditions,
    loads,
    steps: [options.step === "modal"
      ? { name: "modal", type: "modal", boundaryConditions: ["foundation"], modeCount: 6 }
      : { name: "static", type: "staticLinear", boundaryConditions: ["foundation"], loads: ["top"] }]
  };
}

function positive(nodes: number[], coordinates: number[]): number[] {
  const point = (node: number) => [coordinates[node * 3]!, coordinates[node * 3 + 1]!, coordinates[node * 3 + 2]!];
  const [a, b, c, d] = nodes.map(point) as [number[], number[], number[], number[]];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  const w = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
  const volume = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  return volume > 0 ? nodes : [nodes[0]!, nodes[2]!, nodes[1]!, nodes[3]!];
}

function normalized(model: OpenFEAModelJson) {
  const result = getNormalizedModel(model);
  if (!result.ok) throw new Error(result.error.message);
  return result.model;
}

function nodesAtZ(model: ReturnType<typeof normalized>, z: number): number[] {
  const nodes: number[] = [];
  for (let node = 0; node < model.counts.nodes; node += 1) if (Math.abs(model.nodes.coordinates[node * 3 + 2]! - z) < 1e-12) nodes.push(node);
  return nodes;
}

function applyUniform(matrix: { rowCount: number; rowPtr: Int32Array; colInd: Int32Array; values: Float64Array }, nodes: number, component: number): Float64Array {
  const vector = new Float64Array(nodes * 3);
  for (let node = 0; node < nodes; node += 1) vector[node * 3 + component] = 1;
  const result = new Float64Array(matrix.rowCount);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    for (let entry = matrix.rowPtr[row]!; entry < matrix.rowPtr[row + 1]!; entry += 1) result[row] += matrix.values[entry]! * vector[matrix.colInd[entry]!]!;
  }
  return result;
}

function sumComponent(values: Float64Array, component: number): number {
  let sum = 0;
  for (let index = component; index < values.length; index += 3) sum += values[index]!;
  return sum;
}

function isSymmetric(matrix: { rowCount: number; rowPtr: Int32Array; colInd: Int32Array; values: Float64Array }): boolean {
  const entries = new Map<string, number>();
  for (let row = 0; row < matrix.rowCount; row += 1) {
    for (let entry = matrix.rowPtr[row]!; entry < matrix.rowPtr[row + 1]!; entry += 1) entries.set(`${row}:${matrix.colInd[entry]}`, matrix.values[entry]!);
  }
  for (const [key, value] of entries) {
    const [row, col] = key.split(":");
    if (Math.abs((entries.get(`${col}:${row}`) ?? 0) - value) > 1e-9 * Math.abs(value)) return false;
  }
  return true;
}

function relative(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

