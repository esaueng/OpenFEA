// STEP face label area suffix, kept apart from stepFaces.ts so the panels can
// reformat labels without pulling the lazily loaded STEP registry (and its
// mesh-intake dependency) into the main bundle.
//
// stepFaces.ts bakes "(<area> mm²)" into each face label at import, and the
// label is copied into named selections and saved project files. Those stored
// labels stay as written; a US project rewrites only the suffix at display time,
// from the face's measured area rather than by parsing the localized number.
import { formatArea, type UnitSystem } from "./unitDisplay";

const STEP_FACE_AREA_SUFFIX = / \([^()]* mm²\)$/;

/** The stored suffix form: mm², rounded for a compact face name. */
export function formatStepFaceAreaMm2(area: number): string {
  if (!Number.isFinite(area) || area <= 0) return "unknown area";
  const rounded = area >= 100 ? Math.round(area) : Math.round(area * 10) / 10;
  return `${rounded.toLocaleString()} mm²`;
}

/**
 * A face label in the project's units. `areaMm2` is DisplayFace.area (STEP
 * model space, mm²). Labels without the STEP area suffix, SI projects and faces
 * with no measured area come back unchanged.
 */
export function stepFaceLabelForUnits(label: string, areaMm2: number | undefined, unitSystem: UnitSystem): string {
  if (unitSystem === "SI") return label;
  if (typeof areaMm2 !== "number" || !Number.isFinite(areaMm2) || areaMm2 <= 0) return label;
  if (!STEP_FACE_AREA_SUFFIX.test(label)) return label;
  return label.replace(STEP_FACE_AREA_SUFFIX, ` (${formatArea(areaMm2, "mm^2", unitSystem)})`);
}
