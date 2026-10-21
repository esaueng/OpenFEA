// Per-body materials (plan 036 R1.3) through the product path: mesh-time Core
// model from @openfea/mesh-intake (as wasmMeshing builds it), stored on the
// study, then the adapter re-applies the study's current assignments and the
// browser-local solver runs. The bar is a structured Tet4 grid whose interface
// lies on element faces, so linear tetrahedra reproduce the piecewise-linear
// closed-form fields exactly; the tolerances only absorb solver round-off.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildCoreModelFromCloudMesh, parseGmshMeshToCoreVolumeMesh, type CoreVolumeMeshArtifact } from "@openfea/mesh-intake";
import { buildOpenFeaCoreModelForStudy, openFeaCoreEligibility } from "@openfea/core-adapter";
import { StudySchema, type CustomMaterial, type DisplayModel, type ResultField, type Study } from "@openfea/schema";
import { trySolveOpenFeaCoreStudy } from "./openfeaCoreSolve";

/** Relative tolerance for closed-form agreement (exact for Tet4 up to linear-solve round-off). */
const CLOSED_FORM_RELATIVE_TOLERANCE = 1e-6;
/** Relative tolerance for "same answer" comparisons (unit systems, legacy projects). */
const EQUIVALENCE_RELATIVE_TOLERANCE = 1e-9;

const L1_MM = 60;
const L2_MM = 40;
const SIDE_MM = 20;
const CELL_MM = 10;
const FORCE_N = 8000;
const AREA_M2 = (SIDE_MM / 1000) ** 2;

const MATERIAL_A: CustomMaterial = {
  id: "00000000-0000-4000-8000-00000000000a",
  name: "Series A",
  category: "metal",
  youngsModulus: 200e9,
  poissonRatio: 0.3,
  density: 7850,
  yieldStrength: 250e6,
  thermalConductivity: 50,
  verification: "user_supplied_unverified"
};
// Equal lateral strain ν/E in both bodies: otherwise the bonded interface
// restrains the mismatched contraction and the stress is no longer exactly
// uniaxial near it.
const MATERIAL_B: CustomMaterial = {
  ...MATERIAL_A,
  id: "00000000-0000-4000-8000-00000000000b",
  name: "Series B",
  youngsModulus: 70e9,
  poissonRatio: 0.3 * (70e9 / 200e9),
  yieldStrength: 120e6,
  thermalConductivity: 200
};
const CUSTOM_MATERIALS = [MATERIAL_A, MATERIAL_B];
const BODY_1 = "step-object-1";
const BODY_2 = "step-object-2";

const FACES = ["x0", "xL", "y0", "yB", "z0", "zB"] as const;
type FaceName = (typeof FACES)[number];

