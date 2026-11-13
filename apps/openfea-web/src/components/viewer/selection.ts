// Viewer pick and face-selection seam (plan 036 R1.1/R1.2), extracted from
// CadViewer.tsx so the rules can be unit-tested and reused by the real-Chrome
// STEP selection harness. Everything here is pure: no React, no rendering.
//
// - Click vs drag: R3F fires onClick for any object hit at pointer-down and
//   pointer-up regardless of travel, so travel past the threshold is an orbit.
// - Pick intent: a plain pick replaces the primary face; Ctrl-click (Cmd-click
//   on macOS) toggles a face in or out of the working selection.
// - STEP picks resolve to persistent B-rep face IDs through the face registry
//   (triangle attribution first, then the exact point/normal fallback).
// - The working selection is the primary face plus the "Additional faces"
//   selection refs, the same model the Supports and Loads panels persist as
//   `selectionRef` + `selectionRefs`.
import type { Object3D } from "three";
import type { StepFaceRegistry } from "../../stepFaces";

/** Pointer travel (CSS px) above which a click is an orbit/pan drag, not a pick (2026-09 review D26). */
export const VIEWER_CLICK_DRAG_THRESHOLD_PX = 4;

/** True when a pointer click travelled little enough to count as a face pick. */
export function isPickClick(delta: number): boolean {
  return delta <= VIEWER_CLICK_DRAG_THRESHOLD_PX;
}

/** `replace` sets the primary face; `toggle` adds or removes a face from the working selection. */
export type PickIntent = "replace" | "toggle";

export type PickModifiers = { ctrlKey?: boolean; metaKey?: boolean };

/**
 * Ctrl-click, or Cmd-click on macOS, toggles a face. Shift is deliberately not
 * a selection modifier: Shift+drag pans the camera (ShiftPanControls), and Alt
 * disables placement snapping.
 */
export function pickIntentForModifiers(modifiers: PickModifiers | null | undefined): PickIntent {
  return modifiers?.ctrlKey || modifiers?.metaKey ? "toggle" : "replace";
}

/** Walk through R3F's picked object ancestry to resolve an invisible hole-opening target. */
export function stepFaceIdFromPickObject(object: Object3D): string | null {
  let current: Object3D | null = object;
  while (current) {
    const faceId: unknown = current.userData?.openfeaStepFaceId;
    if (typeof faceId === "string" && faceId.length > 0) return faceId;
    current = current.parent;
  }
  return null;
}

