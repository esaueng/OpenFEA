import { isStructuralResultSummary } from "@openfea/schema";
import type { CustomMaterial, DisplayModel, Material, ResultField, ResultSummary, SafetyFactorBasis, SafetyFactorStrength, Study } from "@openfea/schema";
import { effectiveMaterialProperties, resolveMaterial } from "@openfea/materials";
import { inferGlobalCriticalPrintAxis } from "@openfea/study-core";
import { pressureToPascals } from "@openfea/units";
import { SAFETY_FACTOR_DISPLAY_CAP, SAFETY_FACTOR_DISPLAY_FLOOR } from "./resultFields";
import { formatMaterialStress, type UnitSystem } from "./unitDisplay";

/*
 * Safety-factor basis (plan 036 R3.4).
 *
 * The solver computes one safety factor, yield strength over element-peak von
 * Mises stress, and stores it as an element field, a solver-surface node field
 * and the summary minimum. Each is strength / stress with the same stress, so a
 * different strength S re-bases it exactly by the constant S / yield. Changing
 * the basis therefore re-scales the stored result for display, report and
 * export and never re-solves; the stored result stays on the yield basis.
 *
 * The constant is only one number when the model has one material strength.
 * Bodies with different materials (or different process settings) would need
 * per-element strengths, which results do not keep, so the non-yield bases are
 * offered only for a single effective material.
 */

export const DEFAULT_SAFETY_FACTOR_BASIS: SafetyFactorBasis = Object.freeze({ strength: "yield" });

export interface SafetyFactorBasisOption {
  strength: SafetyFactorStrength;
  label: string;
  available: boolean;
  /** Why the option is disabled; absent when available. */
  reason?: string;
}

export interface ResolvedSafetyFactorBasis {
  /** The basis the study stores (yield when it stores none). */
  stored: SafetyFactorBasis;
  /** The basis applied to results; yield when the stored one is unavailable. */
  strength: SafetyFactorStrength;
  /** Multiplier from the solver's yield-basis safety factor to the applied basis. */
  factor: number;
  /** Applied strength in Pa, for reconstructing display-clamped nodal ratios from stress. */
  strengthPascals?: number;
  /** Short qualifier for labels: "yield, von Mises". */
  shortLabel: string;
  /** One sentence for the report and exports: "Yield strength over von Mises stress". */
  description: string;
  /** What falling below SF = 1 means on this basis, completing "below it ...". */
  limitNote: string;
  /** The allowable stress in Pa, when the applied basis is allowable. */
  allowableStress?: number;
  options: SafetyFactorBasisOption[];
  /** Set when the stored basis cannot be applied and yield is shown instead. */
  fallbackReason?: string;
}

export function isStructuralStudy(study: Study | null | undefined): study is Extract<Study, { type: "static_stress" | "dynamic_structural" }> {
  return study?.type === "static_stress" || study?.type === "dynamic_structural";
}

/** The study's stored basis; every project saved before R3.4 reads as yield. */
export function storedSafetyFactorBasis(study: Study | null | undefined): SafetyFactorBasis {
  return isStructuralStudy(study) && study.safetyFactorBasis ? study.safetyFactorBasis : DEFAULT_SAFETY_FACTOR_BASIS;
}

type AssignedStrength = { material: Material; effective: Material };

/**
 * The single effective material of the study, as the solver received it
 * (homogenized additive knockdown included), or why there is not exactly one.
 */
function singleAssignedMaterial(
  study: Study,
  customMaterials: readonly CustomMaterial[],
  displayModel: DisplayModel | null | undefined
): AssignedStrength | { reason: string } {
  const assignments = study.materialAssignments;
  if (!assignments.length) return { reason: "Assign a material first." };
  const distinct = new Set(assignments.map((assignment) => JSON.stringify([
    assignment.materialId,
    Object.entries(assignment.parameters ?? {}).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))
  ])));
  if (distinct.size > 1) {
    return { reason: "The bodies have different materials or process settings. Re-basing the safety factor needs one material strength for the whole model." };
  }
  const assignment = assignments[0]!;
  let material: Material;
  try {
    material = resolveMaterial(assignment.materialId, customMaterials);
  } catch {
    return { reason: "The assigned material is not in this project." };
  }
  const criticalLayerAxis = displayModel
    ? inferGlobalCriticalPrintAxis(study, displayModel.faces.map((face) => ({
        entityId: face.id,
        center: face.center,
        ...(face.area ? { areaM2: face.area * 1e-6 } : {})
      })), displayModel)
    : undefined;
  return { material, effective: effectiveMaterialProperties(material, assignment.parameters ?? {}, { criticalLayerAxis }) };
}

