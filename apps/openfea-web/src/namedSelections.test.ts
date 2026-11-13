import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { DisplayFace, Study } from "@openfea/schema";
import { assignedFaceTintsForStudy, SUPPORT_FACE_TINT } from "./assignedFaceTints";
import { openLocalProjectPayload } from "./localProjectFactory";
import {
  createNamedFaceSelection,
  deleteNamedSelection,
  faceSelectionForFace,
  faceSelectionLookup,
  faceSetFingerprint,
  isManagedNamedSelection,
  managedNamedSelections,
  namedSelectionAssignmentTarget,
  namedSelectionFacesFor,
  namedSelectionNameError,
  namedSelectionUsage,
  parseFaceSetFingerprint,
  renameNamedSelection,
  selectionFaceIds,
  workingSelectionForNamedSelection
} from "./namedSelections";
import { applyFacePick, EMPTY_WORKING_SELECTION, workingSelectionFaceIds } from "./components/viewer/selection";

const displayFaces: DisplayFace[] = ["step-face-1", "step-face-2", "step-face-3", "face-upload-picked-9"].map((id, index) => ({
  id,
  label: `Face F${index + 1}`,
  color: "#888888",
  center: [index, 0, 0],
  normal: [0, 0, 1],
  stressValue: 0
}));

function perFace(faceId: string, label: string) {
  return {
    id: `selection-${faceId}`,
    name: label,
    entityType: "face" as const,
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: faceId, label }],
    fingerprint: `${faceId}-${label}`
  };
}

