import * as THREE from "three";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  elevateTet4MeshToTet10,
  extractBoundarySurfaceFacets,
  nodeSetFromSurfaceSet,
  type CoreResultField,
  type CoreSolveResult,
  type OpenFEAModelJson,
  type SurfaceFacetJson
} from "@openfea/core";
import { solveCoreStatic } from "@openfea/solver-cpu";
import type { ResultField } from "@openfea/schema";
import { buildSolverSurfaceResultGeometry, finalVisualScaleForDisplacementField, solverSurfaceResultFields } from "./CadViewer";
import { RESULT_DEFORMATION_CAP_FRACTION } from "../resultDeformation";
import { resultColorForValue, SAFETY_FACTOR_FIXED_RANGE, type ResolvedResultColorScale } from "../resultColorScale";
import type { SolverSurfaceMesh } from "../projectFile";
import type { ResultMode, StressComponent } from "../workspaceViewTypes";

/*
 * Parity between the app's solver-surface render path (solverSurfaceResultFields ->
 * buildSolverSurfaceResultGeometry) and the retired `@openfea/viewer` package's
 * buildSolverSurfaceRenderGeometry (plan 024 baseline row, plan 036 item 0.10).
 *
 * fixtures/viewer-solver-surface-parity.json holds, per case, the Core solver-surface
 * mesh and node fields from a small static solve of parityBlockModel (the input) and the
 * exact buffers `@openfea/viewer@0.1.2` produced from that input (the expected values),
 * captured at 1a06a09 before the package was deleted. Feeding the frozen input keeps
 * these assertions about the render conversion, independent of later solver numerics;
 * the live-solve tests check that current Core output still takes the same path.
 *
 * The viewer returned positions, indices, Float32 values, min/max, nodeMap and raw
 * displacement vectors for stress contours only. It had no normals, colours or
 * deformation; the app produces those and the assertions below pin them as well.
 */

// Float32 round-to-nearest is within 2^-24 relative; one extra bit of slack.
const FLOAT32_RELATIVE_TOLERANCE = 2 ** -23;
// Unit normals from three.js computeVertexNormals on Float32 positions.
const NORMAL_TOLERANCE = 1e-6;
// Linear-sRGB channel values from the same ramp; viewer values are Float32-rounded.
const COLOR_CHANNEL_TOLERANCE = 1e-5;
// m-N-s-Pa vs mm-N-s-MPa solves of the identical model, compared in MPa / mm output units.
const UNIT_SYSTEM_RELATIVE_TOLERANCE = 1e-6;

const FIXTURE_URL = new URL("./fixtures/viewer-solver-surface-parity.json", import.meta.url);

type ParityCaseId = "Tet4-m" | "Tet4-mm" | "Tet10-m" | "Tet10-mm";
const PARITY_CASES: ReadonlyArray<{ id: ParityCaseId; order: "Tet4" | "Tet10"; units: "m" | "mm" }> = [
  { id: "Tet4-m", order: "Tet4", units: "m" },
  { id: "Tet4-mm", order: "Tet4", units: "mm" },
  { id: "Tet10-m", order: "Tet10", units: "m" },
  { id: "Tet10-mm", order: "Tet10", units: "mm" }
];

// The viewer's production-surface invariant admitted only stress fields as its contour.
const PARITY_MODES: ReadonlyArray<{ fieldId: string; resultMode: ResultMode; stressComponent?: StressComponent }> = [
  { fieldId: "stress-surface", resultMode: "stress", stressComponent: "von_mises" },
  { fieldId: "stress-principal-max-surface", resultMode: "stress", stressComponent: "principal_max" },
  { fieldId: "stress-principal-min-surface", resultMode: "stress", stressComponent: "principal_min" },
  { fieldId: "stress-max-shear-surface", resultMode: "stress", stressComponent: "max_shear" }
];
// Contours the app renders on the same path that the viewer rejected.
const APP_ONLY_MODES: ReadonlyArray<{ fieldId: string; resultMode: ResultMode }> = [
  { fieldId: "displacement-surface", resultMode: "displacement" },
  { fieldId: "safety-factor-surface", resultMode: "safety_factor" }
];