describe("per-body materials: two bars in series", () => {
  test("gate 1: tip displacement is F(L1/(E1 A) + L2/(E2 A)) and stress is a uniform F/A in both bodies", () => {
    const study = perBodyStudy("static_stress");
    const result = solve(study, "m");
    const expectedTipM = FORCE_N * ((L1_MM / 1000) / (MATERIAL_A.youngsModulus * AREA_M2) + (L2_MM / 1000) / (MATERIAL_B.youngsModulus * AREA_M2));
    const tip = surfaceNodeValues(result, "displacement", (point) => near(point[0], L1_MM + L2_MM));
    expect(tip.length).toBeGreaterThan(0);
    for (const ux of tip.map((vector) => vector[0]!)) expectRelative(ux / 1000, expectedTipM, CLOSED_FORM_RELATIVE_TOLERANCE);

    const interfaceUx = surfaceNodeValues(result, "displacement", (point) => near(point[0], L1_MM)).map((vector) => vector[0]!);
    const expectedInterfaceM = FORCE_N * (L1_MM / 1000) / (MATERIAL_A.youngsModulus * AREA_M2);
    for (const ux of interfaceUx) expectRelative(ux / 1000, expectedInterfaceM, CLOSED_FORM_RELATIVE_TOLERANCE);

    const vonMisesPa = elementField(result, "stress", "von_mises").values.map((value) => value * 1e6);
    expect(vonMisesPa.length).toBe(elementCount());
    for (const value of vonMisesPa) expectRelative(value, FORCE_N / AREA_M2, CLOSED_FORM_RELATIVE_TOLERANCE);
  });

  test("safety factor uses each element's own yield strength", () => {
    const result = solve(perBodyStudy("static_stress"), "m");
    const stressPa = FORCE_N / AREA_M2;
    const safety = elementField(result, "safety_factor").values;
    const expected = new Set([MATERIAL_A.yieldStrength / stressPa, MATERIAL_B.yieldStrength / stressPa].map((value) => value.toPrecision(6)));
    expect(new Set(safety.map((value) => value.toPrecision(6)))).toEqual(expected);
    expectRelative(result.summary.safetyFactor, MATERIAL_B.yieldStrength / stressPa, CLOSED_FORM_RELATIVE_TOLERANCE);
  });

  test("gate 2: steady conduction through two conductivities gives the closed-form interface temperature", () => {
    const result = solve(perBodyStudy("steady_state_thermal"), "m");
    const k1OverL1 = MATERIAL_A.thermalConductivity! / (L1_MM / 1000);
    const k2OverL2 = MATERIAL_B.thermalConductivity! / (L2_MM / 1000);
    const expected = (k1OverL1 * HOT_C + k2OverL2 * COLD_C) / (k1OverL1 + k2OverL2);
    const temperatures = surfaceNodeValues(result, "temperature", (point) => near(point[0], L1_MM)).map((value) => value[0]!);
    expect(temperatures.length).toBeGreaterThan(0);
    for (const temperature of temperatures) expectRelative(temperature, expected, CLOSED_FORM_RELATIVE_TOLERANCE);
  });

  test("gate 3: a mm-N-s-MPa mesh solves to the same per-body answer as m-N-s-Pa", () => {
    for (const type of ["static_stress", "steady_state_thermal"] as const) {
      const metre = solve(perBodyStudy(type), "m");
      const millimetre = solve(perBodyStudy(type), "mm");
      const mode = type === "static_stress" ? "displacement" : "temperature";
      const pick = (point: number[]) => near(point[0], L1_MM + L2_MM) || near(point[0], L1_MM);
      const a = surfaceNodeValues(metre, mode, pick);
      const b = surfaceNodeValues(millimetre, mode, pick);
      expect(b.length).toBe(a.length);
      a.forEach((vector, index) => expectRelative(b[index]![0]!, vector[0]!, EQUIVALENCE_RELATIVE_TOLERANCE));
      if (type === "static_stress") {
        expectRelative(millimetre.summary.maxStress, metre.summary.maxStress, EQUIVALENCE_RELATIVE_TOLERANCE);
        expectRelative(millimetre.summary.safetyFactor, metre.summary.safetyFactor, EQUIVALENCE_RELATIVE_TOLERANCE);
      }
    }
  });

  test("the run applies the current per-body assignments to a mesh made with different ones", () => {
    const meshedWith = perBodyStudy("static_stress");
    const swapped: Study = {
      ...meshedWith,
      materialAssignments: meshedWith.materialAssignments.map((assignment) => ({
        ...assignment,
        materialId: assignment.bodyId === BODY_1 ? MATERIAL_B.id : MATERIAL_A.id
      }))
    };
    const core = buildOpenFeaCoreModelForStudy(withStoredMesh(swapped, meshedWith, "m"), displayModel(), CUSTOM_MATERIALS);
    const youngByBlock = new Map(core.model.elementBlocks.map((block) => [
      block.name,
      core.model.materials.find((material) => material.name === block.material)?.youngModulus
    ]));
    expect(youngByBlock).toEqual(new Map([[`body:${BODY_1}`, MATERIAL_B.youngsModulus], [`body:${BODY_2}`, MATERIAL_A.youngsModulus]]));
  });

  test("a body without its own assignment uses the whole-model material", () => {
    const study = perBodyStudy("static_stress");
    const inherited: Study = {
      ...study,
      materialAssignments: [
        { id: "default", materialId: MATERIAL_A.id, selectionRef: "selection-body", parameters: {}, status: "complete" },
        { id: "body-2", materialId: MATERIAL_B.id, selectionRef: "selection-body", bodyId: BODY_2, parameters: {}, status: "complete" }
      ]
    };
    const result = solve(inherited, "m");
    const reference = solve(study, "m");
    expectRelative(result.summary.maxDisplacement, reference.summary.maxDisplacement, EQUIVALENCE_RELATIVE_TOLERANCE);
  });

  test("a body with no material at all fails the run honestly", () => {
    const study = perBodyStudy("static_stress");
    const missing: Study = { ...study, materialAssignments: study.materialAssignments.filter((assignment) => assignment.bodyId === BODY_2) };
    expect(() => buildOpenFeaCoreModelForStudy(withStoredMesh(missing, study, "m"), displayModel(), CUSTOM_MATERIALS)).toThrow(/Body 1 has no material/);
  });

  test("differing per-body materials on a mesh without body identity ask for a new mesh", () => {
    const study = perBodyStudy("static_stress");
    const legacyMesh = withStoredMesh(study, legacyStudy(), "m", { bodyIdentity: false });
    expect(() => buildOpenFeaCoreModelForStudy(legacyMesh, displayModel(), CUSTOM_MATERIALS)).toThrow(/Generate the mesh again/);
    const eligibility = openFeaCoreEligibility(legacyMesh, displayModel(), undefined, CUSTOM_MATERIALS);
    expect(eligibility.ok ? "" : eligibility.reason).toMatch(/Generate the mesh again/);
    // With no stored mesh the run meshes first (with body identity), so it stays eligible.
    const unmeshed: Study = { ...study, meshSettings: { preset: "medium", status: "complete" } };
    const stepModel = { ...displayModel(), nativeCad: { format: "step" as const, filename: "series-bars.step" } };
    expect(openFeaCoreEligibility(unmeshed, stepModel, { canMeshOnDemand: true }, CUSTOM_MATERIALS)).toEqual({ ok: true });
  });
});

