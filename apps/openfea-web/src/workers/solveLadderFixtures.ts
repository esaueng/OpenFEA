// Deterministic structured fixtures for the solve-ladder benchmark (plan 036
// R5.1). Every rung is generated from a handful of integers, so nothing large is
// committed and every engine solves bit-identical input: grid coordinates are
// computed as (length * i) / divisions in IEEE-754 doubles, which is exact
// across V8 and JavaScriptCore.
//
// Each hexahedral cell is split into six Tet4 around its c0-c6 body diagonal
// (Kuhn split). Every cell uses the same diagonal direction, so neighbouring
// cells share face diagonals and the mesh is conforming. Tet10 elevation puts
// midside nodes on the half-grid, so a Tet10 rung has exactly
// (2nx+1)(2ny+1)(2nz+1) nodes.
import {
  elevateTet4MeshToTet10,
  extractBoundarySurfaceFacets,
  type OpenFEAModelJson
} from "@openfea/core";

export type LadderShape = "block" | "slender";
export type LadderOrder = "Tet4" | "Tet10";
export type LadderAnalysis = "static" | "modal" | "dynamic";

/** Total-DOF targets. The top rung must stay at or under the 150k product ceiling, which counts ALL DOFs. */
export const LADDER_RUNG_TARGET_DOFS = { "30k": 30_000, "75k": 75_000, "150k": 150_000 } as const;
export type LadderRung = keyof typeof LADDER_RUNG_TARGET_DOFS;

/**
 * mm-N-s-MPa. "block" is the well-conditioned variant (2:1:1 stocky cantilever);
 * "slender" is the ill-conditioned one (50:1:1 cantilever, bending-dominated).
 */
export const LADDER_SHAPES: Record<LadderShape, { length: number; width: number; height: number; tipForceN: number }> = {
  block: { length: 200, width: 100, height: 100, tipForceN: 10_000 },
  slender: { length: 1000, width: 20, height: 20, tipForceN: 100 }
};

/** Structural steel in mm-N-s-MPa (density in tonne/mm^3). */
export const LADDER_MATERIAL = {
  name: "Structural steel",
  type: "isotropicLinearElastic" as const,
  youngModulus: 200_000,
  poissonRatio: 0.3,
  density: 7.85e-9,
  yieldStrength: 250
};

/** Implicit Newmark is unconditionally stable; 20 steps keep the dynamic baseline short. */
export const LADDER_DYNAMIC_STEP = {
  startTime: 0,
  endTime: 0.01,
  timeStep: 0.0005,
  outputInterval: 0.0025,
  loadProfile: "ramp" as const,
  dampingRatio: 0.02
};
export const LADDER_MODAL_MODE_COUNT = 3;

/** Grid cells are kept within this edge-length ratio so only the geometry, not element shape, drives conditioning. */
const MAX_CELL_ASPECT = 2;
/** Among grids within this fraction of the DOF target, the most cubic cell wins. */
const DOF_TARGET_SLACK = 0.05;
const MAX_CROSS_SECTION_DIVISIONS = 64;

export type LadderGrid = { nx: number; ny: number; nz: number; nodes: number; dofs: number };

export function ladderGrid(shape: LadderShape, order: LadderOrder, targetDofs: number): LadderGrid {
  const dims = LADDER_SHAPES[shape];
  const m = order === "Tet10" ? 2 : 1;
  const candidates: Array<LadderGrid & { cellAspect: number }> = [];
  for (let n = 1; n <= MAX_CROSS_SECTION_DIVISIONS; n += 1) {
    const ny = n;
    const nz = Math.max(1, Math.round((n * dims.height) / dims.width));
    const layerNodes = (m * ny + 1) * (m * nz + 1);
    const nx = Math.floor((Math.floor(targetDofs / 3) / layerNodes - 1) / m);
    if (nx < 1) continue;
    const cellAspect = dims.length / nx / (dims.width / ny);
    if (cellAspect > MAX_CELL_ASPECT || cellAspect < 1 / MAX_CELL_ASPECT) continue;
    const nodes = (m * nx + 1) * layerNodes;
    candidates.push({ nx, ny, nz, nodes, dofs: nodes * 3, cellAspect });
  }
  const nearTarget = candidates.filter((candidate) => candidate.dofs >= (1 - DOF_TARGET_SLACK) * targetDofs);
  const pool = nearTarget.length ? nearTarget : candidates;
  const distortion = (candidate: { cellAspect: number }) => Math.abs(Math.log(candidate.cellAspect));
  const picked = pool.reduce<(typeof pool)[number] | undefined>(
    (best, candidate) =>
      !best || (nearTarget.length ? distortion(candidate) < distortion(best) : candidate.dofs > best.dofs) ? candidate : best,
    undefined
  );
  if (!picked) throw new Error(`No ${order} ${shape} grid fits ${targetDofs} DOFs within cell aspect ${MAX_CELL_ASPECT}.`);
  const { cellAspect: _cellAspect, ...grid } = picked;
  return grid;
}

