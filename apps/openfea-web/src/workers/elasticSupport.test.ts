// Elastic (Winkler foundation) supports (plan 036 R1.5) through the product
// path: mesh-time Core model from @openfea/mesh-intake, stored on the study,
// then the adapter rebuilds the supports (converting N/m^3 to the mesh's
// solver unit) and the browser-local solver runs.
//
// A 100 x 100 x 50 mm steel block (Poisson's ratio 0, so the state is exactly
// uniaxial) rests on an elastic foundation and carries a total load F on its
// top face. The base settles F / (k_n A) and the top a further F h / (E A);
// both fields are linear, so the Tet10 mesh reproduces them up to the
// linear-solve round-off the named tolerance allows.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildCoreModelFromCloudMesh, elevateVolumeMeshArtifactToTet10, parseGmshMeshToCoreVolumeMesh, type CoreVolumeMeshArtifact } from "@openfea/mesh-intake";
import { buildOpenFeaCoreModelForStudy, openFeaCoreEligibility } from "@openfea/core-adapter";
import { StudySchema, type Constraint, type CustomMaterial, type DisplayModel, type Study } from "@openfea/schema";
import { trySolveOpenFeaCoreStudy } from "./openfeaCoreSolve";

/** Relative tolerance against F/(kA) + Fh/(EA); limited by the CG relative residual (1e-10). */
const FOUNDATION_CLOSED_FORM_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance between the m-N-s-Pa and mm-N-s-MPa solves. */
const UNIT_EQUIVALENCE_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance on |sum of support reactions| against the applied load. */
const REACTION_BALANCE_RELATIVE_TOLERANCE = 1e-6;
/** The bounce mode of a stiff block on springs matches sqrt(k_n A / m) within this fraction. */
const BOUNCE_FREQUENCY_RELATIVE_TOLERANCE = 0.01;
/** Each case solves a few thousand-DOF Tet10 model; CI shares four cores between suites. */
const SOLVE_TEST_TIMEOUT_MS = 60_000;

const SIDE_MM = 100;
const HEIGHT_MM = 50;
const CELL_MM = 25;
const FORCE_N = 1_000;
const NORMAL_STIFFNESS = 2e8; // N/m^3 (0.2 N/mm^3)
const TANGENTIAL_STIFFNESS = 1e8; // N/m^3
const AREA_M2 = (SIDE_MM / 1000) ** 2;

const STEEL: CustomMaterial = {
  id: "00000000-0000-4000-8000-0000000000e1",
  name: "Uniaxial steel",
  category: "metal",
  youngsModulus: 200e9,
  poissonRatio: 0,
  density: 7850,
  yieldStrength: 250e6,
  verification: "user_supplied_unverified"
};

const FACES = ["x0", "x1", "y0", "y1", "z0", "z1"] as const;
type FaceName = (typeof FACES)[number];

const foundation: Constraint = {
  id: "foundation",
  type: "elastic_support",
  selectionRef: "selection-z0",
  parameters: { label: "ES 1", normalStiffness: NORMAL_STIFFNESS, tangentialStiffness: TANGENTIAL_STIFFNESS, units: "N/m^3" },
  status: "complete"
};

