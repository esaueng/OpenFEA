// Plan 036 R2.2: persisted local mesh sizes, their resolution by B-rep face
// id + fingerprint, the pre-mesh preflight and the Mesh panel controls.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { bracketDisplayModel } from "@openfea/samples";
import { ProjectSchema, type DisplayModel, type MeshLocalSize, type Project, type Study } from "@openfea/schema";
import { requestedElementOrder } from "@openfea/mesh-intake/elevateArtifact";
import { buildAutosavedWorkspace, parseAutosavedWorkspacePayload, type WorkspaceUiSnapshot } from "./appPersistence";
import { openLocalProjectPayload } from "./localProjectFactory";
import {
  isLocalSizableFace,
  localSizeTargetsForRegistry,
  meshLocalSizeForFace,
  meshLocalSizingWarnings,
  meshSettingsWithoutMesh,
  planMeshLocalSizing,
  registryVolumeAndArea,
  resolveMeshLocalSizes,
  studyRequestedElementOrder,
  upsertMeshLocalSizes
} from "./meshLocalSizing";
import { MeshLocalSizingSection, localSizeInputToMm } from "./components/panels/MeshLocalSizingSection";
import type { StepFaceRecord, StepFaceRegistry } from "./stepFaces";

type ProjectFile = { project: Project; displayModel: unknown };
const readFixture = (path: string) => JSON.parse(readFileSync(resolve(__dirname, path), "utf8")) as ProjectFile;
// A version-2 project saved before plan 036 R2.2 (no meshSettings.localSizing).
const PRE_R2_2_PROJECT_FILE = readFixture("testdata/mesh-quality/pre-r2-1-project.openfea.json");
// The same project with one persisted hole-wall local size.
const R2_2_PROJECT_FILE = readFixture("testdata/mesh-local-sizing/r2-2-local-sizing-project.openfea.json");

const UI = {
  activeStep: "mesh",
  homeRequested: false,
  selectedFaceId: null,
  selectedLoadPoint: null,
  selectedPayloadObject: null,
  viewMode: "model",
  themeMode: "dark",
  resultMode: "stress",
  showDeformed: false,
  showDimensions: false,
  stressExaggeration: 1,
  resultFrameIndex: 0,
  resultPlaybackFps: 12,
  resultPlaybackReverseLoop: false,
  draftLoadType: "force",
  draftLoadValue: 500,
  draftLoadDirection: "-Z",
  sampleModel: "cantilever",
  sampleAnalysisType: "static_stress",
  activeRunId: "",
  completedRunId: "",
  runProgress: 0,
  undoStack: [],
  redoStack: [],
  status: "Ready",
  logs: []
} satisfies WorkspaceUiSnapshot;

/** Unit cube [0,10]^3 mm as one closed 12-triangle mesh with six planar faces. */
function cubeRegistry(): StepFaceRegistry {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // z = 0
    4, 5, 6, 4, 6, 7, // z = 10
    0, 1, 5, 0, 5, 4, // y = 0
    3, 7, 6, 3, 6, 2, // y = 10
    0, 4, 7, 0, 7, 3, // x = 0
    1, 2, 6, 1, 6, 5 // x = 10
  ]);
  const centroids: Array<[number, number, number]> = [[5, 5, 0], [5, 5, 10], [5, 0, 5], [5, 10, 5], [0, 5, 5], [10, 5, 5]];
  const normals: Array<[number, number, number]> = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
  const faces: StepFaceRecord[] = centroids.map((centroid, index) => ({
    faceId: `step-face-${index}`,
    meshIndex: 0,
    triangleRange: [index * 2, index * 2 + 1],
    triangleCount: 2,
    area: 100,
    centroid,
    avgNormal: normals[index]!,
    surfaceType: "planar",
    fingerprint: `stepface:a=100|c=${centroid.map((value) => value.toFixed(1)).join(",")}|n=${normals[index]!.map((value) => value.toFixed(2)).join(",")}`
  }));
  return {
    faces,
    meshes: [{ positions, indices, faceRanges: faces.map((face) => ({ first: face.triangleRange[0], last: face.triangleRange[1] })) }],
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    normalization: { scale: 0.24, offset: [-1.2, -1.2, -1.2] },
    displayFaces: []
  };
}

function rule(overrides: Partial<MeshLocalSize> = {}): MeshLocalSize {
  const registry = cubeRegistry();
  return { id: "local-size-1", faceId: "step-face-5", fingerprint: registry.faces[5]!.fingerprint, label: "+X face", sizeMm: 1, ...overrides };
}