export type LadderFixture = {
  id: string;
  shape: LadderShape;
  order: LadderOrder;
  rung: LadderRung;
  grid: LadderGrid;
  model: OpenFEAModelJson;
  /** Nodes on the x = 0 clamp (all three components fixed). */
  fixedNodeCount: number;
  freeDofs: number;
  tipNodes: number[];
  appliedForce: [number, number, number];
  /** FNV-1a over coordinates + connectivity; a reference entry only applies to the same hash. */
  fingerprint: string;
};

export function ladderFixtureId(shape: LadderShape, order: LadderOrder, rung: LadderRung): string {
  return `${shape}-${order.toLowerCase()}-${rung}`;
}

export function buildLadderFixture(shape: LadderShape, order: LadderOrder, rung: LadderRung): LadderFixture {
  const dims = LADDER_SHAPES[shape];
  const grid = ladderGrid(shape, order, LADDER_RUNG_TARGET_DOFS[rung]);
  const { nx, ny, nz } = grid;
  const coordinates: number[] = [];
  const nodeIndex = (i: number, j: number, k: number) => (i * (ny + 1) + j) * (nz + 1) + k;
  for (let i = 0; i <= nx; i += 1) {
    const x = (dims.length * i) / nx;
    for (let j = 0; j <= ny; j += 1) {
      const y = (dims.width * j) / ny;
      for (let k = 0; k <= nz; k += 1) {
        coordinates.push(x, y, (dims.height * k) / nz);
      }
    }
  }
  const tet4: number[][] = [];
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) {
        const c0 = nodeIndex(i, j, k);
        const c1 = nodeIndex(i + 1, j, k);
        const c2 = nodeIndex(i + 1, j + 1, k);
        const c3 = nodeIndex(i, j + 1, k);
        const c4 = nodeIndex(i, j, k + 1);
        const c5 = nodeIndex(i + 1, j, k + 1);
        const c6 = nodeIndex(i + 1, j + 1, k + 1);
        const c7 = nodeIndex(i, j + 1, k + 1);
        tet4.push(
          [c0, c1, c2, c6],
          [c0, c2, c3, c6],
          [c0, c3, c7, c6],
          [c0, c7, c4, c6],
          [c0, c4, c5, c6],
          [c0, c5, c1, c6]
        );
      }
    }
  }
  let finalCoordinates = coordinates;
  let connectivity: number[];
  if (order === "Tet10") {
    const elevated = elevateTet4MeshToTet10({ coordinates, elements: tet4 });
    finalCoordinates = elevated.coordinates;
    connectivity = elevated.elements.flat();
  } else {
    connectivity = tet4.flat();
  }
  const nodeCount = finalCoordinates.length / 3;
  if (nodeCount !== grid.nodes) throw new Error(`Ladder grid predicted ${grid.nodes} nodes but generated ${nodeCount}.`);

  // Plane membership is exact: x = 0 and x = length are generated exactly.
  const fixedNodes: number[] = [];
  const tipNodes: number[] = [];
  for (let node = 0; node < nodeCount; node += 1) {
    const x = finalCoordinates[node * 3]!;
    if (x === 0) fixedNodes.push(node);
    else if (x === dims.length) tipNodes.push(node);
  }
  const appliedForce: [number, number, number] = [0, 0, -dims.tipForceN];
  const base: OpenFEAModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.4.0",
    nodes: { coordinates: finalCoordinates },
    materials: [LADDER_MATERIAL],
    elementBlocks: [{ name: "body", type: order, material: LADDER_MATERIAL.name, connectivity }],
    nodeSets: [{ name: "fixedNodes", nodes: fixedNodes }],
    elementSets: [],
    boundaryConditions: [{ name: "clamp", type: "fixed", nodeSet: "fixedNodes", components: ["x", "y", "z"] }],
    loads: [],
    steps: [],
    coordinateSystem: { solverUnits: "mm-N-s-MPa", renderCoordinateSpace: "solver" },
    meshProvenance: { kind: "opencae_core_fea", solver: "opencae-core-local", resultSource: "computed", meshSource: "structured_block_core" }
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const tipSet = new Set(tipNodes);
  const tipFacets = surfaceFacets
    .filter((facet) => facet.nodes.every((node) => tipSet.has(node)))
    .map((facet) => facet.id);
  const model: OpenFEAModelJson = {
    ...base,
    surfaceFacets,
    surfaceSets: [{ name: "tipFace", facets: tipFacets }],
    loads: [{ name: "tipShear", type: "surfaceForce", surfaceSet: "tipFace", totalForce: appliedForce }],
    steps: [
      { name: "static", type: "staticLinear", boundaryConditions: ["clamp"], loads: ["tipShear"] },
      { name: "modal", type: "modal", boundaryConditions: ["clamp"], modeCount: LADDER_MODAL_MODE_COUNT },
      { name: "dynamic", type: "dynamicLinear", boundaryConditions: ["clamp"], loads: ["tipShear"], ...LADDER_DYNAMIC_STEP }
    ]
  };
  return {
    id: ladderFixtureId(shape, order, rung),
    shape,
    order,
    rung,
    grid,
    model,
    fixedNodeCount: fixedNodes.length,
    freeDofs: (nodeCount - fixedNodes.length) * 3,
    tipNodes,
    appliedForce,
    fingerprint: fingerprintMesh(finalCoordinates, connectivity)
  };
}

