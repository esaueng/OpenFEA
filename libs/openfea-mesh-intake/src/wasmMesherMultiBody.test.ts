// Multi-body STEP conditioning (fuseImportedStepVolumes): a file exported as
// several touching or overlapping solids must mesh as ONE conformal part, not
// as per-volume tetrahedra the solver later rejects as disconnected
// components. Also pins the honest diagnosis for gmsh/TetGen's raw
// "PLC Error: A segment and a facet intersect" boundary-recovery failure.
import { solveStaticLinearTet } from "@openfea/solver-cpu";
import { describe, expect, it } from "vitest";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import { generateDisjointBarsStep, generateOverlappingTBarStep, generateSeriesBarsStep, generateTouchingTBarStep } from "./stepFixtures";
import { diagnoseStepMeshFailure, meshStepToMshV2, StepGeometryError } from "./wasmMesher";

describe("multi-body STEP fusion", () => {
  it("fuses two overlapping solids into one meshable part", { timeout: 300_000 }, async () => {
    const step = await generateOverlappingTBarStep();
    const result = await meshStepToMshV2(step, { elementOrder: 1, meshSizeMm: 8 });
    expect(result.multiBodyFusion).toEqual({ inputVolumeCount: 2, fusedVolumeCount: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.elements.length).toBeGreaterThan(0);
    expect(artifact.metadata.connectedComponentCount).toBe(1);
  });

  it("fuses two exactly-touching solids into one connected mesh", { timeout: 300_000 }, async () => {
    const step = await generateTouchingTBarStep();
    const result = await meshStepToMshV2(step, { elementOrder: 1, meshSizeMm: 8 });
    expect(result.multiBodyFusion).toEqual({ inputVolumeCount: 2, fusedVolumeCount: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(1);
  });

  it("honors an explicit pairwise fuse group while preserving part identity", { timeout: 300_000 }, async () => {
    const step = await generateTouchingTBarStep();
    const result = await meshStepToMshV2(step, {
      elementOrder: 1,
      meshSizeMm: 8,
      preservePartIdentity: true,
      fuseBodyGroups: [[
        { min: [0, -10, 0], max: [160, 10, 10] },
        { min: [-10, -30, 0], max: [0, 30, 10] }
      ]]
    });
    expect(result.multiBodyFusion).toEqual({ inputVolumeCount: 2, fusedVolumeCount: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(1);
  });

  it("leaves genuinely disjoint bodies un-fused with no fusion report", { timeout: 300_000 }, async () => {
    const step = await generateDisjointBarsStep();
    const result = await meshStepToMshV2(step, { elementOrder: 1, meshSizeMm: 8 });
    expect(result.multiBodyFusion).toBeUndefined();
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(2);
  });
});

describe("per-body STEP meshing (plan 036 R1.3)", () => {
  const SERIES_BODIES = [
    { name: "body:step-object-1", bounds: { min: [0, 0, 0] as [number, number, number], max: [60, 20, 20] as [number, number, number] } },
    { name: "body:step-object-2", bounds: { min: [60, 0, 0] as [number, number, number], max: [100, 20, 20] as [number, number, number] } }
  ];
  /** Tet4 reproduces the linear series-bar field exactly; this absorbs linear-solve round-off. */
  const CLOSED_FORM_RELATIVE_TOLERANCE = 1e-6;

  it("keeps touching bodies as separate volumes on one conformal mesh and solves the series-bar closed form", { timeout: 300_000 }, async () => {
    const result = await meshStepToMshV2(await generateSeriesBarsStep(), { elementOrder: 1, meshSizeMm: 8, bodyIdentities: SERIES_BODIES });
    expect(result.multiBodyFusion).toBeUndefined();
    const artifact = parseGmshMeshToCoreVolumeMesh(result.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(1);
    expect(new Set(artifact.elements.map((element) => element.physicalName))).toEqual(new Set(SERIES_BODIES.map((body) => body.name)));
    // The shared interface is interior: no boundary facet lies on x = 60 mm.
    expect(artifact.surfaceFacets.some((facet) => facet.center !== undefined && Math.abs(facet.center[0] - 0.06) < 1e-9)).toBe(false);

    // Tag the box faces for selection mapping, then pull the free end with
    // symmetry rollers on x0/y0/z0 so the exact state is uniaxial.
    const faceOf = (center: [number, number, number]) =>
      Math.abs(center[0]) < 1e-9 ? "x0" : Math.abs(center[0] - 0.1) < 1e-9 ? "xL" : Math.abs(center[1]) < 1e-9 ? "y0" : Math.abs(center[2]) < 1e-9 ? "z0" : undefined;
    const tagged = { ...artifact, surfaceFacets: artifact.surfaceFacets.map((facet) => ({ ...facet, sourceSelectionRef: faceOf(facet.center) })) };
    const E1 = 200e9;
    const E2 = 70e9;
    const material = (id: string, youngModulus: number, poissonRatio: number) => ({ id, name: id, youngModulus, poissonRatio, density: 7850, yieldStrength: 250e6 });
    const model = buildCoreModelFromCloudMesh({
      study: {
        type: "static_stress",
        materialAssignments: [{ materialId: "series-a", bodyId: "step-object-1" }, { materialId: "series-b", bodyId: "step-object-2" }],
        constraints: (["x0", "y0", "z0"] as const).map((face, index) => ({ id: `roller-${index}`, type: "prescribed_displacement", selectionRef: face, parameters: { component: face[0], value: 0 } })),
        loads: [{ id: "pull", type: "force", selectionRef: "xL", parameters: { value: 8000, direction: [1, 0, 0] } }]
      },
      // Equal lateral strain (nu/E) keeps the bonded interface free of transverse stress.
      materials: [material("series-a", E1, 0.3), material("series-b", E2, 0.3 * (E2 / E1))],
      volumeMesh: tagged,
      analysisType: "static_stress"
    });
    expect(model.elementBlocks.map((block) => [block.name, block.material])).toEqual([["body:step-object-1", "series-a"], ["body:step-object-2", "series-b"]]);

    const solved = solveStaticLinearTet(model);
    expect(solved.ok, solved.ok ? undefined : JSON.stringify(solved.error)).toBe(true);
    if (!solved.ok) return;
    const area = 0.02 * 0.02;
    const expectedTip = 8000 * (0.06 / (E1 * area) + 0.04 / (E2 * area));
    const coordinates = model.nodes.coordinates;
    let tipNodes = 0;
    for (let node = 0; node < coordinates.length / 3; node += 1) {
      if (Math.abs(coordinates[node * 3]! - 0.1) > 1e-9) continue;
      tipNodes += 1;
      expect(Math.abs(solved.result.displacement[node * 3]! - expectedTip) / expectedTip).toBeLessThan(CLOSED_FORM_RELATIVE_TOLERANCE);
    }
    expect(tipNodes).toBeGreaterThan(0);
    for (const vonMises of solved.result.vonMises) {
      expect(Math.abs(vonMises - 8000 / area) / (8000 / area)).toBeLessThan(CLOSED_FORM_RELATIVE_TOLERANCE);
    }
  });

  it("rejects overlapping bodies instead of giving the overlap two materials", { timeout: 300_000 }, async () => {
    await expect(meshStepToMshV2(await generateOverlappingTBarStep(), {
      elementOrder: 1,
      meshSizeMm: 8,
      bodyIdentities: [
        { name: "body:step-object-1", bounds: { min: [0, -10, 0], max: [160, 10, 10] } },
        { name: "body:step-object-2", bounds: { min: [-10, -30, 0], max: [10, 30, 10] } }
      ]
    })).rejects.toThrow(/STEP bodies overlap[\s\S]*use one material for the whole model\.$/);
  });
});

describe("diagnoseStepMeshFailure", () => {
  it("translates TetGen PLC boundary-recovery failures into an honest geometry diagnosis", () => {
    const raw = new Error("gmshModelMeshGenerate: PLC Error:  A segment and a facet intersect at point (12.3, 4.5, 6.7).");
    const diagnosed = diagnoseStepMeshFailure(raw);
    expect(diagnosed).toBeInstanceOf(StepGeometryError);
    expect(diagnosed.message).toContain("surfaces pass through each other");
    expect(diagnosed.message).toContain("overlapping solid bodies or a self-intersecting boolean");
    // Sewing advice is wrong for a closed-but-self-intersecting shell.
    expect(diagnosed.message).not.toContain("Fix open surfaces");
    // The raw mesher wording stays available for diagnosis.
    expect(diagnosed.message).toContain("PLC Error");
  });

  it("keeps the existing open-surfaces action for non-intersection failures", () => {
    const raw = new StepGeometryError("The STEP import contains surfaces but no closed solid volume.");
    const diagnosed = diagnoseStepMeshFailure(raw);
    expect(diagnosed.message).toContain("Fix open surfaces");
  });

  it("passes unrelated errors through unchanged", () => {
    const raw = new Error("memory access out of bounds");
    expect(diagnoseStepMeshFailure(raw)).toBe(raw);
  });
});