/** Preview meshes carry userData.openfeaObjectId = "step-object-<n>" in import order; returns the 0-based mesh index. */
export function stepPreviewMeshIndexFor(object: Object3D): number | null {
  let current: Object3D | null = object;
  while (current) {
    const id: unknown = current.userData?.openfeaObjectId;
    if (typeof id === "string") {
      const match = /^step-object-(\d+)$/.exec(id);
      return match ? Number.parseInt(match[1]!, 10) - 1 : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Once the STEP registry is live, never manufacture another
 * "face-upload-picked-*" placeholder; other uploads (and a cold registry) still
 * fall back to ad-hoc point/normal faces.
 */
export function shouldCreateUploadedFacePlaceholder(nativeCadFormat: string | undefined, hasLiveRegistry: boolean): boolean {
  return nativeCadFormat !== "step" || !hasLiveRegistry;
}

/** The registry lookups a STEP pick needs, injectable so tests and the browser harness use the same resolver. */
export type StepPickApi = {
  stepFaceIdForMeshTriangle: (registry: StepFaceRegistry, meshIndex: number, triangleIndex: number) => string | null;
  resolvePickedStepFace: (registry: StepFaceRegistry, point: [number, number, number], normal: [number, number, number] | undefined) => { faceId: string } | null;
  stepSupportFaceIdForPickedFace: (registry: StepFaceRegistry, pickedFaceId: string) => string;
};

export type StepPick = {
  /** The raycast hit object (a preview mesh or an invisible hole-opening target). */
  object: Object3D;
  /** Triangle index within that mesh, when the hit carries one. */
  faceIndex?: number | null;
  /** Model-space point and normal for the exact fallback; evaluated only when needed. */
  exactFallback?: () => { point: [number, number, number]; normal: [number, number, number] };
};

/**
 * Resolve a raycast hit on the STEP preview to a persistent B-rep face ID: an
 * explicit hole-opening target first, then triangle attribution, then (when
 * allowed) the exact point/normal resolver. Supports prefer a blind hole's
 * cylindrical wall over its planar bottom.
 */
export function resolveStepPickFaceId(
  api: StepPickApi,
  registry: StepFaceRegistry,
  pick: StepPick,
  options: { preferHoleWall: boolean; allowExactFallback: boolean }
): string | null {
  const meshIndex = stepPreviewMeshIndexFor(pick.object);
  let faceId = stepFaceIdFromPickObject(pick.object) ?? (meshIndex !== null && typeof pick.faceIndex === "number"
    ? api.stepFaceIdForMeshTriangle(registry, meshIndex, pick.faceIndex)
    : null);
  if (!faceId && options.allowExactFallback && pick.exactFallback) {
    const { point, normal } = pick.exactFallback();
    faceId = api.resolvePickedStepFace(registry, point, normal)?.faceId ?? null;
  }
  if (!faceId) return null;
  return options.preferHoleWall ? api.stepSupportFaceIdForPickedFace(registry, faceId) : faceId;
}

// --- Working selection -------------------------------------------------------

/**
 * The faces a support or load is about to act on: the primary face (viewer
 * pick) plus the "Additional faces" as named-selection refs, which is what the
 * panels store as `selectionRef` + `selectionRefs`. `namedSelectionId` is set
 * while the selection is exactly a reused named selection (manager "Use") and
 * cleared by any change.
 */
export type WorkingFaceSelection = {
  primaryFaceId: string | null;
  extraRefs: readonly string[];
  namedSelectionId: string | null;
};

export const EMPTY_WORKING_SELECTION: WorkingFaceSelection = { primaryFaceId: null, extraRefs: [], namedSelectionId: null };

/** How faces and per-face selection refs relate in the open study. */
export type FaceSelectionLookup = {
  /** The per-face named selection for a face, or null when the study has none. */
  refForFace: (faceId: string) => string | null;
  /** Every face a selection ref acts on, in stored order. */
  faceIdsForRef: (ref: string) => readonly string[];
};

/** What a pick did, for the live announcement and the workspace message. */
export type FacePickOutcome = "primary" | "added" | "removed" | "unchanged" | "unavailable";

export type FacePickResult = { selection: WorkingFaceSelection; outcome: FacePickOutcome };

/**
 * Apply one viewer (or keyboard face-button) pick.
 *
 * - `replace` makes the face the primary pick. Additional faces stay checked,
 *   so a face can be chosen in the viewer after ticking extras in the panel
 *   (the existing checklist workflow); the face itself leaves the extras.
 * - `toggle` (Ctrl/Cmd-click) adds the face when it is not selected and removes
 *   it when it is. With no primary face it becomes the primary. Removing the
 *   primary promotes the first additional face. A face without a per-face
 *   selection cannot be an additional face (`unavailable`).
 */
export function applyFacePick(state: WorkingFaceSelection, faceId: string, intent: PickIntent, lookup: FaceSelectionLookup): FacePickResult {
  const ref = lookup.refForFace(faceId);
  if (intent === "replace") {
    const extraRefs = ref ? state.extraRefs.filter((candidate) => candidate !== ref) : state.extraRefs;
    if (state.primaryFaceId === faceId && extraRefs.length === state.extraRefs.length) {
      return { selection: state, outcome: "unchanged" };
    }
    return { selection: { primaryFaceId: faceId, extraRefs, namedSelectionId: null }, outcome: "primary" };
  }
  if (state.primaryFaceId === faceId) {
    const promotedIndex = state.extraRefs.findIndex((candidate) => lookup.faceIdsForRef(candidate).length === 1);
    if (promotedIndex < 0) {
      return { selection: { primaryFaceId: null, extraRefs: state.extraRefs, namedSelectionId: null }, outcome: "removed" };
    }
    const promotedRef = state.extraRefs[promotedIndex]!;
    return {
      selection: {
        primaryFaceId: lookup.faceIdsForRef(promotedRef)[0] ?? null,
        extraRefs: state.extraRefs.filter((_candidate, index) => index !== promotedIndex),
        namedSelectionId: null
      },
      outcome: "removed"
    };
  }
  if (ref && state.extraRefs.includes(ref)) {
    return { selection: { ...state, extraRefs: state.extraRefs.filter((candidate) => candidate !== ref), namedSelectionId: null }, outcome: "removed" };
  }
  if (!state.primaryFaceId) {
    return { selection: { ...state, primaryFaceId: faceId, namedSelectionId: null }, outcome: "primary" };
  }
  if (!ref) return { selection: state, outcome: "unavailable" };
  return { selection: { ...state, extraRefs: [...state.extraRefs, ref], namedSelectionId: null }, outcome: "added" };
}

/** Tick or untick one "Additional faces" entry (panel checklist or keyboard). */
export function toggleAdditionalRef(state: WorkingFaceSelection, ref: string): WorkingFaceSelection {
  const extraRefs = state.extraRefs.includes(ref) ? state.extraRefs.filter((candidate) => candidate !== ref) : [...state.extraRefs, ref];
  return { ...state, extraRefs, namedSelectionId: null };
}

/** Every face in the working selection, primary first, de-duplicated. */
export function workingSelectionFaceIds(state: WorkingFaceSelection, lookup: Pick<FaceSelectionLookup, "faceIdsForRef">): string[] {
  const faceIds = [state.primaryFaceId, ...state.extraRefs.flatMap((ref) => lookup.faceIdsForRef(ref))].filter((faceId): faceId is string => Boolean(faceId));
  return [...new Set(faceIds)];
}

/** Faces the viewer highlights as selected: the primary pick plus the additional faces. */
export function highlightedSelectionFaceIds(primaryFaceId: string | null | undefined, additionalFaceIds: readonly string[] | undefined): string[] {
  return [...new Set([primaryFaceId, ...(additionalFaceIds ?? [])].filter((faceId): faceId is string => Boolean(faceId)))];
}

/** `3 faces selected` — the screen-reader announcement for the working selection. */
export function selectionCountLabel(count: number): string {
  if (count <= 0) return "No faces selected";
  return `${count} face${count === 1 ? "" : "s"} selected`;
}

/** The on-canvas chip text: the primary face, then how many more are selected. */
export function selectionChipText(primaryLabel: string, additionalCount: number): string {
  return additionalCount > 0 ? `${primaryLabel} +${additionalCount} face${additionalCount === 1 ? "" : "s"}` : primaryLabel;
}
