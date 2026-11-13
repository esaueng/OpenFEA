import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import type { StepFaceRegistry } from "../../stepFaces";
import {
  applyFacePick,
  EMPTY_WORKING_SELECTION,
  highlightedSelectionFaceIds,
  isPickClick,
  pickIntentForModifiers,
  resolveStepPickFaceId,
  selectionChipText,
  selectionCountLabel,
  shouldCreateUploadedFacePlaceholder,
  stepFaceIdFromPickObject,
  stepPreviewMeshIndexFor,
  toggleAdditionalRef,
  VIEWER_CLICK_DRAG_THRESHOLD_PX,
  workingSelectionFaceIds,
  type FaceSelectionLookup,
  type StepPickApi,
  type WorkingFaceSelection
} from "./selection";

// Faces A–D each have a per-face selection `sel-<id>`; face P (a placeholder
// pick) has none; `group` is a managed named selection over A and B.
const lookup: FaceSelectionLookup = {
  refForFace: (faceId) => (["A", "B", "C", "D"].includes(faceId) ? `sel-${faceId}` : null),
  faceIdsForRef: (ref) => (ref === "group" ? ["A", "B"] : ref.startsWith("sel-") ? [ref.slice(4)] : [])
};

function pick(state: WorkingFaceSelection, faceId: string, intent: "replace" | "toggle") {
  return applyFacePick(state, faceId, intent, lookup);
}

describe("viewer click vs drag", () => {
  test("a click with pointer travel past the threshold is an orbit drag, not a pick (2026-09 review D26)", () => {
    expect(VIEWER_CLICK_DRAG_THRESHOLD_PX).toBe(4);
    expect(isPickClick(0)).toBe(true);
    expect(isPickClick(4)).toBe(true);
    expect(isPickClick(4.01)).toBe(false);
    expect(isPickClick(40)).toBe(false);
  });
});

describe("pick intent", () => {
  test("Ctrl-click and Cmd-click toggle; plain, Shift and Alt clicks replace", () => {
    expect(pickIntentForModifiers({})).toBe("replace");
    expect(pickIntentForModifiers(undefined)).toBe("replace");
    expect(pickIntentForModifiers({ ctrlKey: true })).toBe("toggle");
    expect(pickIntentForModifiers({ metaKey: true })).toBe("toggle");
    // Shift+drag pans the camera and Alt disables snapping; neither selects.
    expect(pickIntentForModifiers({ shiftKey: true } as never)).toBe("replace");
    expect(pickIntentForModifiers({ altKey: true } as never)).toBe("replace");
  });
});

describe("STEP pick resolution", () => {
  const registry = {} as StepFaceRegistry;
  function fakeApi(overrides: Partial<StepPickApi> = {}): StepPickApi {
    return {
      stepFaceIdForMeshTriangle: vi.fn((_registry, meshIndex: number, triangle: number) => `step-face-m${meshIndex}-t${triangle}`),
      resolvePickedStepFace: vi.fn(() => ({ faceId: "step-face-exact" })),
      stepSupportFaceIdForPickedFace: vi.fn((_registry, faceId: string) => (faceId === "step-face-m1-t7" ? "step-face-wall" : faceId)),
      ...overrides
    };
  }
  function stepMesh(index: number): THREE.Mesh {
    const group = new THREE.Group();
    group.userData.openfeaObjectId = `step-object-${index}`;
    const mesh = new THREE.Mesh();
    group.add(mesh);
    return mesh;
  }

  test("resolves a cylindrical hole-wall pick target through object ancestry", () => {
    const parent = new THREE.Group();
    parent.userData.openfeaStepFaceId = "step-face-hole";
    const child = new THREE.Mesh();
    parent.add(child);
    expect(stepFaceIdFromPickObject(child)).toBe("step-face-hole");
    expect(stepFaceIdFromPickObject(new THREE.Mesh())).toBeNull();
    const api = fakeApi();
    expect(resolveStepPickFaceId(api, registry, { object: child, faceIndex: 3 }, { preferHoleWall: false, allowExactFallback: true })).toBe("step-face-hole");
    expect(api.stepFaceIdForMeshTriangle).not.toHaveBeenCalled();
  });

  test("maps preview meshes to 0-based registry mesh indices", () => {
    expect(stepPreviewMeshIndexFor(stepMesh(1))).toBe(0);
    expect(stepPreviewMeshIndexFor(stepMesh(12))).toBe(11);
    const other = new THREE.Mesh();
    other.userData.openfeaObjectId = "beam-payload";
    expect(stepPreviewMeshIndexFor(other)).toBeNull();
  });

  test("attributes a triangle to its B-rep face and prefers the hole wall for supports", () => {
    const api = fakeApi();
    expect(resolveStepPickFaceId(api, registry, { object: stepMesh(2), faceIndex: 7 }, { preferHoleWall: false, allowExactFallback: true })).toBe("step-face-m1-t7");
    expect(resolveStepPickFaceId(api, registry, { object: stepMesh(2), faceIndex: 7 }, { preferHoleWall: true, allowExactFallback: true })).toBe("step-face-wall");
  });

  test("uses the exact point/normal fallback only when allowed, and only evaluates it then", () => {
    const api = fakeApi({ stepFaceIdForMeshTriangle: vi.fn(() => null) });
    const exactFallback = vi.fn(() => ({ point: [0, 0, 1] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }));
    expect(resolveStepPickFaceId(api, registry, { object: stepMesh(1), faceIndex: 0, exactFallback }, { preferHoleWall: false, allowExactFallback: false })).toBeNull();
    expect(exactFallback).not.toHaveBeenCalled();
    expect(resolveStepPickFaceId(api, registry, { object: stepMesh(1), faceIndex: 0, exactFallback }, { preferHoleWall: false, allowExactFallback: true })).toBe("step-face-exact");
    expect(exactFallback).toHaveBeenCalledTimes(1);
  });

  test("does not create placeholder faces after the STEP registry is live", () => {
    expect(shouldCreateUploadedFacePlaceholder("step", true)).toBe(false);
    expect(shouldCreateUploadedFacePlaceholder("step", false)).toBe(true);
    expect(shouldCreateUploadedFacePlaceholder("stl", true)).toBe(true);
  });
});