describe("local sizing persistence (backward-reading fixtures)", () => {
  test("a project saved before local sizing still loads without the field", () => {
    const parsed = ProjectSchema.parse(PRE_R2_2_PROJECT_FILE.project);
    expect(parsed.studies[0]?.meshSettings.localSizing).toBeUndefined();
    expect(() => openLocalProjectPayload(PRE_R2_2_PROJECT_FILE)).not.toThrow();
  });

  test("local sizes survive schema parse, project import and autosave", () => {
    const expected = R2_2_PROJECT_FILE.project.studies[0]!.meshSettings.localSizing;
    expect(expected).toHaveLength(1);
    const parsed = ProjectSchema.parse(R2_2_PROJECT_FILE.project);
    expect(parsed.studies[0]?.meshSettings.localSizing).toEqual(expected);
    // Import discards the stored mesh but keeps the user's sizing setup.
    const opened = openLocalProjectPayload(R2_2_PROJECT_FILE);
    expect(opened.project.studies[0]?.meshSettings.localSizing).toEqual(expected);
    const autosave = buildAutosavedWorkspace({ project: parsed, displayModel: bracketDisplayModel, ui: UI });
    const restored = parseAutosavedWorkspacePayload(JSON.stringify(autosave));
    expect(restored?.projectFile.project.studies[0]?.meshSettings.localSizing).toEqual(expected);
  });

  test("an unreadable local sizing list is dropped instead of failing the load", () => {
    const project = structuredClone(R2_2_PROJECT_FILE.project);
    (project.studies[0]!.meshSettings as Record<string, unknown>).localSizing = [{ id: "x", faceId: "step-face-1", fingerprint: "", sizeMm: -1 }];
    const parsed = ProjectSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.studies[0]?.meshSettings.localSizing).toBeUndefined();
  });

  test("mesh resets keep the preset and the local sizes", () => {
    const meshSettings = R2_2_PROJECT_FILE.project.studies[0]!.meshSettings;
    expect(meshSettingsWithoutMesh(meshSettings)).toEqual({ preset: meshSettings.preset, status: "not_started", localSizing: meshSettings.localSizing });
    expect(meshSettingsWithoutMesh({ preset: "fine", status: "complete" })).toEqual({ preset: "fine", status: "not_started" });
  });
});