export const LADDER_STEP_INDEX: Record<LadderAnalysis, number> = { static: 0, modal: 1, dynamic: 2 };

/**
 * Euler-Bernoulli + Timoshenko shear tip deflection of the clamped cantilever
 * (mm). Only meaningful for the slender variant (L/H = 50); the 2:1 block is not
 * a beam, and Tet4 is expected to lock well short of it.
 */
export function ladderTimoshenkoTipDeflection(shape: LadderShape): number {
  const { length, width, height, tipForceN } = LADDER_SHAPES[shape];
  const { youngModulus: e, poissonRatio: nu } = LADDER_MATERIAL;
  const inertia = (width * height ** 3) / 12;
  const area = width * height;
  const shearModulus = e / (2 * (1 + nu));
  const shearCoefficient = (10 * (1 + nu)) / (12 + 11 * nu);
  return (tipForceN * length ** 3) / (3 * e * inertia) + (tipForceN * length) / (shearCoefficient * shearModulus * area);
}

function fingerprintMesh(coordinates: number[], connectivity: number[]): string {
  let hash = 0x811c9dc5;
  const mix = (byte: number) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const view = new DataView(new ArrayBuffer(8));
  for (const value of coordinates) {
    view.setFloat64(0, value, true);
    for (let byte = 0; byte < 8; byte += 1) mix(view.getUint8(byte));
  }
  for (const value of connectivity) {
    mix(value & 0xff);
    mix((value >>> 8) & 0xff);
    mix((value >>> 16) & 0xff);
    mix((value >>> 24) & 0xff);
  }
  return hash.toString(16).padStart(8, "0");
}

export type LadderCase = { shape: LadderShape; order: LadderOrder; rung: LadderRung; analysis: LadderAnalysis };

/** Static at every rung; modal + dynamic (Jacobi-preconditioned) at 30k only, as the R5.2 SSOR baseline. */
export function ladderCases(): LadderCase[] {
  const cases: LadderCase[] = [];
  const shapes: LadderShape[] = ["block", "slender"];
  const orders: LadderOrder[] = ["Tet4", "Tet10"];
  for (const rung of Object.keys(LADDER_RUNG_TARGET_DOFS) as LadderRung[]) {
    for (const shape of shapes) {
      for (const order of orders) {
        cases.push({ shape, order, rung, analysis: "static" });
        if (rung === "30k") {
          cases.push({ shape, order, rung, analysis: "modal" });
          cases.push({ shape, order, rung, analysis: "dynamic" });
        }
      }
    }
  }
  return cases;
}
