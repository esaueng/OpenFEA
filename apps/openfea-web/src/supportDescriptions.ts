import { nearestGlobalAxis, SUPPORT_GEOMETRY_POLICY } from "@openfea/core";
import { ELASTIC_SUPPORT_STIFFNESS_UNITS, elasticSupportStiffness, fixedSupportComponents, SUPPORT_COMPONENTS, type Constraint, type DisplayFace, type DisplayModel, type Study, type SupportComponent } from "@openfea/schema";
import { foundationModulusFromNewtonsPerCubicMetre, foundationModulusToNewtonsPerCubicMetre, type FoundationModulusUnit } from "@openfea/units";
import { formatDisplayNumber, type UnitSystem } from "./unitDisplay";
import { selectionRefsFor } from "@openfea/study-core";

/**
 * User-facing wording for per-component fixed and symmetry/roller supports
 * (plan 036 R1.4). The Supports panel rows and the report share it, so the
 * two never describe the same support differently.
 */

/** Shown wherever a symmetry or per-component support is offered or listed. */
export const SUPPORT_COMPONENT_DEVELOPMENT_NOTE =
  "Symmetry and per-component supports are development-grade: their closed-form gates pass, but they are not yet verified by an automated browser run.";

export const SYMMETRY_SUPPORT_TOLERANCE_NOTE =
  `A symmetry/roller face must be flat and within ${SUPPORT_GEOMETRY_POLICY.symmetryAxisToleranceDegrees}° of the global X, Y or Z axis; it holds only the displacement normal to the face.`;

export const SYMMETRY_MODAL_NOTE =
  "In a modal study a symmetry plane keeps only the modes that are symmetric about it.";

/** Elastic (Winkler foundation) supports, plan 036 R1.5. */
export const ELASTIC_SUPPORT_APPROXIMATION_NOTE =
  "Winkler foundation: independent linear springs per unit area, normal and tangential to each face. They pull as well as push (no lift-off) and do not spread load through the foundation.";

export const ELASTIC_SUPPORT_DEVELOPMENT_NOTE =
  "Elastic supports are development-grade: their closed-form gates pass, but they are not yet verified by an automated browser run.";

/** 0.05 N/mm^3 (50 MN/m^3), a stiff rubber pad or firm soil; both directions positive so the part is held. */
export const DEFAULT_FOUNDATION_MODULUS_N_PER_M3 = 5e7;

export function foundationModulusDisplayUnit(unitSystem: UnitSystem): { unit: FoundationModulusUnit; label: string } {
  return unitSystem === "US" ? { unit: "lbf/in^3", label: "lbf/in³" } : { unit: "N/mm^3", label: "N/mm³" };
}

export function foundationModulusForDisplay(valueNPerM3: number, unitSystem: UnitSystem): number {
  return foundationModulusFromNewtonsPerCubicMetre(valueNPerM3, foundationModulusDisplayUnit(unitSystem).unit);
}

export function foundationModulusFromDisplay(value: number, unitSystem: UnitSystem): number {
  return foundationModulusToNewtonsPerCubicMetre(value, foundationModulusDisplayUnit(unitSystem).unit);
}

/** Parameters stored for an elastic support: stiffnesses in N/m^3 with the unit named. */
export function elasticSupportParameters(parameters: Record<string, unknown>, normalStiffness: number, tangentialStiffness: number): Record<string, unknown> {
  const { components: _components, value: _value, component: _component, ...rest } = parameters;
  return { ...rest, normalStiffness, tangentialStiffness, units: ELASTIC_SUPPORT_STIFFNESS_UNITS };
}

export function formatSupportComponents(components: readonly SupportComponent[]): string {
  return components.map((component) => component.toUpperCase()).join(", ");
}

/** True when a fixed support holds fewer than all three components. */
export function isPartialFixedSupport(support: Pick<Constraint, "type" | "parameters">): boolean {
  return support.type === "fixed" && fixedSupportComponents(support).length < SUPPORT_COMPONENTS.length;
}

/**
 * The parameters to store for a fixed support holding `components`. Holding
 * all three omits the field, so the saved support is byte-identical to one
 * made before per-component supports existed.
 */
export function fixedSupportParameters(parameters: Record<string, unknown>, components: readonly SupportComponent[]): Record<string, unknown> {
  const { components: _previous, ...rest } = parameters;
  const ordered = SUPPORT_COMPONENTS.filter((component) => components.includes(component));
  return ordered.length && ordered.length < SUPPORT_COMPONENTS.length ? { ...rest, components: ordered } : rest;
}