describe("local size rules", () => {
  test("a rule stores the registry face id and fingerprint, and upsert replaces a face's size", () => {
    const registry = cubeRegistry();
    const created = meshLocalSizeForFace({ id: "step-face-5", label: "+X face" }, 2, registry, "local-size-a");
    expect(created).toEqual({ id: "local-size-a", faceId: "step-face-5", fingerprint: registry.faces[5]!.fingerprint, label: "+X face", sizeMm: 2 });
    const updated = upsertMeshLocalSizes([created], [{ id: "step-face-5", label: "+X face" }, { id: "step-face-0", label: "-Z face" }], 1, registry);
    expect(updated.map((entry) => [entry.faceId, entry.sizeMm])).toEqual([["step-face-5", 1], ["step-face-0", 1]]);
    expect(meshLocalSizeForFace({ id: "step-face-5", label: "+X" }, 2, null).fingerprint).toBe("");
  });

  test("resolves by face id + fingerprint, follows a renumbered face, and reports changed or missing faces", () => {
    const registry = cubeRegistry();
    const renumbered = rule({ id: "moved", faceId: "step-face-99" });
    // Same id, but the face it was set on has moved 3 mm (beyond the 1% centroid tolerance).
    const changed = rule({ id: "changed", faceId: "step-face-0", fingerprint: "stepface:a=100|c=5.0,5.0,3.0|n=0.00,0.00,-1.00" });
    const missing = rule({ id: "missing", faceId: "step-face-42", fingerprint: "stepface:a=7|c=1.0,1.0,1.0|n=0.00,0.00,1.00" });
    const legacy = rule({ id: "legacy", faceId: "step-face-1", fingerprint: "" });
    const { resolved, unresolved } = resolveMeshLocalSizes([rule(), renumbered, changed, missing, legacy], registry);
    expect(resolved.map((entry) => [entry.rule.id, entry.record.faceId])).toEqual([["local-size-1", "step-face-5"], ["moved", "step-face-5"], ["legacy", "step-face-1"]]);
    expect(unresolved.map((entry) => [entry.rule.id, entry.reason])).toEqual([["changed", "face_changed"], ["missing", "face_not_found"]]);
    const warnings = meshLocalSizingWarnings([changed, missing], unresolved, {
      globalSize: 12,
      growthRate: 0.5,
      applied: [],
      unmatched: [{ targetId: "local-size-1", faceId: "step-face-5", reason: "not_finer_than_global" }]
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/no longer matches/);
    expect(warnings[2]).toMatch(/step-face-5 was not applied: it is not finer/);
  });

  test("targets carry the face bounds and keep the finer size for duplicate faces", () => {
    const registry = cubeRegistry();
    const { resolved } = resolveMeshLocalSizes([rule(), rule({ id: "dup", sizeMm: 0.6 })], registry);
    const targets = localSizeTargetsForRegistry(resolved, registry);
    expect(targets).toEqual([{ id: "local-size-1", faceId: "step-face-5", size: 0.6, area: 100, centroid: [10, 5, 5], bounds: { min: [10, 0, 0], max: [10, 10, 10] } }]);
    expect(localSizeTargetsForRegistry(resolved, registry, [1])).toEqual([]);
  });

  test("the registry tessellation gives the solid's volume and boundary area", () => {
    const { volume, area } = registryVolumeAndArea(cubeRegistry());
    expect(volume).toBeCloseTo(1000, 6);
    expect(area).toBeCloseTo(600, 6);
  });

  test("the preflight runs on the plan and blocks an over-limit refinement before meshing", () => {
    const registry = cubeRegistry();
    const ok = planMeshLocalSizing({ rules: [rule()], registry, globalSizeMm: 5, elementOrder: 2, maxDofs: 150_000 })!;
    expect(ok.preflight.status).toBe("ok");
    expect(ok.targets).toHaveLength(1);
    const blocked = planMeshLocalSizing({ rules: [rule({ sizeMm: 0.5 })], registry, globalSizeMm: 5, elementOrder: 2, maxDofs: 1_000 })!;
    expect(blocked.preflight.status).toBe("block");
    expect(planMeshLocalSizing({ rules: [], registry, globalSizeMm: 5, elementOrder: 2, maxDofs: 150_000 })).toBeNull();
  });

  test("the app's element-order mirror matches the mesher's rule", () => {
    for (const settings of [undefined, {}, { elementOrder: 1 }, { elementOrder: "1" }, { elementOrder: 2 }, { meshOrder: 1 }, { elementOrder: 3 }]) {
      expect(studyRequestedElementOrder(settings)).toBe(requestedElementOrder(settings));
    }
  });

  test("only real STEP registry faces can be sized", () => {
    expect(isLocalSizableFace({ id: "step-face-3" })).toBe(true);
    expect(isLocalSizableFace({ id: "face-upload-picked-1" })).toBe(false);
    expect(isLocalSizableFace(null)).toBe(false);
  });
});

describe("Mesh panel local sizing controls", () => {
  const stepDisplayModel: DisplayModel = {
    ...bracketDisplayModel,
    nativeCad: { format: "step", filename: "plate.step", contentBase64: "SVNPLTEwMzAzLTIxOw==" }
  };
  function studyWith(localSizing?: MeshLocalSize[]): Study {
    const study = structuredClone(R2_2_PROJECT_FILE.project.studies[0]!) as Study;
    return { ...study, meshSettings: { preset: "medium", status: "not_started", ...(localSizing ? { localSizing } : {}) } };
  }

  test("project-unit input converts to stored millimetres", () => {
    expect(localSizeInputToMm(2, "SI")).toBe(2);
    expect(localSizeInputToMm(0.04, "US")).toBeCloseTo(1.016, 12);
  });

  test("lists sizes in project units with labelled, keyboard-reachable controls", () => {
    const html = renderToStaticMarkup(
      <MeshLocalSizingSection
        study={studyWith([rule({ sizeMm: 2.54 })])}
        displayModel={stepDisplayModel}
        selectedFace={{ id: "step-face-5", label: "+X face", color: "#fff", center: [0, 0, 0], normal: [1, 0, 0], stressValue: 0 }}
        unitSystem="US"
        preset="medium"
        disabled={false}
        onChange={() => undefined}
      />
    );
    expect(html).toContain("Local sizing");
    expect(html).toContain("Local size for +X face (in)");
    expect(html).toContain('value="0.1"');
    expect(html).toContain('aria-label="Remove local size from +X face"');
    expect(html).toContain("Update selected face");
    expect(html).toContain("Verified on the plate-with-hole Kt benchmark");
  });

  test("asks for a face selection when none is picked, and hides for non-STEP models", () => {
    const html = renderToStaticMarkup(
      <MeshLocalSizingSection study={studyWith()} displayModel={stepDisplayModel} selectedFace={null} unitSystem="SI" preset="medium" disabled={false} onChange={() => undefined} />
    );
    expect(html).toContain("Add to selected face");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add to selected face/);
    expect(html).toContain("Select a face in the viewer");
    expect(html).toContain("Local size (mm)");
    const nonStep = renderToStaticMarkup(
      <MeshLocalSizingSection study={studyWith()} displayModel={bracketDisplayModel} selectedFace={null} unitSystem="SI" preset="medium" disabled={false} onChange={() => undefined} />
    );
    expect(nonStep).toBe("");
  });
});