type ViewerFieldCapture = { fieldUnits: string; values: number[]; min: number; max: number };
type ViewerCapture = {
  source: "solver_surface_mesh";
  surfaceMeshId: string;
  positions: number[];
  indices: number[];
  nodeMap: number[];
  displacementFieldId?: string;
  displacementVectors?: number[];
  fields: Record<string, ViewerFieldCapture>;
};
type ParityInput = { surfaceMesh: SolverSurfaceMesh; fields: CoreResultField[] };
type ParityFixture = {
  capturedFrom: string;
  cases: Record<ParityCaseId, { input: ParityInput; viewer: ViewerCapture }>;
};

/**
 * 200 x 100 x 100 mm steel block, two hex cells split into conforming Kuhn tets (optionally
 * elevated to Tet10), clamped at x = 0 with an oblique tip load. `units: "m"` writes the
 * identical model in m-N-s-Pa.
 */
function parityBlockModel(order: "Tet4" | "Tet10", units: "m" | "mm"): OpenFEAModelJson {
  const lengthScale = units === "mm" ? 1 : 1e-3;
  const cell = 100;
  const nx = 2;
  const nodeIndex = (i: number, j: number, k: number) => (i * 2 + j) * 2 + k;
  const coordinates: number[] = [];
  for (let i = 0; i <= nx; i += 1) {
    for (let j = 0; j <= 1; j += 1) {
      for (let k = 0; k <= 1; k += 1) coordinates.push(i * cell * lengthScale, j * cell * lengthScale, k * cell * lengthScale);
    }
  }
  const tet4: number[][] = [];
  for (let i = 0; i < nx; i += 1) {
    const c0 = nodeIndex(i, 0, 0);
    const c1 = nodeIndex(i + 1, 0, 0);
    const c2 = nodeIndex(i + 1, 1, 0);
    const c3 = nodeIndex(i, 1, 0);
    const c4 = nodeIndex(i, 0, 1);
    const c5 = nodeIndex(i + 1, 0, 1);
    const c6 = nodeIndex(i + 1, 1, 1);
    const c7 = nodeIndex(i, 1, 1);
    tet4.push([c0, c1, c2, c6], [c0, c2, c3, c6], [c0, c3, c7, c6], [c0, c7, c4, c6], [c0, c4, c5, c6], [c0, c5, c1, c6]);
  }
  const elevated = order === "Tet10" ? elevateTet4MeshToTet10({ coordinates, elements: tet4 }) : undefined;
  const finalCoordinates = elevated ? elevated.coordinates : coordinates;
  const connectivity = elevated ? elevated.elements.flat() : tet4.flat();
  const length = nx * cell * lengthScale;
  const material = units === "mm"
    ? { youngModulus: 200_000, density: 7.85e-9, yieldStrength: 250 }
    : { youngModulus: 200e9, density: 7850, yieldStrength: 250e6 };
  const base: OpenFEAModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.4.0",
    nodes: { coordinates: finalCoordinates },
    materials: [{ name: "steel", type: "isotropicLinearElastic", poissonRatio: 0.3, ...material }],
    elementBlocks: [{ name: "block", type: order, material: "steel", connectivity }],
    nodeSets: [],
    elementSets: [],
    boundaryConditions: [],
    loads: [],
    steps: [],
    coordinateSystem: { solverUnits: units === "mm" ? "mm-N-s-MPa" : "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: { kind: "opencae_core_fea", solver: "opencae-core-local", resultSource: "computed", meshSource: "structured_block_core" }
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const faceAtX = (name: string, x: number) => ({
    name,
    facets: surfaceFacets
      .filter((facet: SurfaceFacetJson) => facet.nodes.every((node) => finalCoordinates[node * 3] === x))
      .map((facet) => facet.id)
  });
  const fixedFace = faceAtX("fixedFace", 0);
  const tipFace = faceAtX("tipFace", length);
  return {
    ...base,
    surfaceFacets,
    surfaceSets: [fixedFace, tipFace],
    nodeSets: [{ name: "fixedNodes", nodes: nodeSetFromSurfaceSet(fixedFace, surfaceFacets) }],
    boundaryConditions: [{ name: "clamp", type: "fixed", nodeSet: "fixedNodes", components: ["x", "y", "z"] }],
    loads: [{ name: "tipLoad", type: "surfaceForce", surfaceSet: "tipFace", totalForce: [0, 20_000, -50_000] }],
    steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: ["clamp"], loads: ["tipLoad"] }]
  };
}

