// Named-selection manager (plan 036 R1.2): user-named face sets that one or
// more supports and loads can reference.
//
// Persisted shape (no schema change; see docs/file-format/README.md):
// - A managed named selection is an ordinary `study.namedSelections` entry
//   with `entityType: "face"`, an id that starts with `selection-named-`, the
//   user's name, one `geometryRefs` entry per face (the B-rep face ID for STEP
//   imports), and a `faceset:v1:` fingerprint that lists each face's own
//   fingerprint in `geometryRefs` order.
// - The per-face selections the app creates for every face
//   (`selection-<faceId>`) are unchanged; they remain the "Additional faces"
//   options and the target of single-face picks.
// - A support or load reuses a named selection by naming its id as
//   `selectionRef`. Every consumer that already unions `selectionRef` +
//   `selectionRefs` over all `geometryRefs` (adapter, tints, report) acts on
//   every face in it.
import type { DisplayFace, NamedSelection, Study } from "@openfea/schema";
import { selectionRefsFor } from "@openfea/study-core";
import type { FaceSelectionLookup } from "./components/viewer/selection";

export const NAMED_SELECTION_ID_PREFIX = "selection-named-";
export const FACE_SET_FINGERPRINT_PREFIX = "faceset:v1:";
export const MAX_NAMED_SELECTION_NAME_LENGTH = 80;
/** Ad-hoc faces picked before the STEP face registry loaded (stepFaceHealing.PICKED_UPLOAD_FACE_PREFIX). */
const PICKED_PLACEHOLDER_FACE_PREFIX = "face-upload-picked-";

/** True for a user-managed named selection (created in the manager), as opposed to an automatic per-face one. */
export function isManagedNamedSelection(selection: Pick<NamedSelection, "id"> | null | undefined): boolean {
  return Boolean(selection?.id.startsWith(NAMED_SELECTION_ID_PREFIX));
}

/** The study's managed named selections, in stored order. */
export function managedNamedSelections(study: Pick<Study, "namedSelections">): NamedSelection[] {
  return study.namedSelections.filter((selection) => selection.entityType === "face" && isManagedNamedSelection(selection));
}

/**
 * The automatic per-face selection for a face. Managed named selections are
 * skipped: a face that belongs to "Bolt holes" must still resolve to its own
 * single-face selection when it is picked.
 */
export function faceSelectionForFace(study: Pick<Study, "namedSelections">, faceId: string): NamedSelection | undefined {
  return study.namedSelections.find((item) => item.entityType === "face" && !isManagedNamedSelection(item) && item.geometryRefs.some((ref) => ref.entityId === faceId));
}

/** Every face a selection acts on, in stored order. */
export function selectionFaceIds(study: Pick<Study, "namedSelections">, selectionRef: string): string[] {
  const selection = study.namedSelections.find((item) => item.id === selectionRef);
  return selection?.geometryRefs.filter((ref) => ref.entityType === "face").map((ref) => ref.entityId) ?? [];
}

/** Face ↔ per-face selection lookups for the viewer's working selection. */
export function faceSelectionLookup(study: Pick<Study, "namedSelections">): FaceSelectionLookup {
  return {
    refForFace: (faceId) => faceSelectionForFace(study, faceId)?.id ?? null,
    faceIdsForRef: (ref) => selectionFaceIds(study, ref)
  };
}

/** Composite fingerprint: each face's fingerprint, in `geometryRefs` order. */
export function faceSetFingerprint(faceFingerprints: readonly string[]): string {
  return `${FACE_SET_FINGERPRINT_PREFIX}${JSON.stringify(faceFingerprints)}`;
}

