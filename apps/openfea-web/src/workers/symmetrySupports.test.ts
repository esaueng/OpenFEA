// Per-component fixed and symmetry/roller supports (plan 036 R1.4) through the
// product path: mesh-time Core model from @openfea/mesh-intake (as wasmMeshing
// builds it), stored on the study, then the adapter rebuilds the supports and
// the browser-local solver runs.
//
// The cantilever is the accuracy benchmark's 180 x 24 x 24 mm steel bar. Its
// structured Tet10 mesh is generated mirror-symmetric about the y = 0 and
// z = 0 mid-planes, so the half and quarter meshes are exactly the retained
// part of the full mesh. The cut models must then reproduce the full model to
// linear-solve round-off, which is what the named tolerance allows.
//
// Under a vertical tip load the bar is symmetric about the y = 0 plane but
// antisymmetric about the z = 0 neutral plane. The half model therefore uses a
// symmetry support (uy = 0) on y = 0. The quarter model adds the antisymmetry
// condition on z = 0, which holds the in-plane components (ux = uy = 0) and
// leaves uz free: a per-component fixed support. An axial load is symmetric
// about both planes, so its quarter model uses two symmetry supports.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildCoreModelFromCloudMesh, elevateVolumeMeshArtifactToTet10, parseGmshMeshToCoreVolumeMesh, type CoreVolumeMeshArtifact } from "@openfea/mesh-intake";
import { buildOpenFeaCoreModelForStudy } from "@openfea/core-adapter";
import { StudySchema, type Constraint, type CustomMaterial, type DisplayModel, type Load, type Study } from "@openfea/schema";
import { trySolveOpenFeaCoreStudy } from "./openfeaCoreSolve";

/**
 * Relative tolerance for a cut model against the full model on an exactly
 * mirrored mesh. Both solves stop at the sparse CG relative-residual tolerance
 * (1e-10), so agreement is limited by that round-off, not by discretization.
 */
const SYMMETRY_MODEL_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance for the same model in m-N-s-Pa and mm-N-s-MPa. */
const UNIT_EQUIVALENCE_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance on |sum of reactions| against the applied load. */
const REACTION_BALANCE_RELATIVE_TOLERANCE = 1e-6;
/** Each case solves a few thousand-DOF Tet10 models; CI shares four cores between suites. */
const SOLVE_TEST_TIMEOUT_MS = 60_000;

const LENGTH_MM = 180;
const SIDE_MM = 24;
const CELL_X_MM = 12;
const CELL_YZ_MM = 6;
const FORCE_N = 500;

const STEEL: CustomMaterial = {
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "Benchmark steel",
  category: "metal",
  youngsModulus: 200e9,
  poissonRatio: 0.29,
  density: 7850,
  yieldStrength: 250e6,
  verification: "user_supplied_unverified"
};

const FACES = ["x0", "xL", "y0", "y1", "z0", "z1"] as const;
type FaceName = (typeof FACES)[number];
type Extent = { y: [number, number]; z: [number, number] };

const FULL: Extent = { y: [-SIDE_MM / 2, SIDE_MM / 2], z: [-SIDE_MM / 2, SIDE_MM / 2] };
const HALF: Extent = { y: [0, SIDE_MM / 2], z: [-SIDE_MM / 2, SIDE_MM / 2] };
const QUARTER: Extent = { y: [0, SIDE_MM / 2], z: [0, SIDE_MM / 2] };

const fixedRoot: Constraint = support("root", "fixed", "x0");
const symmetryY: Constraint = support("sym-y", "symmetry", "y0");
const symmetryZ: Constraint = support("sym-z", "symmetry", "z0");
const antisymmetryZ: Constraint = support("anti-z", "fixed", "z0", { components: ["x", "y"] });