export function resolveSafetyFactorBasis(input: {
  study: Study | null | undefined;
  customMaterials?: readonly CustomMaterial[];
  displayModel?: DisplayModel | null;
  unitSystem: UnitSystem;
}): ResolvedSafetyFactorBasis {
  const stored = storedSafetyFactorBasis(input.study);
  const single = input.study ? singleAssignedMaterial(input.study, input.customMaterials ?? [], input.displayModel) : { reason: "No study." };
  const ultimate = ultimateOption(single);
  const allowable: SafetyFactorBasisOption = "reason" in single
    ? { strength: "allowable", label: "Allowable stress", available: false, reason: single.reason }
    : { strength: "allowable", label: "Allowable stress", available: true };
  const options: SafetyFactorBasisOption[] = [
    { strength: "yield", label: "Yield strength", available: true },
    ultimate,
    allowable
  ];
  const yieldBasis = yieldResolution(stored, options);
  if (stored.strength === "yield" || "reason" in single) {
    const unavailable = options.find((option) => option.strength === stored.strength && !option.available);
    return unavailable ? { ...yieldBasis, fallbackReason: fallbackReason(unavailable) } : yieldBasis;
  }
  const yieldStrength = single.effective.yieldStrength;
  if (stored.strength === "ultimate") {
    if (!ultimate.available) return { ...yieldBasis, fallbackReason: fallbackReason(ultimate) };
    const ultimateStrength = single.effective.ultimateStrength!;
    return {
      stored,
      strength: "ultimate",
      factor: ultimateStrength / yieldStrength,
      strengthPascals: ultimateStrength,
      shortLabel: "ultimate, von Mises",
      description: `Ultimate strength (${formatMaterialStress(ultimateStrength, input.unitSystem)}) over von Mises stress`,
      limitNote: "below it the stress exceeds the ultimate strength",
      options
    };
  }
  const allowableStress = stored.allowableStress;
  if (!(typeof allowableStress === "number" && Number.isFinite(allowableStress) && allowableStress > 0)) {
    return { ...yieldBasis, fallbackReason: "The allowable stress is not set. Showing the yield basis." };
  }
  const allowableText = formatMaterialStress(allowableStress, input.unitSystem);
  return {
    stored,
    strength: "allowable",
    factor: allowableStress / yieldStrength,
    strengthPascals: allowableStress,
    shortLabel: `allowable ${allowableText}, von Mises`,
    description: `Allowable stress (${allowableText}) over von Mises stress`,
    limitNote: "below it the stress exceeds the allowable",
    allowableStress,
    options
  };
}

/** The solver's own basis, for callers that hold no study (tests, embeddings). */
export const YIELD_SAFETY_FACTOR_BASIS: ResolvedSafetyFactorBasis = Object.freeze(
  yieldResolution(DEFAULT_SAFETY_FACTOR_BASIS, [{ strength: "yield", label: "Yield strength", available: true }])
);

function yieldResolution(stored: SafetyFactorBasis, options: SafetyFactorBasisOption[]): ResolvedSafetyFactorBasis {
  return {
    stored,
    strength: "yield",
    factor: 1,
    shortLabel: "yield, von Mises",
    description: "Yield strength over von Mises stress",
    limitNote: "below it the part yields",
    options
  };
}

function ultimateOption(single: AssignedStrength | { reason: string }): SafetyFactorBasisOption {
  const base = { strength: "ultimate" as const, label: "Ultimate strength" };
  if ("reason" in single) return { ...base, available: false, reason: single.reason };
  const { material, effective } = single;
  const ultimateStrength = effective.ultimateStrength;
  if (!(typeof ultimateStrength === "number" && Number.isFinite(ultimateStrength) && ultimateStrength > 0)) {
    return {
      ...base,
      available: false,
      reason: `${material.name} has no ultimate strength on file. Built-in materials list yield strength only; duplicate the material as a custom material and enter its ultimate strength.`
    };
  }
  if (ultimateStrength < effective.yieldStrength) {
    return { ...base, available: false, reason: `${material.name} lists an ultimate strength below its yield strength. Correct the custom material.` };
  }
  return { ...base, available: true };
}

function fallbackReason(option: SafetyFactorBasisOption): string {
  return `${option.label} basis is unavailable: ${option.reason ?? "no strength on file."} Showing the yield basis.`;
}