function solveParityCase(order: "Tet4" | "Tet10", units: "m" | "mm"): CoreSolveResult {
  const solved = solveCoreStatic(parityBlockModel(order, units));
  if (!solved.ok) throw new Error(`Parity solve ${order}/${units} failed: ${JSON.stringify(solved)}`);
  return solved.result;
}

function parityInputFromCoreResult(result: CoreSolveResult): ParityInput {
  const fieldIds = new Set([...PARITY_MODES, ...APP_ONLY_MODES].map((mode) => mode.fieldId));
  return {
    surfaceMesh: result.surfaceMesh as SolverSurfaceMesh,
    fields: result.fields
      .filter((field) => fieldIds.has(field.id))
      .map(({ tensorValues: _tensorValues, ...field }) => field)
  };
}

/** The adapter's Core -> app field mapping (runVariantFromCoreResult): Core fields pass through with run ids. */
function appFieldsFromCore(fields: CoreResultField[]): ResultField[] {
  return fields.map((field) => ({ ...field, runId: "run-parity", variantId: "case:parity" })) as unknown as ResultField[];
}

function readFixture(): ParityFixture {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as ParityFixture;
}

function colorScaleFor(resultMode: ResultMode, component: StressComponent | undefined, min: number, max: number): ResolvedResultColorScale {
  if (resultMode === "safety_factor") return { type: resultMode, ...SAFETY_FACTOR_FIXED_RANGE, bands: "continuous" };
  return { type: resultMode, ...(component ? { component } : {}), min, max, bands: "continuous" };
}

function expectRelativeClose(actual: number, expected: number, relative: number, scale = Math.abs(expected)) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relative * scale);
}

function boundingDiagonal(positions: ArrayLike<number>): number {
  const box = new THREE.Box3();
  for (let index = 0; index < positions.length; index += 3) box.expandByPoint(new THREE.Vector3(positions[index], positions[index + 1], positions[index + 2]));
  return box.getSize(new THREE.Vector3()).length();
}