describe("symmetry supports: cantilever half and quarter models (plan 036 R1.4 gate)", () => {
  // Solved once, on first use, inside a test (and its timeout) rather than at collection.
  let fullModel: ReturnType<typeof solve> | undefined;
  const full = () => (fullModel ??= solve(study(FULL, [fixedRoot], tipLoad(FORCE_N, [0, 0, -1])), FULL, "m"));

  test("a half model with a y-symmetry support matches the full-model tip deflection and peak stress", () => {
    const half = solve(study(HALF, [fixedRoot, symmetryY], tipLoad(FORCE_N / 2, [0, 0, -1])), HALF, "m");
    expectRelative(half.summary.maxDisplacement, full().summary.maxDisplacement, SYMMETRY_MODEL_RELATIVE_TOLERANCE);
    expectRelative(half.summary.maxStress, full().summary.maxStress, SYMMETRY_MODEL_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("a quarter model with symmetry and an antisymmetric per-component support matches the full model", () => {
    const quarter = solve(study(QUARTER, [fixedRoot, symmetryY, antisymmetryZ], tipLoad(FORCE_N / 4, [0, 0, -1])), QUARTER, "m");
    expectRelative(quarter.summary.maxDisplacement, full().summary.maxDisplacement, SYMMETRY_MODEL_RELATIVE_TOLERANCE);
    expectRelative(quarter.summary.maxStress, full().summary.maxStress, SYMMETRY_MODEL_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("an axially loaded quarter model with two symmetry supports matches the full model", () => {
    const fullAxial = solve(study(FULL, [fixedRoot], tipLoad(FORCE_N, [1, 0, 0])), FULL, "m");
    const quarterAxial = solve(study(QUARTER, [fixedRoot, symmetryY, symmetryZ], tipLoad(FORCE_N / 4, [1, 0, 0])), QUARTER, "m");
    expectRelative(quarterAxial.summary.maxDisplacement, fullAxial.summary.maxDisplacement, SYMMETRY_MODEL_RELATIVE_TOLERANCE);
    expectRelative(quarterAxial.summary.maxStress, fullAxial.summary.maxStress, SYMMETRY_MODEL_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("the full model is a sane cantilever (Timoshenko tip deflection within 5%)", () => {
    // Sanity check on the benchmark, not the gate: a clamped 3D root is a
    // little stiffer than the beam idealization.
    const inertia = SIDE_MM ** 4 / 12;
    const shear = STEEL.youngsModulus / (2 * (1 + STEEL.poissonRatio)) / 1e6;
    const young = STEEL.youngsModulus / 1e6;
    const timoshenkoMm = (FORCE_N * LENGTH_MM ** 3) / (3 * young * inertia) + (FORCE_N * LENGTH_MM) / ((5 / 6) * shear * SIDE_MM ** 2);
    expectRelative(full().summary.maxDisplacement, timoshenkoMm, 0.05);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("mm-N-s-MPa and m-N-s-Pa solve the half model to the same answer", () => {
    const loads = tipLoad(FORCE_N / 2, [0, 0, -1]);
    const metres = solve(study(HALF, [fixedRoot, symmetryY], loads), HALF, "m");
    const millimetres = solve(study(HALF, [fixedRoot, symmetryY], loads), HALF, "mm");
    expectRelative(millimetres.summary.maxDisplacement, metres.summary.maxDisplacement, UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
    expectRelative(millimetres.summary.maxStress, metres.summary.maxStress, UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
    expectRelative(millimetres.summary.reactionForce, metres.summary.reactionForce, UNIT_EQUIVALENCE_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("reactions at the root and the symmetry planes balance the applied load", () => {
    // reactionForce is |sum of all support reactions|, symmetry planes included.
    expectRelative(full().summary.reactionForce, FORCE_N, REACTION_BALANCE_RELATIVE_TOLERANCE);
    const half = solve(study(HALF, [fixedRoot, symmetryY], tipLoad(FORCE_N / 2, [0, 0, -1])), HALF, "mm");
    expectRelative(half.summary.reactionForce, FORCE_N / 2, REACTION_BALANCE_RELATIVE_TOLERANCE);
    const quarter = solve(study(QUARTER, [fixedRoot, symmetryY, antisymmetryZ], tipLoad(FORCE_N / 4, [0, 0, -1])), QUARTER, "m");
    expectRelative(quarter.summary.reactionForce, FORCE_N / 4, REACTION_BALANCE_RELATIVE_TOLERANCE);
  }, SOLVE_TEST_TIMEOUT_MS);

  test("the symmetry support becomes a one-component Core fixed condition on the face normal", () => {
    const half = withStoredMesh(study(HALF, [fixedRoot, symmetryY], tipLoad(FORCE_N / 2, [0, 0, -1])), HALF, "m");
    const { model } = buildOpenFeaCoreModelForStudy(half, displayModel(HALF), [STEEL]);
    expect(model.boundaryConditions.map((condition) => [condition.name, condition.type, "components" in condition ? condition.components : undefined])).toEqual([
      ["fixedSupport0", "fixed", ["x", "y", "z"]],
      ["symmetrySupport1", "fixed", ["y"]]
    ]);
    const quarter = withStoredMesh(study(QUARTER, [fixedRoot, symmetryY, antisymmetryZ], tipLoad(FORCE_N / 4, [0, 0, -1])), QUARTER, "m");
    const quarterModel = buildOpenFeaCoreModelForStudy(quarter, displayModel(QUARTER), [STEEL]).model;
    expect(quarterModel.boundaryConditions.find((condition) => condition.name === "fixedSupport2")).toMatchObject({ type: "fixed", components: ["x", "y"] });
  }, SOLVE_TEST_TIMEOUT_MS);

  test("a symmetry face off every global axis is rejected with an explicit error, never snapped", () => {
    const tilted = study(HALF, [fixedRoot, symmetryY], tipLoad(FORCE_N / 2, [0, 0, -1]));
    // Meshing time (mesh-intake builds the stored model).
    expect(() => buildStoredModel(tilted, rotatedAboutX(cantileverArtifact(HALF, "m"), 10))).toThrow(/Support sym-y: .*within 1° of a global axis; the selected face is 10° from the Y axis/);
    // Run time (the adapter rebuilds supports on a mesh stored without them).
    const meshedWithFixedOnly = { ...tilted, constraints: [fixedRoot] };
    const stored = withStoredMesh(tilted, HALF, "m", { meshedWith: meshedWithFixedOnly, transform: (artifact) => rotatedAboutX(artifact, 10) });
    expect(() => buildOpenFeaCoreModelForStudy(stored, displayModel(HALF), [STEEL])).toThrow(/Support sym-y: .*10° from the Y axis/);
  }, SOLVE_TEST_TIMEOUT_MS);
});

describe("legacy fixed supports", () => {
  test("a study saved before per-component supports parses and holds x, y and z", () => {
    const fixture = readFileSync(new URL("./fixtures/legacy-fixed-support-study.json", import.meta.url), "utf8");
    const legacy = StudySchema.parse(JSON.parse(fixture));
    expect(legacy.constraints).toEqual([
      { id: "constraint-root", type: "fixed", selectionRef: "selection-x0", parameters: { label: "FS 1" }, status: "complete" }
    ]);
    const { model } = buildOpenFeaCoreModelForStudy(withStoredMesh(legacy, FULL, "m"), displayModel(FULL), [STEEL]);
    expect(model.boundaryConditions).toEqual([expect.objectContaining({ name: "fixedSupport0", type: "fixed", components: ["x", "y", "z"] })]);

    // An explicit all-components support is the same support.
    const explicit: Study = { ...legacy, constraints: legacy.constraints.map((constraint) => ({ ...constraint, parameters: { ...constraint.parameters, components: ["x", "y", "z"] } })) };
    const legacyResult = solve(legacy, FULL, "m");
    const explicitResult = solve(explicit, FULL, "m");
    expect(explicitResult.summary).toEqual(legacyResult.summary);
  }, SOLVE_TEST_TIMEOUT_MS);
});

type SolvedSummary = { maxStress: number; maxDisplacement: number; reactionForce: number; safetyFactor: number };

function solve(input: Study, extent: Extent, units: "m" | "mm"): { summary: SolvedSummary } {
  const solved = trySolveOpenFeaCoreStudy({
    study: withStoredMesh(input, extent, units),
    runId: `run-${input.id}-${units}`,
    displayModel: displayModel(extent),
    customMaterials: [STEEL]
  });
  if (!solved.ok) throw new Error(`solve failed: ${solved.reason}`);
  return solved.result as unknown as { summary: SolvedSummary };
}

function buildStoredModel(meshedWith: Study, artifact: CoreVolumeMeshArtifact) {
  return buildCoreModelFromCloudMesh({
    study: {
      id: meshedWith.id,
      type: meshedWith.type,
      materialAssignments: meshedWith.materialAssignments,
      namedSelections: meshedWith.namedSelections,
      constraints: meshedWith.constraints,
      loads: meshedWith.loads,
      contacts: meshedWith.contacts
    },
    materials: [STEEL],
    volumeMesh: artifact,
    analysisType: "static_stress"
  });
}

function withStoredMesh(
  input: Study,
  extent: Extent,
  units: "m" | "mm",
  options: { meshedWith?: Study; transform?: (artifact: CoreVolumeMeshArtifact) => CoreVolumeMeshArtifact } = {}
): Study {
  const raw = cantileverArtifact(extent, units);
  const artifact = options.transform ? options.transform(raw) : raw;
  const model = buildStoredModel(options.meshedWith ?? input, artifact);
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

function support(id: string, type: "fixed" | "symmetry", face: FaceName, parameters: Record<string, unknown> = {}): Constraint {
  return { id, type, selectionRef: `selection-${face}`, parameters: { label: id, ...parameters }, status: "complete" };
}

function tipLoad(value: number, direction: [number, number, number]): Load[] {
  return [{ id: "tip", type: "force", selectionRef: "selection-xL", parameters: { value, units: "N", direction }, status: "complete" }];
}

function study(extent: Extent, constraints: Constraint[], loads: Load[]): Study {
  const id = `cantilever-${extent.y.join("_")}-${extent.z.join("_")}-${constraints.map((constraint) => constraint.id).join("+")}-${loads[0]!.parameters.direction}`;
  return {
    id,
    projectId: "project-1",
    name: "Cantilever",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Cantilever" }],
    materialAssignments: [{ id: "assign-steel", materialId: STEEL.id, selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      { id: "selection-body", name: "Cantilever", entityType: "body", geometryRefs: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Cantilever" }], fingerprint: "body" },
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
    loads,
    meshSettings: { preset: "medium", status: "complete" },
    solverSettings: { backend: "opencae_core_local" },
    validation: [],
    runs: []
  } as unknown as Study;
}

function displayModel(extent: Extent): DisplayModel {
  const yMid = (extent.y[0] + extent.y[1]) / 2;
  const zMid = (extent.z[0] + extent.z[1]) / 2;
  const face = (name: FaceName, center: [number, number, number], normal: [number, number, number]) => ({
    id: `face-${name}`,
    label: `Face ${name}`,
    color: "#94a3b8",
    center,
    normal,
    stressValue: 0,
    surfaceType: "planar" as const
  });
  return {
    id: "display-uploaded",
    name: "Cantilever",
    bodyCount: 1,
    dimensions: { x: LENGTH_MM, y: extent.y[1] - extent.y[0], z: extent.z[1] - extent.z[0], units: "mm" },
    faces: [
      face("x0", [0, yMid, zMid], [-1, 0, 0]),
      face("xL", [LENGTH_MM, yMid, zMid], [1, 0, 0]),
      face("y0", [LENGTH_MM / 2, extent.y[0], zMid], [0, -1, 0]),
      face("y1", [LENGTH_MM / 2, extent.y[1], zMid], [0, 1, 0]),
      face("z0", [LENGTH_MM / 2, yMid, extent.z[0]], [0, 0, -1]),
      face("z1", [LENGTH_MM / 2, yMid, extent.z[1]], [0, 0, 1])
    ]
  };
}

/**
 * Structured msh v2.2 bar in mm, split into six Kuhn tetrahedra per hex cell
 * and elevated to Tet10. Each cell starts its Kuhn paths at the corner nearest
 * the y = 0 and z = 0 planes, so the decomposition (and the whole mesh) is
 * mirror-symmetric about both mid-planes and a cut model is exactly the
 * retained part of the full mesh.
 */
function cantileverArtifact(extent: Extent, units: "m" | "mm"): CoreVolumeMeshArtifact {
  const nx = LENGTH_MM / CELL_X_MM;
  const ny = (extent.y[1] - extent.y[0]) / CELL_YZ_MM;
  const nz = (extent.z[1] - extent.z[0]) / CELL_YZ_MM;
  const nodeId = (i: number, j: number, k: number) => 1 + i + (nx + 1) * (j + (ny + 1) * k);
  const coordinate = (id: number): [number, number, number] => {
    const index = id - 1;
    const i = index % (nx + 1);
    const j = Math.floor(index / (nx + 1)) % (ny + 1);
    const k = Math.floor(index / ((nx + 1) * (ny + 1)));
    return [i * CELL_X_MM, extent.y[0] + j * CELL_YZ_MM, extent.z[0] + k * CELL_YZ_MM];
  };
  const nodes: string[] = [];
  for (let k = 0; k <= nz; k += 1) for (let j = 0; j <= ny; j += 1) for (let i = 0; i <= nx; i += 1) {
    const id = nodeId(i, j, k);
    nodes.push(`${id} ${coordinate(id).join(" ")}`);
  }
  const tets: number[][] = [];
  const axisPermutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let k = 0; k < nz; k += 1) for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    const flipY = extent.y[0] + (j + 0.5) * CELL_YZ_MM < 0;
    const flipZ = extent.z[0] + (k + 0.5) * CELL_YZ_MM < 0;
    const origin = [i, flipY ? j + 1 : j, flipZ ? k + 1 : k];
    const step = [1, flipY ? -1 : 1, flipZ ? -1 : 1];
    for (const permutation of axisPermutations) {
      const corner = [...origin];
      const path = [nodeId(corner[0]!, corner[1]!, corner[2]!)];
      for (const axis of permutation) {
        corner[axis]! += step[axis]!;
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
    const on = (axis: number, value: number) => points.every((point) => near(point[axis]!, value));
    if (on(0, 0)) return "x0";
    if (on(0, LENGTH_MM)) return "xL";
    if (on(1, extent.y[0])) return "y0";
    if (on(1, extent.y[1])) return "y1";
    if (on(2, extent.z[0])) return "z0";
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
  return units === "m" ? artifact : millimetreArtifact(artifact);
}

/** The same mesh expressed in mm-N-s-MPa solver units. */
function millimetreArtifact(artifact: CoreVolumeMeshArtifact): CoreVolumeMeshArtifact {
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

/** Rigidly rotates the mesh about the X axis, so the y and z faces tilt off their axes. */
function rotatedAboutX(artifact: CoreVolumeMeshArtifact, degrees: number): CoreVolumeMeshArtifact {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotate = (y: number, z: number): [number, number] => [y * cos - z * sin, y * sin + z * cos];
  const coordinates = [...artifact.nodes.coordinates];
  for (let index = 0; index < coordinates.length; index += 3) {
    const [y, z] = rotate(coordinates[index + 1]!, coordinates[index + 2]!);
    coordinates[index + 1] = y;
    coordinates[index + 2] = z;
  }
  return {
    ...artifact,
    nodes: { coordinates },
    surfaceFacets: artifact.surfaceFacets.map((facet) => {
      const { normal, center, ...rest } = facet;
      return {
        ...rest,
        ...(normal ? { normal: [normal[0], ...rotate(normal[1], normal[2])] as [number, number, number] } : {}),
        ...(center ? { center: [center[0], ...rotate(center[1], center[2])] as [number, number, number] } : {})
      };
    })
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

function near(value: number | undefined, target: number): boolean {
  return value !== undefined && Math.abs(value - target) < 1e-6;
}

function expectRelative(actual: number | undefined, expected: number, tolerance: number): void {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected) / Math.abs(expected), `actual ${actual} vs expected ${expected}`).toBeLessThan(tolerance);
}
