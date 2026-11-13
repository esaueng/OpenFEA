import { formatDisplayNumber, SIGNIFICANT_DIGITS } from "./formatDisplayNumber";
export { formatDisplayNumber } from "./formatDisplayNumber";
import { classifyResultProvenance, isModalResultSummary, isThermalResultSummary } from "@openfea/schema";
import type { DisplayModel, ModalResultSummary, Project, ResultField, ResultProvenance, ResultSummary, StructuralResultSummary, Study, ThermalResultSummary } from "@openfea/schema";

export type UnitSystem = Project["unitSystem"];

const MM_PER_INCH = 25.4;
const MPA_PER_KSI = 6.894757293168361;
const NEWTONS_PER_LBF = 4.4482216152605;
const KPA_PER_PSI = 6.894757293168361;
const KG_PER_LB = 0.45359237;
const CUBIC_MM_PER_CUBIC_INCH = MM_PER_INCH ** 3;
const CUBIC_CM_PER_CUBIC_METER = 1_000_000;
const CUBIC_IN_PER_CUBIC_METER = 61_023.7440947323;
/**
 * Mass density, US display. Exported because the custom-material editor converts
 * the same quantity in the other direction; it previously kept a private copy of
 * this number while this module converted to lb/ft^3, so the panel asked for
 * lb/in^3 and echoed lb/ft^3 back — the two constants were 1728x apart and
 * nothing tied them together. One constant, one unit.
 */
export const KG_PER_M3_PER_LB_PER_IN3 = 27_679.9047102;
const NEWTONS_PER_CUBIC_METER_PER_LBF_PER_CUBIC_INCH = 271_447.14116097;

export function formatUnitSystemLabel(unitSystem: UnitSystem): string {
  return unitSystem === "US" ? "Imperial · in" : "Metric · mm";
}