/** Asserts the app reproduces every property the viewer package exposed, plus the app-only render attributes. */
function expectAppMatchesViewer(input: ParityInput, viewer: ViewerCapture) {
  const fields = appFieldsFromCore(input.fields);
  const { surfaceMesh } = input;
  const vertexCount = surfaceMesh.nodes.length;

  // nodeMap: surface ordinal -> volume node, carried unchanged on the app's surface mesh.
  expect(surfaceMesh.nodeMap).toEqual(viewer.nodeMap);
  expect(viewer.surfaceMeshId).toBe(surfaceMesh.id);

  for (const mode of PARITY_MODES) {
    const viewerField = viewer.fields[mode.fieldId];
    expect(viewerField, mode.fieldId).toBeDefined();
    if (!viewerField) continue;
    const selected = solverSurfaceResultFields(surfaceMesh, fields, mode.resultMode, mode.stressComponent);
    expect(selected, mode.fieldId).not.toBeNull();
    if (!selected) continue;
    // Same field, same units, same legend extent.
    expect(selected.scalarField.id).toBe(mode.fieldId);
    expect(selected.scalarField.units).toBe(viewerField.fieldUnits);
    expect(selected.scalarField.min).toBe(viewerField.min);
    expect(selected.scalarField.max).toBe(viewerField.max);
    expect(selected.displacementField?.id).toBe(viewer.displacementFieldId);

    // Per-vertex scalar values: the app keeps Float64; the viewer rounded to Float32.
    expect(selected.scalarField.values).toHaveLength(viewerField.values.length);
    selected.scalarField.values.forEach((value, index) => {
      expectRelativeClose(value, viewerField.values[index]!, FLOAT32_RELATIVE_TOLERANCE);
    });

    const undeformed = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: selected.scalarField,
      displacementField: selected.displacementField,
      resultMode: mode.resultMode,
      showDeformed: false,
      deformationScale: 1,
      displacementPeakMagnitude: selected.displacementPeakMagnitude
    });
    const position = undeformed.getAttribute("position") as THREE.BufferAttribute;
    const normal = undeformed.getAttribute("normal") as THREE.BufferAttribute;
    const color = undeformed.getAttribute("color") as THREE.BufferAttribute;

    // Positions and connectivity are bit-identical Float32 / Uint32 buffers.
    expect(Array.from(position.array as Float32Array)).toEqual(viewer.positions);
    expect(Array.from(undeformed.index!.array as Uint32Array)).toEqual(viewer.indices);
    expect(undeformed.userData.openfeaSolverSurfaceMeshId).toBe(viewer.surfaceMeshId);
    expect(undeformed.userData.openfeaSolverSurfaceFieldId).toBe(mode.fieldId);

    // Normals: the viewer emitted none; the app's must equal three.js vertex normals of the viewer buffers.
    const reference = new THREE.BufferGeometry();
    reference.setAttribute("position", new THREE.BufferAttribute(new Float32Array(viewer.positions), 3));
    reference.setIndex(new THREE.BufferAttribute(new Uint32Array(viewer.indices), 1));
    reference.computeVertexNormals();
    const referenceNormal = reference.getAttribute("normal") as THREE.BufferAttribute;
    expect(normal.count).toBe(vertexCount);
    for (let index = 0; index < vertexCount; index += 1) {
      const appNormal = new THREE.Vector3(normal.getX(index), normal.getY(index), normal.getZ(index));
      expect(Math.abs(appNormal.length() - 1)).toBeLessThanOrEqual(NORMAL_TOLERANCE);
      expect(Math.abs(appNormal.x - referenceNormal.getX(index))).toBeLessThanOrEqual(NORMAL_TOLERANCE);
      expect(Math.abs(appNormal.y - referenceNormal.getY(index))).toBeLessThanOrEqual(NORMAL_TOLERANCE);
      expect(Math.abs(appNormal.z - referenceNormal.getZ(index))).toBeLessThanOrEqual(NORMAL_TOLERANCE);
    }

    // Colours encode the viewer's per-vertex value on the field's own scale.
    const scale = colorScaleFor(mode.resultMode, mode.stressComponent, viewerField.min, viewerField.max);
    for (let index = 0; index < vertexCount; index += 1) {
      const expected = new THREE.Color(resultColorForValue(viewerField.values[index]!, scale));
      expect(Math.abs(color.getX(index) - expected.r)).toBeLessThanOrEqual(COLOR_CHANNEL_TOLERANCE);
      expect(Math.abs(color.getY(index) - expected.g)).toBeLessThanOrEqual(COLOR_CHANNEL_TOLERANCE);
      expect(Math.abs(color.getZ(index) - expected.b)).toBeLessThanOrEqual(COLOR_CHANNEL_TOLERANCE);
    }

    // Displacement: the viewer exposed raw output-unit vectors; the app bakes them into
    // positions with one visual scale. Recover the vectors and compare.
    const viewerVectors = viewer.displacementVectors;
    expect(viewerVectors).toHaveLength(vertexCount * 3);
    if (!viewerVectors || !selected.displacementField) continue;
    const deformed = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: selected.scalarField,
      displacementField: selected.displacementField,
      resultMode: mode.resultMode,
      showDeformed: true,
      deformationScale: 1,
      displacementPeakMagnitude: selected.displacementPeakMagnitude
    });
    const deformedPosition = deformed.getAttribute("position") as THREE.BufferAttribute;
    const visualScale = finalVisualScaleForDisplacementField(
      boundingDiagonal(viewer.positions),
      selected.displacementField,
      1,
      RESULT_DEFORMATION_CAP_FRACTION,
      selected.displacementPeakMagnitude
    ).finalVisualScale;
    expect(visualScale).toBeGreaterThan(0);
    let coordinateMagnitude = 0;
    for (const value of deformedPosition.array as Float32Array) coordinateMagnitude = Math.max(coordinateMagnitude, Math.abs(value));
    // Two Float32 roundings of coordinates of this magnitude, divided back by the visual scale.
    const vectorTolerance = (4 * FLOAT32_RELATIVE_TOLERANCE * coordinateMagnitude) / visualScale;
    for (let index = 0; index < viewerVectors.length; index += 1) {
      const recovered = ((deformedPosition.array as Float32Array)[index]! - viewer.positions[index]!) / visualScale;
      expect(Math.abs(recovered - viewerVectors[index]!)).toBeLessThanOrEqual(vectorTolerance + FLOAT32_RELATIVE_TOLERANCE * Math.abs(viewerVectors[index]!));
    }
  }
}