describe("legacy single-material projects", () => {
  // Captured on main before per-body materials (29f1ad5) by solving this same
  // fixture study on the same mesh without body identity.
  const LEGACY_TIP_UX_MM = [
    0.010000000000023752, 0.010000000000010653, 0.00999999999999953,
    0.010000000000005019, 0.009999999999992421, 0.009999999999985089,
    0.009999999999994217, 0.010000000000003038, 0.009999999999987614
  ];
  const LEGACY_SUMMARY = { maxStress: 20.000000000493767, maxDisplacement: 0.010035935432226657, safetyFactor: 12.499999999691395 };

  test("an old single-assignment study parses and solves to the same displacement", () => {
    const fixture = readFileSync(new URL("./fixtures/legacy-single-material-study.json", import.meta.url), "utf8");
    const study = StudySchema.parse(JSON.parse(fixture));
    expect(study).toEqual({ ...legacyStudy(), loadCases: study.loadCases, loadCombinations: study.loadCombinations });
    expect(study.materialAssignments).toEqual([
      { id: "assign-material-current", materialId: MATERIAL_A.id, selectionRef: "selection-body", parameters: {}, status: "complete" }
    ]);
    const result = solve(study, "m", { bodyIdentity: false });
    const tip = surfaceNodeValues(result, "displacement", (point) => near(point[0], L1_MM + L2_MM)).map((vector) => vector[0]!);
    expect(tip.length).toBe(LEGACY_TIP_UX_MM.length);
    tip.forEach((ux, index) => expectRelative(ux, LEGACY_TIP_UX_MM[index]!, EQUIVALENCE_RELATIVE_TOLERANCE));
    for (const key of ["maxStress", "maxDisplacement", "safetyFactor"] as const) {
      expectRelative(result.summary[key], LEGACY_SUMMARY[key], EQUIVALENCE_RELATIVE_TOLERANCE);
    }
    const core = buildOpenFeaCoreModelForStudy(withStoredMesh(study, study, "m", { bodyIdentity: false }), displayModel(), CUSTOM_MATERIALS);
    expect(core.model.materials.map((material) => material.name)).toEqual([MATERIAL_A.id]);
    expect(core.model.elementBlocks.map((block) => block.name)).toEqual(["solid"]);
  });
});