/** What a safety factor below 1 exceeds on each basis, for sentences. */
export function safetyFactorLimitPhrase(strength: SafetyFactorStrength): string {
  if (strength === "ultimate") return "the material ultimate strength";
  return strength === "allowable" ? "the allowable stress" : "the material yield limit";
}

/** "Min safety factor (yield, von Mises)". */
export function safetyFactorLabelWithBasis(label: string, basis: Pick<ResolvedSafetyFactorBasis, "shortLabel">): string {
  return `${label} (${basis.shortLabel})`;
}

/**
 * Re-bases a structural summary's minimum safety factor. Non-positive values
 * mean "no safety factor" (no stress or no strength) and stay as they are. The
 * stored verdict was computed on the yield basis, so it is dropped; callers
 * assess the re-based summary with `assessResultFailure(summary, basis.strength)`.
 */
export function rebaseSafetyFactorSummary<T extends ResultSummary>(summary: T, factor: number): T {
  if (factor === 1 || !isStructuralResultSummary(summary) || !isUsableFactor(factor)) return summary;
  const safetyFactor = Number(summary.safetyFactor);
  return {
    ...summary,
    safetyFactor: Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor * factor : summary.safetyFactor,
    failureAssessment: undefined
  };
}

/**
 * Re-bases every safety-factor field. Element fields keep 0 as "undefined";
 * node fields are reconstructed from the matching von Mises stress when the
 * applied strength is known. A display-clamped ratio cannot be scaled exactly:
 * a capped yield ratio may fall below one on a much lower allowable basis.
 * Older fields without matching stress use a conservative scaled lower bound.
 */
export function rebaseSafetyFactorFields(fields: ResultField[], factor: number, strengthPascals?: number): ResultField[] {
  if (factor === 1 || !isUsableFactor(factor) || !fields.some((field) => field.type === "safety_factor")) return fields;
  return fields.map((field) => {
    if (field.type !== "safety_factor") return field;
    const clamped = field.location === "node";
    const stress = clamped && field.surfaceMeshRef && strengthPascals !== undefined && isUsableFactor(strengthPascals)
      ? fields.find((candidate) => candidate.type === "stress" && (candidate.component ?? "von_mises") === "von_mises"
        && candidate.location === "node" && candidate.surfaceMeshRef === field.surfaceMeshRef
        && candidate.runId === field.runId && candidate.variantId === field.variantId
        && candidate.frameIndex === field.frameIndex && candidate.values.length === field.values.length)
      : undefined;
    const scale = (value: number) => rebaseValue(value, factor, clamped);
    const values = field.values.map((value, index) => {
      const stressPascals = stress ? pressureToPascals(Math.abs(stress.values[index]!), stress.units) : undefined;
      if (stressPascals === undefined || !Number.isFinite(stressPascals)) return scale(value);
      return stressPascals > 0
        ? Math.min(SAFETY_FACTOR_DISPLAY_CAP, Math.max(SAFETY_FACTOR_DISPLAY_FLOOR, strengthPascals! / stressPascals))
        : SAFETY_FACTOR_DISPLAY_CAP;
    });
    const extent = finiteExtent(values);
    return {
      ...field,
      values,
      ...(extent ? { min: extent.min, max: extent.max } : {}),
      ...(field.samples ? { samples: field.samples.map((sample) => ({ ...sample, value: scale(sample.value) })) } : {})
    };
  });
}

export function rebaseSafetyFactorResults(summary: ResultSummary, fields: ResultField[], factor: number, strengthPascals?: number): { summary: ResultSummary; fields: ResultField[] } {
  return { summary: rebaseSafetyFactorSummary(summary, factor), fields: rebaseSafetyFactorFields(fields, factor, strengthPascals) };
}

function rebaseValue(value: number, factor: number, clamped: boolean): number {
  if (!Number.isFinite(value) || value <= 0) return value;
  if (!clamped) return value * factor;
  // A capped ratio is a lower bound. Scale that bound so a lower allowable
  // cannot leave the old cap looking safe. A floored ratio stays conservative.
  if (value <= SAFETY_FACTOR_DISPLAY_FLOOR) return SAFETY_FACTOR_DISPLAY_FLOOR;
  return Math.min(SAFETY_FACTOR_DISPLAY_CAP, Math.max(SAFETY_FACTOR_DISPLAY_FLOOR, value * factor));
}

function isUsableFactor(factor: number): boolean {
  return Number.isFinite(factor) && factor > 0;
}

function finiteExtent(values: readonly number[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}
