import type { Study } from "@openfea/schema";
import { selectionRefsFor } from "@openfea/study-core";
import type { ViewerFaceTint } from "./components/CadViewer";

export const LOAD_FACE_TINT = "#f59e0b";
export const SUPPORT_FACE_TINT = "#2dd4bf";

/**
 * Faces carrying a support (teal) or a load (amber), tinted on the model so an
 * assignment is visible where it lives, not only as a callout (2026-09 review F2).
 * A multi-face entry tints every face it acts on — its selectionRef plus its
 * selectionRefs — using the same refs the adapter unions for the solve. A face
 * with both keeps the support tint.
 */
export function assignedFaceTintsForStudy(study: Study | null | undefined): ViewerFaceTint[] {
  if (!study) return [];
  const faceIdsFor = (selectionRef: string) => study.namedSelections.find((item) => item.id === selectionRef)?.geometryRefs.filter((ref) => ref.entityType === "face").map((ref) => ref.entityId) ?? [];
  const tints = new Map<string, string>();
  for (const load of study.loads) for (const ref of selectionRefsFor(load)) for (const faceId of faceIdsFor(ref)) tints.set(faceId, LOAD_FACE_TINT);
  for (const support of study.constraints) for (const ref of selectionRefsFor(support)) for (const faceId of faceIdsFor(ref)) tints.set(faceId, SUPPORT_FACE_TINT);
  return [...tints].map(([faceId, color]) => ({ faceId, color }));
}