const HOT_C = 100;
const COLD_C = 20;

type SolvedResult = { summary: Record<"maxStress" | "maxDisplacement" | "safetyFactor", number>; fields: ResultField[]; surfaceMesh?: { nodes: number[][] }; solverUnits: "m" | "mm" };

function solve(study: Study, units: "m" | "mm", options: { bodyIdentity?: boolean } = {}): SolvedResult {
  const solved = trySolveOpenFeaCoreStudy({
    study: withStoredMesh(study, study, units, options),
    runId: `run-${study.type}-${units}`,
    displayModel: displayModel(),
    customMaterials: CUSTOM_MATERIALS
  });
  if (!solved.ok) throw new Error(`solve failed: ${solved.reason}`);
  return { ...(solved.result as unknown as SolvedResult), solverUnits: units };
}

function withStoredMesh(study: Study, meshedWith: Study, units: "m" | "mm", options: { bodyIdentity?: boolean } = {}): Study {
  const artifact = seriesBarArtifact(units, options.bodyIdentity ?? true);
  const model = buildCoreModelFromCloudMesh({
    study: {
      id: meshedWith.id,
      type: meshedWith.type,
      materialAssignments: meshedWith.materialAssignments,
      namedSelections: meshedWith.namedSelections,
      constraints: meshedWith.constraints,
      loads: meshedWith.loads,
      contacts: meshedWith.contacts
    },
    materials: CUSTOM_MATERIALS,
    volumeMesh: artifact,
    analysisType: meshedWith.type as "static_stress" | "steady_state_thermal"
  });
  return {
    ...study,
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

function perBodyStudy(type: "static_stress" | "steady_state_thermal"): Study {
  return {
    ...baseStudy(type),
    materialAssignments: [
      { id: `assign-material-${BODY_1}`, materialId: MATERIAL_A.id, selectionRef: "selection-body", bodyId: BODY_1, parameters: {}, status: "complete" },
      { id: `assign-material-${BODY_2}`, materialId: MATERIAL_B.id, selectionRef: "selection-body", bodyId: BODY_2, parameters: {}, status: "complete" }
    ]
  };
}

function legacyStudy(): Study {
  return {
    ...baseStudy("static_stress"),
    materialAssignments: [{ id: "assign-material-current", materialId: MATERIAL_A.id, selectionRef: "selection-body", parameters: {}, status: "complete" }]
  };
}

function baseStudy(type: "static_stress" | "steady_state_thermal"): Study {
  const faceSelections = FACES.map((face) => ({
    id: `selection-${face}`,
    name: `Face ${face}`,
    entityType: "face" as const,
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: `face-${face}`, label: `Face ${face}` }],
    fingerprint: `face-${face}`
  }));
  // Symmetry rollers on x0/y0/z0 leave the bar free to contract laterally, so
  // the closed-form uniaxial state is the exact solution.
  const roller = (face: FaceName, component: "x" | "y" | "z") => ({
    id: `support-${face}`,
    type: "prescribed_displacement" as const,
    selectionRef: `selection-${face}`,
    parameters: { component, value: 0 },
    status: "complete" as const
  });
  const common = {
    id: `study-${type}`,
    projectId: "project-1",
    name: "Series bars",
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: "Series bars" }],
    namedSelections: [
      { id: "selection-body", name: "Series bars", entityType: "body" as const, geometryRefs: [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: "Series bars" }], fingerprint: "body" },
      ...faceSelections
    ],
    contacts: [],
    meshSettings: { preset: "medium" as const, status: "complete" as const },
    validation: [],
    runs: []
  };
  if (type === "steady_state_thermal") {
    return {
      ...common,
      type,
      materialAssignments: [],
      constraints: [
        { id: "hot", type: "prescribed_temperature", selectionRef: "selection-x0", parameters: { value: HOT_C, units: "°C" }, status: "complete" },
        { id: "cold", type: "prescribed_temperature", selectionRef: "selection-xL", parameters: { value: COLD_C, units: "°C" }, status: "complete" }
      ],
      loads: [],
      solverSettings: { backend: "opencae_core_local" }
    } as unknown as Study;
  }
  return {
    ...common,
    type,
    materialAssignments: [],
    constraints: [roller("x0", "x"), roller("y0", "y"), roller("z0", "z")],
    loads: [{ id: "pull", type: "force", selectionRef: "selection-xL", parameters: { value: FORCE_N, units: "N", direction: [1, 0, 0] }, status: "complete" }],
    solverSettings: { backend: "opencae_core_local" }
  } as unknown as Study;
}