/** The per-face fingerprints of a `faceset:v1:` fingerprint, or null for any other fingerprint. */
export function parseFaceSetFingerprint(fingerprint: string): string[] | null {
  if (!fingerprint.startsWith(FACE_SET_FINGERPRINT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(fingerprint.slice(FACE_SET_FINGERPRINT_PREFIX.length));
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed as string[] : null;
  } catch {
    return null;
  }
}

/** One face of a managed named selection, with the identity that is persisted. */
export type NamedSelectionFace = { faceId: string; label: string; bodyId: string; fingerprint: string };

/**
 * Resolve faces for a new named selection. A STEP face uses its B-rep registry
 * fingerprint when the registry is live (the identity the selection browser
 * gate proves stable across display LODs); otherwise the face's per-face
 * selection fingerprint, else the id-and-centre form new picks use.
 */
export function namedSelectionFacesFor(
  study: Pick<Study, "namedSelections" | "geometryScope">,
  faceIds: readonly string[],
  displayFaces: readonly DisplayFace[],
  registryFingerprint?: (faceId: string) => string | null | undefined
): NamedSelectionFace[] {
  const defaultBodyId = study.geometryScope[0]?.bodyId ?? "body-uploaded";
  return [...new Set(faceIds)].map((faceId) => {
    const perFace = faceSelectionForFace(study, faceId);
    const perFaceRef = perFace?.geometryRefs.find((ref) => ref.entityId === faceId);
    const face = displayFaces.find((candidate) => candidate.id === faceId);
    const fingerprint = registryFingerprint?.(faceId)
      ?? perFace?.fingerprint
      ?? (face ? `${face.id}-${face.center.map((value) => value.toFixed(3)).join("-")}` : faceId);
    return {
      faceId,
      label: face?.label ?? perFaceRef?.label ?? perFace?.name ?? faceId,
      bodyId: perFaceRef?.bodyId ?? defaultBodyId,
      fingerprint
    };
  });
}

/** Why a name cannot be used, or null when it can. Names are trimmed and unique (case-insensitive) among managed selections. */
export function namedSelectionNameError(study: Pick<Study, "namedSelections">, name: string, exceptId?: string): string | null {
  const trimmed = normalizedName(name);
  if (!trimmed) return "Enter a name.";
  if (trimmed.length > MAX_NAMED_SELECTION_NAME_LENGTH) return `Use at most ${MAX_NAMED_SELECTION_NAME_LENGTH} characters.`;
  const clash = managedNamedSelections(study).find((selection) => selection.id !== exceptId && selection.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  return clash ? `A named selection called ${clash.name} already exists.` : null;
}

export type NamedSelectionEdit = { ok: true; namedSelections: NamedSelection[]; selection: NamedSelection } | { ok: false; error: string };

/** Create a managed named selection from the working selection's faces. */
export function createNamedFaceSelection(study: Pick<Study, "namedSelections">, name: string, faces: readonly NamedSelectionFace[], id: string): NamedSelectionEdit {
  const nameError = namedSelectionNameError(study, name);
  if (nameError) return { ok: false, error: nameError };
  if (!faces.length) return { ok: false, error: "Select at least one face first." };
  if (faces.some((face) => face.faceId.startsWith(PICKED_PLACEHOLDER_FACE_PREFIX))) {
    return { ok: false, error: "A face was picked before the model's faces finished loading. Pick it again, then save the selection." };
  }
  const selectionId = id.startsWith(NAMED_SELECTION_ID_PREFIX) ? id : `${NAMED_SELECTION_ID_PREFIX}${id}`;
  if (study.namedSelections.some((selection) => selection.id === selectionId)) return { ok: false, error: "That named selection already exists." };
  const selection: NamedSelection = {
    id: selectionId,
    name: normalizedName(name),
    entityType: "face",
    geometryRefs: faces.map((face) => ({ bodyId: face.bodyId, entityType: "face", entityId: face.faceId, label: face.label })),
    fingerprint: faceSetFingerprint(faces.map((face) => face.fingerprint))
  };
  return { ok: true, selection, namedSelections: [...study.namedSelections, selection] };
}

/** Rename a managed named selection; references keep working because they use its id. */
export function renameNamedSelection(study: Pick<Study, "namedSelections">, selectionId: string, name: string): NamedSelectionEdit {
  const selection = managedNamedSelections(study).find((candidate) => candidate.id === selectionId);
  if (!selection) return { ok: false, error: "That named selection no longer exists." };
  const nameError = namedSelectionNameError(study, name, selectionId);
  if (nameError) return { ok: false, error: nameError };
  const renamed = { ...selection, name: normalizedName(name) };
  return { ok: true, selection: renamed, namedSelections: study.namedSelections.map((candidate) => candidate.id === selectionId ? renamed : candidate) };
}

/**
 * Where a selection is used, as short labels ("Fixed support FS 1", "Load
 * Force 2"). Supports, loads (including a bolt preload's opposing face) and
 * material assignments are named; any other study field that names the id is
 * reported as "another study setting".
 */
export function namedSelectionUsage(study: Study, selectionId: string): string[] {
  const usage: string[] = [];
  for (const support of study.constraints) {
    if (selectionRefsFor(support).includes(selectionId)) usage.push(`Support ${entryLabel(support.parameters, support.id)}`);
  }
  for (const load of study.loads) {
    if (selectionRefsFor(load).includes(selectionId) || load.parameters.secondarySelectionRef === selectionId) usage.push(`Load ${entryLabel(load.parameters, load.id)}`);
  }
  for (const assignment of study.materialAssignments) {
    if (assignment.selectionRef === selectionId) usage.push("Material assignment");
  }
  if (!usage.length && isReferencedOutsideNamedSelections(study, selectionId)) usage.push("another study setting");
  return usage;
}

/** Delete a managed named selection only when nothing references it. */
export function deleteNamedSelection(study: Study, selectionId: string): { ok: true; namedSelections: NamedSelection[] } | { ok: false; error: string } {
  const selection = managedNamedSelections(study).find((candidate) => candidate.id === selectionId);
  if (!selection) return { ok: false, error: "That named selection no longer exists." };
  const usage = namedSelectionUsage(study, selectionId);
  if (usage.length) return { ok: false, error: `${selection.name} is used by ${usage.join(", ")}. Remove or move those first.` };
  return { ok: true, namedSelections: study.namedSelections.filter((candidate) => candidate.id !== selectionId) };
}

/**
 * Swap a panel Add's face refs for a reused named selection. Applies only
 * while the working selection is still exactly that named selection: the
 * primary is one of its faces and every additional face belongs to it. Body
 * placements (volume force, heat generation) and payload picks pass through.
 */
export function namedSelectionAssignmentTarget(
  study: Pick<Study, "namedSelections">,
  boundSelectionId: string | null | undefined,
  selectionRef: string | undefined,
  extraRefs: readonly string[] | undefined
): { selectionRef: string | undefined; selectionRefs: string[] } {
  const passthrough = { selectionRef, selectionRefs: [...(extraRefs ?? [])] };
  if (!boundSelectionId || !selectionRef) return passthrough;
  const named = managedNamedSelections(study).find((candidate) => candidate.id === boundSelectionId);
  if (!named) return passthrough;
  const memberFaces = new Set(selectionFaceIds(study, named.id));
  const primaryFaces = selectionFaceIds(study, selectionRef);
  if (primaryFaces.length !== 1 || !memberFaces.has(primaryFaces[0]!)) return passthrough;
  if (!(extraRefs ?? []).every((ref) => selectionFaceIds(study, ref).every((faceId) => memberFaces.has(faceId)))) return passthrough;
  return { selectionRef: named.id, selectionRefs: [] };
}

/** The working selection a named selection loads: its first face as the primary pick, the others as additional faces. */
export function workingSelectionForNamedSelection(study: Pick<Study, "namedSelections">, selectionId: string): { primaryFaceId: string | null; extraRefs: string[]; namedSelectionId: string } | null {
  const named = managedNamedSelections(study).find((candidate) => candidate.id === selectionId);
  if (!named) return null;
  const [primaryFaceId = null, ...others] = selectionFaceIds(study, named.id);
  const extraRefs = others.map((faceId) => faceSelectionForFace(study, faceId)?.id).filter((ref): ref is string => Boolean(ref));
  return { primaryFaceId, extraRefs: [...new Set(extraRefs)], namedSelectionId: named.id };
}

function isReferencedOutsideNamedSelections(study: Study, selectionId: string): boolean {
  const { namedSelections: _namedSelections, ...rest } = study;
  return JSON.stringify(rest).includes(JSON.stringify(selectionId));
}

function entryLabel(parameters: Record<string, unknown> | undefined, fallback: string): string {
  const label = parameters?.label;
  return typeof label === "string" && label.trim() ? label.trim() : fallback;
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}