function expectTri6SurfaceIsFullyRendered(input: ParityInput, viewer: ViewerCapture, order: "Tet4" | "Tet10") {
  // Tet10 boundary faces are Tri6: Core splits each into four flat triangles, so every
  // midside node is a rendered, coloured vertex rather than being dropped.
  const referenced = new Set(viewer.indices);
  expect(referenced.size).toBe(input.surfaceMesh.nodes.length);
  const triangleCount = viewer.indices.length / 3;
  if (order === "Tet10") {
    expect(triangleCount % 4).toBe(0);
    expect(input.surfaceMesh.nodes.length).toBeGreaterThan(triangleCount / 4);
  }
}

describe("solver-surface render parity with the retired @openfea/viewer package", () => {
  const fixture = readFixture();

  test.each(PARITY_CASES)("$id: app positions, indices, normals, values, colours and displacement match the viewer capture", ({ id, order }) => {
    const { input, viewer } = fixture.cases[id];
    expect(viewer.source).toBe("solver_surface_mesh");
    expectAppMatchesViewer(input, viewer);
    expectTri6SurfaceIsFullyRendered(input, viewer, order);
  });

  test.each(["Tet4", "Tet10"] as const)("%s: mm-N-s-MPa and m-N-s-Pa solves render the same shape and values", (order) => {
    const metres = fixture.cases[`${order}-m`];
    const millimetres = fixture.cases[`${order}-mm`];
    // Surface mesh coordinates stay in model units: positions differ by exactly the length factor.
    expect(millimetres.viewer.indices).toEqual(metres.viewer.indices);
    expect(millimetres.viewer.nodeMap).toEqual(metres.viewer.nodeMap);
    millimetres.viewer.positions.forEach((value, index) => {
      expectRelativeClose(value, metres.viewer.positions[index]! * 1000, 2 * FLOAT32_RELATIVE_TOLERANCE, Math.max(1, Math.abs(value)));
    });
    // Field values are already in mm / MPa output units in both systems.
    for (const mode of PARITY_MODES) {
      const mmField = millimetres.viewer.fields[mode.fieldId]!;
      const mField = metres.viewer.fields[mode.fieldId]!;
      expect(mmField.fieldUnits).toBe(mField.fieldUnits);
      const range = Math.max(Math.abs(mField.max), Math.abs(mField.min), Number.MIN_VALUE);
      mmField.values.forEach((value, index) => expectRelativeClose(value, mField.values[index]!, UNIT_SYSTEM_RELATIVE_TOLERANCE, range));
    }
    // The app's deformed shape, normalised by model extent, is unit-system invariant.
    const deformedShape = (entry: ParityFixture["cases"][ParityCaseId]) => {
      const fields = appFieldsFromCore(entry.input.fields);
      const selected = solverSurfaceResultFields(entry.input.surfaceMesh, fields, "stress", "von_mises")!;
      const geometry = buildSolverSurfaceResultGeometry({
        surfaceMesh: entry.input.surfaceMesh,
        scalarField: selected.scalarField,
        displacementField: selected.displacementField,
        resultMode: "stress",
        showDeformed: true,
        deformationScale: 1,
        displacementPeakMagnitude: selected.displacementPeakMagnitude
      });
      const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      const extent = boundingDiagonal(entry.viewer.positions);
      return Array.from(positions, (value) => value / extent);
    };
    const mShape = deformedShape(metres);
    deformedShape(millimetres).forEach((value, index) => expectRelativeClose(value, mShape[index]!, UNIT_SYSTEM_RELATIVE_TOLERANCE, 1));
  });

  test.each(PARITY_CASES)("$id: displacement and safety-factor contours render on the same path (the viewer rejected them)", ({ id }) => {
    const { input, viewer } = fixture.cases[id];
    const fields = appFieldsFromCore(input.fields);
    for (const mode of APP_ONLY_MODES) {
      const selected = solverSurfaceResultFields(input.surfaceMesh, fields, mode.resultMode);
      expect(selected?.scalarField.id).toBe(mode.fieldId);
      if (!selected) continue;
      const geometry = buildSolverSurfaceResultGeometry({
        surfaceMesh: input.surfaceMesh,
        scalarField: selected.scalarField,
        displacementField: selected.displacementField,
        resultMode: mode.resultMode,
        showDeformed: false,
        deformationScale: 1
      });
      expect(Array.from((geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array)).toEqual(viewer.positions);
      expect(Array.from(geometry.index!.array as Uint32Array)).toEqual(viewer.indices);
      const source = input.fields.find((field) => field.id === mode.fieldId)!;
      expect(selected.scalarField.values).toEqual(source.values);
    }
    // The displacement contour is the magnitude of the vectors the viewer exposed.
    const displacement = input.fields.find((field) => field.id === "displacement-surface")!;
    const vectors = viewer.displacementVectors!;
    displacement.values.forEach((magnitude, index) => {
      const expected = Math.hypot(vectors[index * 3]!, vectors[index * 3 + 1]!, vectors[index * 3 + 2]!);
      expect(Math.abs(magnitude - expected)).toBeLessThanOrEqual(2 * FLOAT32_RELATIVE_TOLERANCE * displacement.max);
    });
  });

  test("rejects the misaligned inputs the viewer rejected", () => {
    const { input } = fixture.cases["Tet4-m"];
    const fields = appFieldsFromCore(input.fields);
    const stress = fields.find((field) => field.id === "stress-surface")!;
    const displacement = fields.find((field) => field.id === "displacement-surface")!;
    const build = (scalarField: ResultField, displacementField?: ResultField) => () => buildSolverSurfaceResultGeometry({
      surfaceMesh: input.surfaceMesh,
      scalarField,
      displacementField,
      resultMode: "stress",
      showDeformed: true,
      deformationScale: 1
    });
    const replaced = (replacement: ResultField) => fields.map((field) => (field.id === replacement.id ? replacement : field));

    // Field shorter than the surface: the builder throws and field selection declines the
    // solver-surface path (the viewer threw "surface node count").
    const truncated = { ...stress, values: stress.values.slice(1) };
    expect(build(truncated)).toThrow(/not aligned/i);
    expect(solverSurfaceResultFields(input.surfaceMesh, replaced(truncated), "stress")).toBeNull();

    // Element-located stress (the viewer threw "node field").
    const elementStress = { ...stress, location: "element" as const, surfaceMeshRef: undefined, meshRef: "solver-volume" };
    expect(build(elementStress)).toThrow(/not aligned/i);
    expect(solverSurfaceResultFields(input.surfaceMesh, replaced(elementStress), "stress")).toBeNull();

    // Missing surfaceMeshRef (the viewer threw "solver surface mesh").
    const unreferenced = { ...stress, surfaceMeshRef: undefined };
    expect(build(unreferenced)).toThrow(/not aligned/i);
    expect(solverSurfaceResultFields(input.surfaceMesh, replaced(unreferenced), "stress")).toBeNull();

    // Displacement vectors not aligned with the surface (the viewer threw "vectors").
    const badVectors = { ...displacement, vectors: displacement.vectors!.slice(1) };
    expect(build(stress, badVectors)).toThrow(/vectors are not aligned/i);
  });

  test("rejects malformed surface topology the viewer passed through", () => {
    const { input } = fixture.cases["Tet4-m"];
    const fields = appFieldsFromCore(input.fields);
    const stress = fields.find((field) => field.id === "stress-surface")!;
    const outOfRange: SolverSurfaceMesh = {
      ...input.surfaceMesh,
      triangles: [...input.surfaceMesh.triangles.slice(1), [0, 1, input.surfaceMesh.nodes.length]]
    };
    expect(() => buildSolverSurfaceResultGeometry({
      surfaceMesh: outOfRange,
      scalarField: stress,
      resultMode: "stress",
      showDeformed: false,
      deformationScale: 1
    })).toThrow(/missing surface node/i);
  });

  test.each(PARITY_CASES)("$id: a live Core solve still takes the solver-surface path with the captured topology", ({ order, units, id }) => {
    const live = parityInputFromCoreResult(solveParityCase(order, units));
    const captured = fixture.cases[id];
    expect(live.surfaceMesh.nodeMap).toEqual(captured.viewer.nodeMap);
    expect(live.surfaceMesh.triangles.flat()).toEqual(captured.viewer.indices);
    expect(Array.from(new Float32Array(live.surfaceMesh.nodes.flat()))).toEqual(captured.viewer.positions);
    const fields = appFieldsFromCore(live.fields);
    for (const mode of PARITY_MODES) {
      const selected = solverSurfaceResultFields(live.surfaceMesh, fields, mode.resultMode, mode.stressComponent);
      expect(selected?.scalarField.id).toBe(mode.fieldId);
      expect(selected?.displacementField?.id).toBe("displacement-surface");
    }
  });
});