function baseStudy(): Study {
  return {
    id: "study-1",
    projectId: "project-1",
    name: "Static",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Part" }],
    materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-uploaded", parameters: {}, status: "complete" }],
    namedSelections: [
      { id: "selection-body-uploaded", name: "Part", entityType: "body", geometryRefs: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Part" }], fingerprint: "body" },
      perFace("step-face-1", "Face F1"),
      perFace("step-face-2", "Face F2"),
      perFace("step-face-3", "Face F3")
    ],
    contacts: [],
    constraints: [],
    loads: [],
    meshSettings: { preset: "medium", status: "not_started" },
    solverSettings: {},
    validation: [],
    runs: []
  } as Study;
}

const registryFingerprints: Record<string, string> = {
  "step-face-1": "stepface:a=100|c=0.0,0.0,1.0|n=0.00,0.00,1.00",
  "step-face-2": "stepface:a=314|c=0.0,0.0,0.5|n=0.00,0.00,0.00"
};

function withGroup(study: Study, name = "Bolt holes", faceIds = ["step-face-1", "step-face-2"]) {
  const faces = namedSelectionFacesFor(study, faceIds, displayFaces, (faceId) => registryFingerprints[faceId]);
  const created = createNamedFaceSelection(study, name, faces, "00000000-0000-4000-8000-000000000001");
  if (!created.ok) throw new Error(created.error);
  return { study: { ...study, namedSelections: created.namedSelections } as Study, selection: created.selection };
}

describe("named selections", () => {
  test("persist each face's B-rep face ID and fingerprint in geometryRefs order", () => {
    const { selection } = withGroup(baseStudy(), "  Bolt   holes ", ["step-face-1", "step-face-2", "step-face-3"]);
    expect(selection.id).toBe("selection-named-00000000-0000-4000-8000-000000000001");
    expect(isManagedNamedSelection(selection)).toBe(true);
    expect(selection.name).toBe("Bolt holes");
    expect(selection.entityType).toBe("face");
    expect(selection.geometryRefs.map((ref) => ref.entityId)).toEqual(["step-face-1", "step-face-2", "step-face-3"]);
    expect(selection.geometryRefs.map((ref) => ref.label)).toEqual(["Face F1", "Face F2", "Face F3"]);
    // STEP faces carry the registry fingerprint; a face without one keeps its per-face selection's.
    expect(parseFaceSetFingerprint(selection.fingerprint)).toEqual([registryFingerprints["step-face-1"], registryFingerprints["step-face-2"], "step-face-3-Face F3"]);
    expect(parseFaceSetFingerprint("step-face-1-Face F1")).toBeNull();
    expect(faceSetFingerprint(["a|b", "c"])).toBe('faceset:v1:["a|b","c"]');
  });

  test("refuse empty, duplicate and over-long names and empty or placeholder face sets", () => {
    const { study } = withGroup(baseStudy());
    expect(namedSelectionNameError(study, "   ")).toBe("Enter a name.");
    expect(namedSelectionNameError(study, "bolt HOLES")).toContain("already exists");
    expect(namedSelectionNameError(study, "x".repeat(81))).toContain("at most 80");
    expect(createNamedFaceSelection(study, "Empty", [], "id-2")).toEqual({ ok: false, error: "Select at least one face first." });
    const placeholder = namedSelectionFacesFor(study, ["face-upload-picked-9"], displayFaces);
    expect(createNamedFaceSelection(study, "Early pick", placeholder, "id-3").ok).toBe(false);
  });

  test("a picked face resolves to its own selection even when a named selection contains it", () => {
    const base = baseStudy();
    const { study } = withGroup({ ...base, namedSelections: base.namedSelections.filter((selection) => selection.id !== "selection-step-face-2") } as Study);
    expect(faceSelectionForFace(study, "step-face-1")?.id).toBe("selection-step-face-1");
    // No per-face selection for F2: the named selection must not stand in for it.
    expect(faceSelectionForFace(study, "step-face-2")).toBeUndefined();
    expect(faceSelectionLookup(study).refForFace("step-face-2")).toBeNull();
  });

  test("rename keeps the id, so supports and loads that reuse it keep working", () => {
    const { study, selection } = withGroup(baseStudy());
    const renamed = renameNamedSelection(study, selection.id, "Mount bores");
    expect(renamed.ok && renamed.selection).toMatchObject({ id: selection.id, name: "Mount bores", geometryRefs: selection.geometryRefs, fingerprint: selection.fingerprint });
    expect(renameNamedSelection(study, selection.id, "")).toEqual({ ok: false, error: "Enter a name." });
    expect(renameNamedSelection(study, "selection-step-face-1", "Nope").ok).toBe(false);
  });

  test("delete only when unused, naming what uses it", () => {
    const { study, selection } = withGroup(baseStudy());
    expect(deleteNamedSelection(study, selection.id)).toMatchObject({ ok: true });
    const used = {
      ...study,
      constraints: [{ id: "c1", type: "fixed", selectionRef: selection.id, parameters: { label: "FS 1" }, status: "complete" }],
      loads: [{ id: "l1", type: "pressure", selectionRef: "selection-step-face-3", selectionRefs: [selection.id], parameters: { label: "Pressure 1", value: 1, units: "MPa" }, status: "complete" }]
    } as Study;
    expect(namedSelectionUsage(used, selection.id)).toEqual(["Support FS 1", "Load Pressure 1"]);
    const refused = deleteNamedSelection(used, selection.id);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("used by Support FS 1, Load Pressure 1");
    // Any other study field naming it also blocks the delete.
    const meshRef = { ...study, meshSettings: { ...study.meshSettings, localSizing: [{ selectionRef: selection.id }] } } as unknown as Study;
    expect(namedSelectionUsage(meshRef, selection.id)).toEqual(["another study setting"]);
    expect(deleteNamedSelection(meshRef, selection.id).ok).toBe(false);
  });

  test("reusing a named selection targets it whole while the working selection is still exactly it", () => {
    const { study, selection } = withGroup(baseStudy());
    const loaded = workingSelectionForNamedSelection(study, selection.id)!;
    expect(loaded).toEqual({ primaryFaceId: "step-face-1", extraRefs: ["selection-step-face-2"], namedSelectionId: selection.id });
    expect(workingSelectionFaceIds(loaded, faceSelectionLookup(study))).toEqual(["step-face-1", "step-face-2"]);
    expect(namedSelectionAssignmentTarget(study, selection.id, "selection-step-face-1", ["selection-step-face-2"])).toEqual({ selectionRef: selection.id, selectionRefs: [] });
    // Not bound, a face outside it, or a body placement: the panel's refs pass through.
    expect(namedSelectionAssignmentTarget(study, null, "selection-step-face-1", ["selection-step-face-2"])).toEqual({ selectionRef: "selection-step-face-1", selectionRefs: ["selection-step-face-2"] });
    expect(namedSelectionAssignmentTarget(study, selection.id, "selection-step-face-3", [])).toEqual({ selectionRef: "selection-step-face-3", selectionRefs: [] });
    expect(namedSelectionAssignmentTarget(study, selection.id, "selection-step-face-1", ["selection-step-face-3"]).selectionRef).toBe("selection-step-face-1");
    expect(namedSelectionAssignmentTarget(study, selection.id, "selection-body-uploaded", []).selectionRef).toBe("selection-body-uploaded");
    // Ctrl-clicking another face unbinds it, so the next Add uses the faces as picked.
    expect(applyFacePick(loaded, "step-face-3", "toggle", faceSelectionLookup(study)).selection.namedSelectionId).toBeNull();
  });

  test("one named selection reused by a support and a load tints every face it holds", () => {
    const { study, selection } = withGroup(baseStudy());
    const reused = {
      ...study,
      constraints: [{ id: "c1", type: "fixed", selectionRef: selection.id, parameters: {}, status: "complete" }],
      loads: [{ id: "l1", type: "force", selectionRef: selection.id, parameters: { value: 10, units: "N", direction: [0, 0, -1] }, status: "complete" }]
    } as Study;
    expect(assignedFaceTintsForStudy(reused)).toEqual([
      { faceId: "step-face-1", color: SUPPORT_FACE_TINT },
      { faceId: "step-face-2", color: SUPPORT_FACE_TINT }
    ]);
    expect(selectionFaceIds(reused, selection.id)).toEqual(["step-face-1", "step-face-2"]);
  });

  test("builds the working selection from a viewer multi-pick, ready to save", () => {
    const study = baseStudy();
    const lookup = faceSelectionLookup(study);
    let state = applyFacePick(EMPTY_WORKING_SELECTION, "step-face-2", "toggle", lookup).selection;
    state = applyFacePick(state, "step-face-3", "toggle", lookup).selection;
    const faces = namedSelectionFacesFor(study, workingSelectionFaceIds(state, lookup), displayFaces, (faceId) => registryFingerprints[faceId]);
    expect(faces.map((face) => face.faceId)).toEqual(["step-face-2", "step-face-3"]);
  });
});

describe("named selection project file fixture", () => {
  test("a version-2 project with a reused named selection opens unchanged", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/named-selection-project-v2.json", import.meta.url), "utf8")) as unknown;
    const opened = openLocalProjectPayload(fixture);
    const study = opened.project.studies[0]!;
    const managed = managedNamedSelections(study);
    expect(managed.map((selection) => selection.name)).toEqual(["Bolt holes"]);
    const [boltHoles] = managed;
    expect(boltHoles!.geometryRefs.map((ref) => ref.entityId)).toEqual(["step-face-4", "step-face-7"]);
    expect(parseFaceSetFingerprint(boltHoles!.fingerprint)).toEqual([
      "stepface:a=78.5|c=-20.0,0.0,5.0|n=0.00,0.00,0.00",
      "stepface:a=78.5|c=20.0,0.0,5.0|n=0.00,0.00,0.00"
    ]);
    // Reused by a support and a load; per-face selections are untouched.
    expect(study.constraints[0]?.selectionRef).toBe(boltHoles!.id);
    expect(study.loads[0]?.selectionRef).toBe(boltHoles!.id);
    expect(namedSelectionUsage(study, boltHoles!.id)).toEqual(["Support FS 1", "Load Force 1"]);
    expect(faceSelectionForFace(study, "step-face-4")?.id).toBe("selection-step-face-4");
  });

  test("a project saved before named selections has no managed selections", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/named-selection-project-v2.json", import.meta.url), "utf8")) as { project: { studies: Study[] } };
    const legacyStudy = fixture.project.studies[0]!;
    const legacy = {
      ...fixture,
      project: {
        ...fixture.project,
        studies: [{
          ...legacyStudy,
          namedSelections: legacyStudy.namedSelections.filter((selection) => !isManagedNamedSelection(selection)),
          constraints: legacyStudy.constraints.map((constraint) => ({ ...constraint, selectionRef: "selection-step-face-4", selectionRefs: ["selection-step-face-7"] })),
          loads: []
        }]
      }
    };
    const study = openLocalProjectPayload(legacy).project.studies[0]!;
    expect(managedNamedSelections(study)).toEqual([]);
    expect(study.constraints[0]).toMatchObject({ selectionRef: "selection-step-face-4", selectionRefs: ["selection-step-face-7"] });
  });
});