function displayModel(): DisplayModel {
  const length = L1_MM + L2_MM;
  const half = SIDE_MM / 2;
  const face = (name: FaceName, center: [number, number, number], normal: [number, number, number]) => ({
    id: `face-${name}`,
    label: `Face ${name}`,
    color: "#94a3b8",
    center,
    normal,
    stressValue: 0
  });
  return {
    id: "display-uploaded",
    name: "Series bars",
    bodyCount: 1,
    dimensions: { x: length, y: SIDE_MM, z: SIDE_MM, units: "mm" },
    faces: [
      face("x0", [0, half, half], [-1, 0, 0]),
      face("xL", [length, half, half], [1, 0, 0]),
      face("y0", [length / 2, 0, half], [0, -1, 0]),
      face("yB", [length / 2, SIDE_MM, half], [0, 1, 0]),
      face("z0", [length / 2, half, 0], [0, 0, -1]),
      face("zB", [length / 2, half, SIDE_MM], [0, 0, 1])
    ]
  };
}

function elementCount(): number {
  return ((L1_MM + L2_MM) / CELL_MM) * (SIDE_MM / CELL_MM) ** 2 * 6;
}

/**
 * Structured msh v2.2 bar (mm coordinates): every hex cell splits into six
 * Kuhn tetrahedra, and the body-1/body-2 interface lies on cell faces. The
 * boundary triangles are grouped per box face for selection mapping.
 */