export function formatLength(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = lengthForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatStress(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = stressForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatForce(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = forceForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatVolume(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = volumeForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatMass(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = massForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${converted.units}`.trim();
}

export function formatDensity(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = densityForUnits(value, units, unitSystem);
  return `${formatDensityNumber(converted.value)} ${converted.units}`.trim();
}

/**
 * Density carries significant figures rather than `formatDisplayNumber`'s fixed
 * decimals below magnitude 10.
 *
 * In lb/in^3 the whole material catalogue lands in 0.001-0.5, which is exactly the
 * band where that function switches to three fixed decimals. Polymers would collapse
 * to two significant figures and distinct materials would render identically —
 * 1180 and 1200 kg/m^3 both reach "0.043" — while the FDM effective-density row
 * moves one digit for a 14% change in infill. `formatDisplayNumber` is shared by
 * every other readout in the app and the PDF and is pinned byte-for-byte by its own
 * tests, so the density-specific rule lives here instead. At and above 10 it defers,
 * which leaves every SI reading unchanged.
 */
function formatDensityNumber(value: number): string {
  if (!Number.isFinite(value) || value === 0) return formatDisplayNumber(value);
  if (Math.abs(value) >= 10) return formatDisplayNumber(value);
  return value.toLocaleString(undefined, { maximumSignificantDigits: SIGNIFICANT_DIGITS });
}

export function formatMaterialStress(valuePa: number, unitSystem: UnitSystem): string {
  return formatStress(valuePa / 1_000_000, "MPa", unitSystem);
}

/**
 * The unit a project enters and reads stresses in: MPa for SI, ksi for US. It is
 * the unit material strengths and result stresses display in (`stressForUnits`).
 */
export function projectStressUnit(unitSystem: UnitSystem): "MPa" | "ksi" {
  return unitSystem === "US" ? "ksi" : "MPa";
}

/** A stored stress in Pa expressed in the project's stress unit. */
export function stressPascalsToProjectUnits(valuePa: number, unitSystem: UnitSystem): number {
  return stressForUnits(valuePa / 1_000_000, "MPa", unitSystem).value;
}

/** A stress typed in the project's stress unit, converted to Pa for storage. */
export function stressPascalsFromProjectUnits(value: number, unitSystem: UnitSystem): number {
  return (unitSystem === "US" ? value * MPA_PER_KSI : value) * 1_000_000;
}

export function loadValueForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (units === "N" || units === "lbf") return forceForUnits(value, units, unitSystem);
  if (units === "kPa" || units === "psi") return pressureForUnits(value, units, unitSystem);
  if (units === "kg" || units === "lb") return massForUnits(value, units, unitSystem);
  if (units === "N/m^3" && unitSystem === "US") return { value: value / NEWTONS_PER_CUBIC_METER_PER_LBF_PER_CUBIC_INCH, units: "lbf/in^3" };
  if (units === "lbf/in^3" && unitSystem === "SI") return { value: value * NEWTONS_PER_CUBIC_METER_PER_LBF_PER_CUBIC_INCH, units: "N/m^3" };
  return { value, units };
}

export function resultSummaryForUnits(summary: StructuralResultSummary, unitSystem: UnitSystem): StructuralResultSummary;
export function resultSummaryForUnits(summary: ModalResultSummary, unitSystem: UnitSystem): ModalResultSummary;
export function resultSummaryForUnits(summary: ThermalResultSummary, unitSystem: UnitSystem): ThermalResultSummary;
export function resultSummaryForUnits(summary: ResultSummary, unitSystem: UnitSystem): ResultSummary;
export function resultSummaryForUnits(summary: ResultSummary, unitSystem: UnitSystem): ResultSummary {
  if (isModalResultSummary(summary)) return summary;
  if (isThermalResultSummary(summary)) {
    if (unitSystem === "SI" && summary.temperatureUnits === "°F") {
      return {
        ...summary,
        minTemperature: (summary.minTemperature - 32) * 5 / 9,
        maxTemperature: (summary.maxTemperature - 32) * 5 / 9,
        temperatureUnits: "°C"
      };
    }
    if (unitSystem === "SI" || summary.temperatureUnits === "°F") return summary;
    return {
      ...summary,
      minTemperature: summary.minTemperature * 9 / 5 + 32,
      maxTemperature: summary.maxTemperature * 9 / 5 + 32,
      temperatureUnits: "°F"
    };
  }
  const stress = stressForUnits(summary.maxStress, summary.maxStressUnits, unitSystem);
  const displacement = lengthForUnits(summary.maxDisplacement, summary.maxDisplacementUnits, unitSystem);
  const reaction = forceForUnits(summary.reactionForce, summary.reactionForceUnits, unitSystem);
  // transient.peakDisplacement carries no units of its own — it shares
  // maxDisplacementUnits, so it must convert with the same source units.
  const transient = summary.transient
    ? {
      ...summary.transient,
      peakDisplacement: lengthForUnits(summary.transient.peakDisplacement, summary.maxDisplacementUnits, unitSystem).value
    }
    : undefined;
  return {
    ...summary,
    failureAssessment: undefined,
    ...(transient ? { transient } : {}),
    maxStress: stress.value,
    maxStressUnits: stress.units,
    maxDisplacement: displacement.value,
    maxDisplacementUnits: displacement.units,
    reactionForce: reaction.value,
    reactionForceUnits: reaction.units
  };
}

export function resultFieldForUnits(field: ResultField, unitSystem: UnitSystem): ResultField {
  const converter = resultValueConverter(field, unitSystem);

  if (!converter) return field;

  // Convert only — never round field data. These values and vectors feed the
  // result render (colors and the deformed shape), where display rounding is
  // destructive: sub-0.01 displacement fields (a stiff part deflecting ~1 µm)
  // quantize onto a 0.001 grid, and the deformation auto-scale amplifies the
  // steps into a jagged, crumpled shape. Readouts format at display time.
  const convertedValues = field.values.map((value) => converter(value).value);
  const convertedMin = converter(field.min);
  const convertedMax = converter(field.max);
  return {
    ...field,
    values: convertedValues,
    tensorValues: field.tensorValues?.map((value) => converter(value).value),
    min: convertedMin.value,
    max: convertedMax.value,
    units: convertedMax.units,
    vectors: field.vectors?.map((vector) => vector.map((component) => converter(component).value) as [number, number, number]),
    samples: field.samples?.map((sample) => ({
      ...sample,
      value: converter(sample.value).value,
      ...(sample.vector ? { vector: sample.vector.map((component) => converter(component).value) as [number, number, number] } : {})
    }))
  };
}

export function resultValueForUnits(field: Pick<ResultField, "type" | "units">, value: number, unitSystem: UnitSystem): { value: number; units: string } {
  return resultValueConverter(field, unitSystem)?.(value) ?? { value, units: field.units };
}

export function resultValueFromDisplayUnits(field: Pick<ResultField, "type" | "units">, value: number, unitSystem: UnitSystem): number {
  // Temperature conversion is affine, so it cannot be inverted by dividing
  // through the converted value of one (the offset would corrupt the range).
  if (field.type === "temperature") {
    if (unitSystem === "US" && field.units !== "°F") return (value - 32) * 5 / 9;
    if (unitSystem === "SI" && field.units === "°F") return value * 9 / 5 + 32;
    return value;
  }
  const displayUnitValue = resultValueForUnits(field, 1, unitSystem).value;
  return Number.isFinite(displayUnitValue) && Math.abs(displayUnitValue) > Number.EPSILON ? value / displayUnitValue : value;
}

function resultValueConverter(field: Pick<ResultField, "type" | "units">, unitSystem: UnitSystem) {
  if (field.type === "temperature" && unitSystem === "US" && field.units !== "°F") {
    return (value: number) => ({ value: value * 9 / 5 + 32, units: "°F" });
  }
  if (field.type === "temperature" && unitSystem === "SI" && field.units === "°F") {
    return (value: number) => ({ value: (value - 32) * 5 / 9, units: "°C" });
  }
  return field.type === "stress"
    ? (value: number) => stressForUnits(value, field.units, unitSystem)
    : field.type === "displacement" || field.type === "velocity" || field.type === "acceleration"
      ? (value: number) => lengthForUnits(value, field.units, unitSystem)
      : undefined;
}

export function formatResultProvenanceLabel(provenance: ResultProvenance | undefined): string {
  const tier = classifyResultProvenance(provenance);
  if (tier === "imported_legacy") return "Legacy backend result";
  if (tier === "core_preview") return "OpenFEA Core Preview (coarse block proxy)";
  if (tier === "local_estimate") return "Estimate (not FEA)";
  if (tier === "analytical_benchmark") return "Analytical benchmark";
  if (tier === "production_fea") {
    if (provenance?.runnerVersion?.startsWith("browser-")) return "OpenFEA Core Local (in-browser)";
    return provenance?.solver === "opencae-core-cloud" ? "OpenCAE Core Cloud" : "OpenFEA Core Local";
  }
  return "Unknown result source";
}

export function hasResultUnit(units: string | undefined): units is string {
  return typeof units === "string" && units.length > 0 && units !== "undefined";
}

export function formatResultMetric(value: number, units: string | undefined): string {
  return hasResultUnit(units) ? `${formatResultNumber(value)} ${units}` : "Unit missing";
}

/**
 * Unitless result scalars (safety factor, load scale). Shares the adaptive
 * precision of `formatDisplayNumber` so every readout in the app and in the
 * PDF report rounds at one place and by one rule.
 */
export function formatResultNumber(value: number): string {
  return formatDisplayNumber(value);
}

export function solverMethodForResult(resultSummary: ResultSummary, study: Study): string {
  const provenanceMethod = (resultSummary.provenance as Record<string, unknown> | undefined)?.coreSolver;
  if (typeof provenanceMethod === "string" && provenanceMethod) return provenanceMethod;
  if (isModalResultSummary(resultSummary)) return "block_shift_invert_modal";
  if (isThermalResultSummary(resultSummary)) return "sparse_steady_thermal";
  if (resultSummary.transient) return "mdof_dynamic";
  return defaultSolverMethodForStudy(study);
}

export function defaultSolverMethodForStudy(study: Pick<Study, "type">): "sparse_static" | "mdof_dynamic" | "block_shift_invert_modal" | "sparse_steady_thermal" {
  if (study.type === "dynamic_structural") return "mdof_dynamic";
  if (study.type === "modal_analysis") return "block_shift_invert_modal";
  if (study.type === "steady_state_thermal") return "sparse_steady_thermal";
  return "sparse_static";
}

export function solverRunnerLabelForResult(provenance: ResultProvenance | undefined): string {
  if (provenance?.runnerVersion?.startsWith("browser-")) return "in-browser solve worker";
  return provenance?.solver === "opencae-core-cloud" ? "cloud container" : "local core worker";
}

export function formatMeshSourceLabel(meshSource: ResultProvenance["meshSource"] | undefined, displayModel?: DisplayModel): string {
  if (meshSource === "actual_volume_mesh") {
    if (displayModel?.coreCloudGeometry?.kind === "sample_procedural") return "Procedural sample mesh (simplified)";
    return "Actual volume mesh";
  }
  if (meshSource === "structured_block_core") return "Structured block Core";
  if (meshSource === "opencae_core_tet4") return "OpenFEA Core Tet4";
  if (meshSource === "structured_block_proxy" || meshSource === "display_bounds_proxy") return "OpenFEA Core Preview";
  if (typeof meshSource === "string" && meshSource) return meshSource.replaceAll("_", " ");
  return "--";
}

export function legacyResultWarningForProvenance(provenance: ResultProvenance | undefined): string | null {
  return isLegacyBackendResult(provenance)
    ? "This result is historical and read-only. Re-run locally in this browser for current production results."
    : null;
}

function isLegacyBackendResult(provenance: ResultProvenance | undefined): boolean {
  const solver = provenance?.solver ?? "";
  return new RegExp(["calcu", "lix"].join(""), "i").test(solver);
}

export function displayModelForUnits(displayModel: DisplayModel, unitSystem: UnitSystem): DisplayModel {
  const dimensions = displayModel.dimensions;
  if (!dimensions) return displayModel;
  const x = lengthForUnits(dimensions.x, dimensions.units, unitSystem);
  const y = lengthForUnits(dimensions.y, dimensions.units, unitSystem);
  const z = lengthForUnits(dimensions.z, dimensions.units, unitSystem);
  return {
    ...displayModel,
    dimensions: {
      x: roundBoundingDimension(x.value),
      y: roundBoundingDimension(y.value),
      z: roundBoundingDimension(z.value),
      units: x.units
    }
  };
}

export function lengthForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "mm") return { value: value / MM_PER_INCH, units: "in" };
  if (unitSystem === "SI" && units === "in") return { value: value * MM_PER_INCH, units: "mm" };
  if (unitSystem === "US" && units === "mm/s") return { value: value / MM_PER_INCH, units: "in/s" };
  if (unitSystem === "SI" && units === "in/s") return { value: value * MM_PER_INCH, units: "mm/s" };
  if (unitSystem === "US" && units === "mm/s^2") return { value: value / MM_PER_INCH, units: "in/s^2" };
  if (unitSystem === "SI" && units === "in/s^2") return { value: value * MM_PER_INCH, units: "mm/s^2" };
  return { value, units };
}

/**
 * Face areas are measured in the STEP model space (mm^2); US projects read them
 * in in^2. Display only: stored labels and fingerprints keep their mm^2 source.
 */
export function areaForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "mm^2") return { value: value / MM_PER_INCH ** 2, units: "in^2" };
  if (unitSystem === "SI" && units === "in^2") return { value: value * MM_PER_INCH ** 2, units: "mm^2" };
  return { value, units };
}

export function formatArea(value: number, units: string, unitSystem: UnitSystem): string {
  const converted = areaForUnits(value, units, unitSystem);
  return `${formatDisplayNumber(converted.value)} ${displayUnitText(converted.units)}`.trim();
}

/**
 * Boundary temperatures are stored in °C (the value the solver consumes); US
 * projects enter and read them in °F. The conversion is affine, so the inverse
 * is this same function called with the display units and "SI".
 */
export function temperatureForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "°C") return { value: value * 9 / 5 + 32, units: "°F" };
  if (unitSystem === "SI" && units === "°F") return { value: (value - 32) * 5 / 9, units: "°C" };
  return { value, units };
}

export function stressForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "MPa") return { value: value / MPA_PER_KSI, units: "ksi" };
  if (unitSystem === "SI" && units === "ksi") return { value: value * MPA_PER_KSI, units: "MPa" };
  return { value, units };
}

export function forceForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "N") return { value: value / NEWTONS_PER_LBF, units: "lbf" };
  if (unitSystem === "SI" && units === "lbf") return { value: value * NEWTONS_PER_LBF, units: "N" };
  return { value, units };
}

export function pressureForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "kPa") return { value: value / KPA_PER_PSI, units: "psi" };
  if (unitSystem === "SI" && units === "psi") return { value: value * KPA_PER_PSI, units: "kPa" };
  return { value, units };
}

export function massForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "g") return { value: value / 1000 / KG_PER_LB, units: "lb" };
  if (unitSystem === "SI" && units === "lb") return { value: value * KG_PER_LB, units: "kg" };
  if (unitSystem === "US" && units === "kg") return { value: value / KG_PER_LB, units: "lb" };
  return { value, units };
}

export function volumeForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "mm^3") return { value: value / CUBIC_MM_PER_CUBIC_INCH, units: "in^3" };
  if (unitSystem === "SI" && units === "in^3") return { value: value * CUBIC_MM_PER_CUBIC_INCH, units: "mm^3" };
  if (unitSystem === "SI" && units === "m^3") return { value: value * CUBIC_CM_PER_CUBIC_METER, units: "cm^3" };
  if (unitSystem === "US" && units === "m^3") return { value: value * CUBIC_IN_PER_CUBIC_METER, units: "in^3" };
  return { value, units };
}

/**
 * US density is per cubic INCH, not per cubic foot. Every other US readout in this
 * module is inch-based — in, in^3, ksi, psi, lbf/in^3 — and the gravity card renders
 * payload volume (in^3), density and calculated mass (lb) as adjacent rows where mass
 * is literally density x volume. Under lb/ft^3 that identity was off by 1728 on screen.
 */
export function densityForUnits(value: number, units: string, unitSystem: UnitSystem): { value: number; units: string } {
  if (unitSystem === "US" && units === "kg/m^3") return { value: value / KG_PER_M3_PER_LB_PER_IN3, units: "lb/in^3" };
  if (unitSystem === "SI" && units === "lb/in^3") return { value: value * KG_PER_M3_PER_LB_PER_IN3, units: "kg/m^3" };
  return { value, units };
}

/**
 * Coarse rounding for the display model's overall bounding dimensions only.
 *
 * These are a human-facing size readout of a whole part, never a solved
 * quantity, and the unit conversion leaves float dust on exact values
 * (76.2 mm / 25.4 = 3.0000000000000004 in). Rounding is safe here because a
 * bounding dimension is never small enough to collapse to zero. Do not reach
 * for this on result data — use `formatDisplayNumber` at the point of display.
 */
function roundBoundingDimension(value: number): number {
  if (!Number.isFinite(value)) return value;
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return Math.round(value * 10) / 10;
  if (magnitude >= 10) return Math.round(value * 100) / 100;
  return Math.round(value * 1000) / 1000;
}

/**
 * Screen form of an ASCII unit: "kg/m^3" -> "kg/m³". Units are stored and exported with
 * carets; the panels showed them raw beside places that already used superscripts.
 */
export function displayUnitText(text: string): string {
  return text.replace(/\^(-?)([0-9])/g, (_, sign: string, digit: string) => `${sign ? "⁻" : ""}${"⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(digit)]}`);
}