describe("block on an elastic foundation (plan 036 R1.5 gate)", () => {
  test("the top settles F/(k_n A) + F h/(E A) and the foundation reaction balances F", () => {
    const solved = solve(study("static_stress", [foundation]), "m");
    const settlementMm = (FORCE_N / (NORMAL_STIFFNESS * AREA_M2)) * 1000;
    const compressionMm = ((FORCE_N * (HEIGHT_MM / 1000)) / (STEEL.youngsModulus * AREA_M2)) * 1000;
    expectRelative(solved.summary.maxDisplacement, settlementMm + compressionMm, FOUNDATION_CLOSED_FORM_RELATIVE_TOLERANCE);
    // The block is held only by the foundation: its springs carry the whole load.
    expectRelative(solved.summary.reactionForce, FORCE_N, REACTION_BALANCE_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("mm-N-s-MPa (k in N/mm^3) and m-N-s-Pa (k in N/m^3) give the same answer", () => {
    const metres = solve(study("static_stress", [foundation]), "m");
    const millimetres = solve(study("static_stress", [foundation]), "mm");
    expectRelative(millimetres.summary.maxDisplacement, metres.summary.maxDisplacement, UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
    expectRelative(millimetres.summary.maxStress, metres.summary.maxStress, UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
    expectRelative(millimetres.summary.reactionForce, metres.summary.reactionForce, UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
    const model = buildOpenFeaCoreModelForStudy(withStoredMesh(study("static_stress", [foundation]), "mm"), displayModel(), [STEEL]).model;
    expect(model.boundaryConditions).toEqual([
      expect.objectContaining({ type: "elasticSupport", normalStiffness: expect.closeTo(0.2, 12), tangentialStiffness: expect.closeTo(0.1, 12) })
    ]);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("a modal study on the foundation alone has no zero-frequency rigid-body modes", () => {
    const solved = solve(study("modal_analysis", [foundation]), "m") as unknown as { summary: { modes: Array<{ frequencyHz: number }> } };
    const massKg = STEEL.density * AREA_M2 * (HEIGHT_MM / 1000);
    const bounceHz = Math.sqrt((NORMAL_STIFFNESS * AREA_M2) / massKg) / (2 * Math.PI);
    const frequencies = solved.summary.modes.map((mode) => mode.frequencyHz);
    expect(frequencies).toHaveLength(6);
    // Free rigid-body modes would sit at ~0 Hz; each foundation mode is a finite fraction of the bounce frequency.
    for (const frequency of frequencies) expect(frequency).toBeGreaterThan(0.1 * bounceHz);
    expect(Math.min(...frequencies.map((frequency) => Math.abs(frequency - bounceHz) / bounceHz))).toBeLessThan(BOUNCE_FREQUENCY_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("a normal-only foundation alone is refused before solving, not solved singular", () => {
    const normalOnly: Constraint = { ...foundation, parameters: { ...foundation.parameters, tangentialStiffness: 0 } };
    const eligibility = openFeaCoreEligibility(withStoredMesh(study("static_stress", [normalOnly]), "m"), displayModel(), undefined, [STEEL]);
    expect(eligibility.ok ? "" : eligibility.reason).toMatch(/only normal or only tangential stiffness cannot hold the part/);
  }, SOLVE_TEST_TIMEOUT_MS);
});

describe("supports saved before elastic supports", () => {
  test("a per-component and symmetry support study reads and solves unchanged", () => {
    // Saved by the R1.4 format: base held in Z only, symmetry rollers on x0 and
    // y0. The three orthogonal planes hold the block statically determinately,
    // so the top compresses exactly F h / (E A) with the base fixed.
    const fixture = readFileSync(new URL("./fixtures/pre-elastic-supports-study.json", import.meta.url), "utf8");
    const saved = StudySchema.parse(JSON.parse(fixture));
    expect(saved.constraints.map((constraint) => [constraint.type, constraint.parameters.components])).toEqual([
      ["fixed", ["z"]],
      ["symmetry", undefined],
      ["symmetry", undefined]
    ]);
    const { model } = buildOpenFeaCoreModelForStudy(withStoredMesh(saved, "m"), displayModel(), [STEEL]);
    expect(model.boundaryConditions.map((condition) => [condition.type, "components" in condition ? condition.components : undefined])).toEqual([
      ["fixed", ["z"]],
      ["fixed", ["x"]],
      ["fixed", ["y"]]
    ]);
    const solved = solve(saved, "m");
    const compressionMm = ((FORCE_N * (HEIGHT_MM / 1000)) / (STEEL.youngsModulus * AREA_M2)) * 1000;
    expectRelative(solved.summary.maxDisplacement, compressionMm, FOUNDATION_CLOSED_FORM_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);
});

type SolvedSummary = { maxStress: number; maxDisplacement: number; reactionForce: number };

function solve(input: Study, units: "m" | "mm"): { summary: SolvedSummary } {
  const solved = trySolveOpenFeaCoreStudy({
    study: withStoredMesh(input, units),
    runId: `run-${input.id}-${units}`,
    displayModel: displayModel(),
    customMaterials: [STEEL]
  });
  if (!solved.ok) throw new Error(`solve failed: ${solved.reason}`);
  return solved.result as unknown as { summary: SolvedSummary };
}

function withStoredMesh(input: Study, units: "m" | "mm"): Study {
  const artifact = blockArtifact(units);
  const model = buildCoreModelFromCloudMesh({
    study: {
      id: input.id,
      type: input.type,
      materialAssignments: input.materialAssignments,
      namedSelections: input.namedSelections,
      constraints: input.constraints,
      loads: input.loads,
      contacts: input.contacts,
      solverSettings: input.solverSettings as Record<string, unknown>
    },
    materials: [STEEL],
    volumeMesh: artifact,
    analysisType: input.type as "static_stress" | "modal_analysis"
  });
  return {
    ...input,
    meshSettings: {
      preset: "medium",
      status: "complete",
      meshRef: "project-1/mesh/wasm-gmsh-mesh.json",
      summary: {
        nodes: artifact.metadata.nodeCount,
        elements: artifact.metadata.elementCount,
        warnings: [],
        source: "wasm_gmsh",
        artifacts: {
          actualCoreModel: { model },
          meshConnectivity: { connectedComponents: artifact.metadata.connectedComponentCount }
        }
      }
    } as Study["meshSettings"]
  };
}

function study(type: "static_stress" | "modal_analysis", constraints: Constraint[]): Study {
  return {
    id: `block-${type}-${constraints.map((constraint) => `${constraint.id}:${String(constraint.parameters.tangentialStiffness)}`).join("+")}`,
    projectId: "project-1",
    name: "Block on foundation",
    type,
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Block" }],
    materialAssignments: [{ id: "assign-steel", materialId: STEEL.id, selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      { id: "selection-body", name: "Block", entityType: "body", geometryRefs: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Block" }], fingerprint: "body" },
      ...FACES.map((face) => ({
        id: `selection-${face}`,
        name: `Face ${face}`,
        entityType: "face" as const,
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: `face-${face}`, label: `Face ${face}` }],
        fingerprint: `face-${face}`
      }))
    ],
    contacts: [],
    constraints,
    loads: type === "modal_analysis" ? [] : [{ id: "top", type: "force", selectionRef: "selection-z1", parameters: { value: FORCE_N, units: "N", direction: [0, 0, -1] }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete" },
    solverSettings: type === "modal_analysis" ? { backend: "opencae_core_local", modeCount: 6 } : { backend: "opencae_core_local" },
    validation: [],
    runs: []
  } as unknown as Study;
}

function displayModel(): DisplayModel {
  const face = (name: FaceName, center: [number, number, number], normal: [number, number, number]) => ({
    id: `face-${name}`,
    label: `Face ${name}`,
    color: "#94a3b8",
    center,
    normal,
    stressValue: 0,
    surfaceType: "planar" as const
  });
  const half = SIDE_MM / 2;
  return {
    id: "display-uploaded",
    name: "Block",
    bodyCount: 1,
    dimensions: { x: SIDE_MM, y: SIDE_MM, z: HEIGHT_MM, units: "mm" },
    faces: [
      face("x0", [0, half, HEIGHT_MM / 2], [-1, 0, 0]),
      face("x1", [SIDE_MM, half, HEIGHT_MM / 2], [1, 0, 0]),
      face("y0", [half, 0, HEIGHT_MM / 2], [0, -1, 0]),
      face("y1", [half, SIDE_MM, HEIGHT_MM / 2], [0, 1, 0]),
      face("z0", [half, half, 0], [0, 0, -1]),
      face("z1", [half, half, HEIGHT_MM], [0, 0, 1])
    ]
  };
}

/** Structured msh v2.2 block in mm: six Kuhn tetrahedra per hex cell, elevated to Tet10. */
function blockArtifact(units: "m" | "mm"): CoreVolumeMeshArtifact {
  const n = [SIDE_MM / CELL_MM, SIDE_MM / CELL_MM, HEIGHT_MM / CELL_MM] as const;
  const nodeId = (i: number, j: number, k: number) => 1 + i + (n[0] + 1) * (j + (n[1] + 1) * k);
  const coordinate = (id: number): [number, number, number] => {
    const index = id - 1;
    const i = index % (n[0] + 1);
    const j = Math.floor(index / (n[0] + 1)) % (n[1] + 1);
    const k = Math.floor(index / ((n[0] + 1) * (n[1] + 1)));
    return [i * CELL_MM, j * CELL_MM, k * CELL_MM];
  };
  const nodes: string[] = [];
  for (let k = 0; k <= n[2]; k += 1) for (let j = 0; j <= n[1]; j += 1) for (let i = 0; i <= n[0]; i += 1) {
    const id = nodeId(i, j, k);
    nodes.push(`${id} ${coordinate(id).join(" ")}`);
  }
  const tets: number[][] = [];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let k = 0; k < n[2]; k += 1) for (let j = 0; j < n[1]; j += 1) for (let i = 0; i < n[0]; i += 1) {
    for (const permutation of permutations) {
      const corner = [i, j, k];
      const path = [nodeId(i, j, k)];
      for (const axis of permutation) {
        corner[axis]! += 1;
        path.push(nodeId(corner[0]!, corner[1]!, corner[2]!));
      }
      tets.push(positivelyOriented(path, coordinate));
    }
  }
  const faceCounts = new Map<string, { nodes: number[]; count: number }>();
  for (const tet of tets) {
    for (const face of [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]) {
      const faceNodes = face.map((local) => tet[local]!);
      const key = [...faceNodes].sort((a, b) => a - b).join(":");
      const entry = faceCounts.get(key);
      if (entry) entry.count += 1;
      else faceCounts.set(key, { nodes: faceNodes, count: 1 });
    }
  }
  const boundaryFaceName = (faceNodes: number[]): FaceName => {
    const points = faceNodes.map(coordinate);
    const on = (axis: number, value: number) => points.every((point) => Math.abs(point[axis]! - value) < 1e-9);
    if (on(0, 0)) return "x0";
    if (on(0, SIDE_MM)) return "x1";
    if (on(1, 0)) return "y0";
    if (on(1, SIDE_MM)) return "y1";
    if (on(2, 0)) return "z0";
    return "z1";
  };
  const facePhysical = (name: FaceName) => 10 + FACES.indexOf(name);
  const triangles = [...faceCounts.values()].filter((entry) => entry.count === 1).map((entry) => ({ nodes: entry.nodes, physical: facePhysical(boundaryFaceName(entry.nodes)) }));
  const physicalNames = [`3 1 "solid"`, ...FACES.map((face) => `2 ${facePhysical(face)} "face_${face}"`)];
  const elements = [
    ...triangles.map((triangle) => `2 2 ${triangle.physical} ${triangle.physical} ${triangle.nodes.join(" ")}`),
    ...tets.map((tet) => `4 2 1 1 ${tet.join(" ")}`)
  ].map((line, index) => `${index + 1} ${line}`);
  const msh = [
    "$MeshFormat", "2.2 0 8", "$EndMeshFormat",
    "$PhysicalNames", String(physicalNames.length), ...physicalNames, "$EndPhysicalNames",
    "$Nodes", String(nodes.length), ...nodes, "$EndNodes",
    "$Elements", String(elements.length), ...elements, "$EndElements"
  ].join("\n");
  const artifact = elevateVolumeMeshArtifactToTet10(parseGmshMeshToCoreVolumeMesh(msh, {
    units: "mm",
    sourceSelectionRefs: Object.fromEntries(FACES.map((face) => [`face_${face}`, { sourceSelectionRef: `selection-${face}`, sourceFaceId: `face-${face}` }]))
  }));
  if (units === "m") return artifact;
  const scale = (point: [number, number, number]): [number, number, number] => [point[0] * 1000, point[1] * 1000, point[2] * 1000];
  return {
    ...artifact,
    nodes: { coordinates: artifact.nodes.coordinates.map((value) => value * 1000) },
    surfaceFacets: artifact.surfaceFacets.map((facet) => ({
      ...facet,
      ...(facet.area !== undefined ? { area: facet.area * 1e6 } : {}),
      ...(facet.center ? { center: scale(facet.center) } : {})
    })),
    coordinateSystem: { solverUnits: "mm-N-s-MPa", renderCoordinateSpace: "solver" }
  };
}

function positivelyOriented(nodes: number[], coordinate: (id: number) => [number, number, number]): number[] {
  const [a, b, c, d] = nodes.map(coordinate) as unknown as [number[], number[], number[], number[]];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  const w = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
  const volume = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  return volume > 0 ? nodes : [nodes[0]!, nodes[2]!, nodes[1]!, nodes[3]!];
}

function expectRelative(actual: number | undefined, expected: number, tolerance: number): void {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected) / Math.abs(expected), `actual ${actual} vs expected ${expected}`).toBeLessThan(tolerance);
}