function seriesBarArtifact(units: "m" | "mm", bodyIdentity: boolean): CoreVolumeMeshArtifact {
  const nx = (L1_MM + L2_MM) / CELL_MM;
  const ny = SIDE_MM / CELL_MM;
  const nz = ny;
  const nodeId = (i: number, j: number, k: number) => 1 + i + (nx + 1) * (j + (ny + 1) * k);
  const coordinate = (id: number): [number, number, number] => {
    const index = id - 1;
    const i = index % (nx + 1);
    const j = Math.floor(index / (nx + 1)) % (ny + 1);
    const k = Math.floor(index / ((nx + 1) * (ny + 1)));
    return [i * CELL_MM, j * CELL_MM, k * CELL_MM];
  };
  const nodes: string[] = [];
  for (let k = 0; k <= nz; k += 1) for (let j = 0; j <= ny; j += 1) for (let i = 0; i <= nx; i += 1) {
    const id = nodeId(i, j, k);
    nodes.push(`${id} ${coordinate(id).join(" ")}`);
  }
  const tets: Array<{ nodes: number[]; physical: number }> = [];
  const axisPermutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let k = 0; k < nz; k += 1) for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    const physical = bodyIdentity ? ((i + 0.5) * CELL_MM < L1_MM ? 1 : 2) : 1;
    for (const permutation of axisPermutations) {
      const corner = [i, j, k];
      const path = [nodeId(i, j, k)];
      for (const axis of permutation) {
        corner[axis]! += 1;
        path.push(nodeId(corner[0]!, corner[1]!, corner[2]!));
      }
      tets.push({ nodes: positivelyOriented(path, coordinate), physical });
    }
  }
  const faceCounts = new Map<string, { nodes: number[]; count: number }>();
  for (const tet of tets) {
    for (const face of [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]) {
      const faceNodes = face.map((local) => tet.nodes[local]!);
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
    if (on(0, L1_MM + L2_MM)) return "xL";
    if (on(1, 0)) return "y0";
    if (on(1, SIDE_MM)) return "yB";
    if (on(2, 0)) return "z0";
    return "zB";
  };
  const facePhysical = (name: FaceName) => 10 + FACES.indexOf(name);
  const triangles = [...faceCounts.values()].filter((entry) => entry.count === 1).map((entry) => ({ nodes: entry.nodes, physical: facePhysical(boundaryFaceName(entry.nodes)) }));
  const physicalNames = [
    ...(bodyIdentity ? [`3 1 "body:${BODY_1}"`, `3 2 "body:${BODY_2}"`] : [`3 1 "solid"`]),
    ...FACES.map((face) => `2 ${facePhysical(face)} "face_${face}"`)
  ];
  const elements = [
    ...triangles.map((triangle) => `2 2 ${triangle.physical} ${triangle.physical} ${triangle.nodes.join(" ")}`),
    ...tets.map((tet) => `4 2 ${tet.physical} ${tet.physical} ${tet.nodes.join(" ")}`)
  ].map((line, index) => `${index + 1} ${line}`);
  const msh = [
    "$MeshFormat", "2.2 0 8", "$EndMeshFormat",
    "$PhysicalNames", String(physicalNames.length), ...physicalNames, "$EndPhysicalNames",
    "$Nodes", String(nodes.length), ...nodes, "$EndNodes",
    "$Elements", String(elements.length), ...elements, "$EndElements"
  ].join("\n");
  const artifact = parseGmshMeshToCoreVolumeMesh(msh, {
    units: "mm",
    sourceSelectionRefs: Object.fromEntries(FACES.map((face) => [`face_${face}`, { sourceSelectionRef: `selection-${face}`, sourceFaceId: `face-${face}` }]))
  });
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

function positivelyOriented(nodes: number[], coordinate: (id: number) => [number, number, number]): number[] {
  const [a, b, c, d] = nodes.map(coordinate) as unknown as [number[], number[], number[], number[]];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  const w = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
  const volume = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  return volume > 0 ? nodes : [nodes[0]!, nodes[2]!, nodes[1]!, nodes[3]!];
}

function surfaceNodeValues(result: SolvedResult, type: "displacement" | "temperature", where: (pointMm: number[]) => boolean): number[][] {
  const field = result.fields.find((candidate) => candidate.type === type && candidate.location === "node" && candidate.surfaceMeshRef);
  if (!field || !result.surfaceMesh) throw new Error(`No ${type} surface field.`);
  return result.surfaceMesh.nodes.flatMap((node, index) => {
    // The solver surface mesh stays in solver length units.
    if (!where(node.map((value) => (result.solverUnits === "m" ? value * 1000 : value)))) return [];
    return [type === "displacement" ? [...(field.vectors?.[index] ?? [])] : [field.values[index]!]];
  });
}

function elementField(result: SolvedResult, type: ResultField["type"], component?: string): ResultField {
  const field = result.fields.find((candidate) => candidate.type === type && candidate.location === "element" && (!component || candidate.component === component || candidate.id.includes(component.replace("_", "-"))));
  if (!field) throw new Error(`No element ${type} field. Fields: ${result.fields.map((candidate) => `${candidate.id}:${candidate.type}:${candidate.location}`).join(", ")}`);
  return field;
}

function near(value: number | undefined, target: number): boolean {
  return value !== undefined && Math.abs(value - target) < 1e-6;
}

function expectRelative(actual: number | undefined, expected: number, tolerance: number): void {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected) / Math.abs(expected), `actual ${actual} vs expected ${expected}`).toBeLessThan(tolerance);
}