export type SymmetryFaceCheck =
  | { ok: true; component: SupportComponent }
  | { ok: false; message: string };

/**
 * Pre-check of a display face for a symmetry/roller support. The solve repeats
 * the check on the solver mesh facets, which is authoritative; this only lets
 * the panel refuse an unusable face before the run.
 */
export function symmetryCheckForDisplayFace(face: Pick<DisplayFace, "label" | "normal" | "surfaceType">): SymmetryFaceCheck {
  if (face.surfaceType === "cylindrical" || face.surfaceType === "curved") {
    return { ok: false, message: `${face.label} is curved. ${SYMMETRY_SUPPORT_TOLERANCE_NOTE}` };
  }
  const alignment = nearestGlobalAxis(face.normal);
  if (!alignment) return { ok: false, message: `${face.label} has no usable normal for a symmetry support.` };
  const tolerance = SUPPORT_GEOMETRY_POLICY.symmetryAxisToleranceDegrees;
  if (alignment.deviationDegrees > tolerance) {
    return {
      ok: false,
      message: `${face.label} is ${formatDegrees(alignment.deviationDegrees)}° from the ${alignment.component.toUpperCase()} axis. A symmetry/roller face must be within ${tolerance}° of a global axis; use a fixed support with chosen components instead.`
    };
  }
  return { ok: true, component: alignment.component };
}

/** Checks every face a symmetry support would act on; they must share one axis. */
export function symmetryCheckForFaces(faces: ReadonlyArray<Pick<DisplayFace, "label" | "normal" | "surfaceType">>): SymmetryFaceCheck | undefined {
  let component: SupportComponent | undefined;
  for (const face of faces) {
    const check = symmetryCheckForDisplayFace(face);
    if (!check.ok) return check;
    if (component && check.component !== component) {
      return { ok: false, message: "The selected faces are normal to different axes. Add one symmetry support per axis." };
    }
    component = check.component;
  }
  return component ? { ok: true, component } : undefined;
}

/** Display faces a support acts on, primary first. */
export function displayFacesForEntry(study: Pick<Study, "namedSelections">, displayModel: Pick<DisplayModel, "faces"> | undefined, entry: { selectionRef: string; selectionRefs?: string[] }): DisplayFace[] {
  if (!displayModel) return [];
  return selectionRefsFor(entry).flatMap((ref) => {
    const selection = study.namedSelections.find((candidate) => candidate.id === ref);
    const geometryRef = selection?.geometryRefs.find((candidate) => candidate.entityType === "face");
    const face = geometryRef ? displayModel.faces.find((candidate) => candidate.id === geometryRef.entityId) : undefined;
    return face ? [face] : [];
  });
}

/**
 * The row and report wording for a fixed or symmetry support. Other support
 * types keep their own value labels. `faces` are the display faces the support
 * acts on; with them a symmetry support names the axis it holds.
 */
export function structuralSupportDescription(support: Pick<Constraint, "type" | "parameters">, faces: ReadonlyArray<Pick<DisplayFace, "label" | "normal" | "surfaceType">> = [], unitSystem: UnitSystem = "SI"): string | undefined {
  if (support.type === "elastic_support") {
    const stiffness = elasticSupportStiffness(support);
    const unit = foundationModulusDisplayUnit(unitSystem).label;
    const show = (value: number) => `${formatDisplayNumber(foundationModulusForDisplay(value, unitSystem))}\u00a0${unit}`;
    return `Elastic support (normal ${show(stiffness.normal)}, tangential ${show(stiffness.tangential)})`;
  }
  if (support.type === "fixed") {
    const components = fixedSupportComponents(support);
    if (components.length === SUPPORT_COMPONENTS.length) return "Fixed support (X, Y, Z)";
    const free = SUPPORT_COMPONENTS.filter((component) => !components.includes(component));
    return `Fixed support (${formatSupportComponents(components)}; ${formatSupportComponents(free)} free)`;
  }
  if (support.type === "symmetry") {
    const check = symmetryCheckForFaces(faces);
    return check?.ok ? `Symmetry / roller (holds ${check.component.toUpperCase()}, the face normal)` : "Symmetry / roller (holds the face normal)";
  }
  return undefined;
}

function formatDegrees(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}