describe("working face selection", () => {
  test("Ctrl-click adds faces after the primary pick and removes them again", () => {
    let state = pick(EMPTY_WORKING_SELECTION, "A", "replace").selection;
    expect(state).toEqual({ primaryFaceId: "A", extraRefs: [], namedSelectionId: null });

    const added = pick(state, "B", "toggle");
    expect(added.outcome).toBe("added");
    state = pick(added.selection, "C", "toggle").selection;
    expect(state.extraRefs).toEqual(["sel-B", "sel-C"]);
    expect(workingSelectionFaceIds(state, lookup)).toEqual(["A", "B", "C"]);

    const removed = pick(state, "B", "toggle");
    expect(removed.outcome).toBe("removed");
    expect(workingSelectionFaceIds(removed.selection, lookup)).toEqual(["A", "C"]);
  });

  test("Ctrl-click with nothing selected makes the face the primary pick", () => {
    const result = pick(EMPTY_WORKING_SELECTION, "C", "toggle");
    expect(result.outcome).toBe("primary");
    expect(result.selection.primaryFaceId).toBe("C");
  });

  test("Ctrl-click on the primary face removes it and promotes the first additional face", () => {
    const state: WorkingFaceSelection = { primaryFaceId: "A", extraRefs: ["sel-B", "sel-C"], namedSelectionId: null };
    const result = pick(state, "A", "toggle");
    expect(result.outcome).toBe("removed");
    expect(result.selection).toEqual({ primaryFaceId: "B", extraRefs: ["sel-C"], namedSelectionId: null });
    expect(pick({ primaryFaceId: "A", extraRefs: [], namedSelectionId: null }, "A", "toggle").selection.primaryFaceId).toBeNull();
  });

  test("a face without its own selection can be the primary pick but not an additional face", () => {
    const state = pick(EMPTY_WORKING_SELECTION, "A", "replace").selection;
    const result = pick(state, "P", "toggle");
    expect(result.outcome).toBe("unavailable");
    expect(result.selection).toBe(state);
    expect(pick(state, "P", "replace").selection.primaryFaceId).toBe("P");
  });

  test("a plain pick moves the primary face and keeps the checked additional faces (checklist-first workflow)", () => {
    const state: WorkingFaceSelection = { primaryFaceId: "A", extraRefs: ["sel-B", "sel-C"], namedSelectionId: null };
    const result = pick(state, "B", "replace");
    expect(result.outcome).toBe("primary");
    expect(result.selection).toEqual({ primaryFaceId: "B", extraRefs: ["sel-C"], namedSelectionId: null });
  });

  test("any change unbinds a reused named selection; re-picking the same primary does not", () => {
    const bound: WorkingFaceSelection = { primaryFaceId: "A", extraRefs: ["sel-B"], namedSelectionId: "group" };
    expect(pick(bound, "A", "replace")).toEqual({ selection: bound, outcome: "unchanged" });
    expect(pick(bound, "C", "toggle").selection.namedSelectionId).toBeNull();
    expect(pick(bound, "C", "replace").selection.namedSelectionId).toBeNull();
    expect(toggleAdditionalRef(bound, "sel-D").namedSelectionId).toBeNull();
  });

  test("the checklist toggles the same additional refs as Ctrl-click", () => {
    const state = toggleAdditionalRef(toggleAdditionalRef(EMPTY_WORKING_SELECTION, "sel-B"), "sel-C");
    expect(state.extraRefs).toEqual(["sel-B", "sel-C"]);
    expect(pick({ ...state, primaryFaceId: "A" }, "C", "toggle").selection.extraRefs).toEqual(["sel-B"]);
    expect(toggleAdditionalRef(state, "sel-B").extraRefs).toEqual(["sel-C"]);
  });

  test("expands refs to faces without duplicates and highlights every selected face", () => {
    const state: WorkingFaceSelection = { primaryFaceId: "A", extraRefs: ["group", "sel-C"], namedSelectionId: null };
    expect(workingSelectionFaceIds(state, lookup)).toEqual(["A", "B", "C"]);
    expect(highlightedSelectionFaceIds("A", ["B", "A", "C"])).toEqual(["A", "B", "C"]);
    expect(highlightedSelectionFaceIds(null, undefined)).toEqual([]);
  });

  test("announces the selection count and names the primary face on the chip", () => {
    expect(selectionCountLabel(0)).toBe("No faces selected");
    expect(selectionCountLabel(1)).toBe("1 face selected");
    expect(selectionCountLabel(3)).toBe("3 faces selected");
    expect(selectionChipText("Top face", 0)).toBe("Top face");
    expect(selectionChipText("Top face", 1)).toBe("Top face +1 face");
    expect(selectionChipText("Top face", 2)).toBe("Top face +2 faces");
  });
});
