import type { ResultField, StressComponent } from "@openfea/schema";
import type { ResultMode } from "./workspaceViewTypes";

export type ResultColorBands = "continuous" | "bands8";
export type ResultRangeMode = "auto" | "manual";

export interface ResultColorScaleSetting {
  rangeMode: ResultRangeMode;
  bands: ResultColorBands;
  manualMin?: number;
  manualMax?: number;
}

export type ResultColorScaleSettings = Record<string, ResultColorScaleSetting>;

export interface ResolvedResultColorScale {
  type: ResultMode;
  component?: StressComponent;
  min: number;
  max: number;
  bands: ResultColorBands;
}

/* The one definition of the stress ramp. It was hand-copied into four places in three
   different formats — here, the report theme, the offline viewer's normalized float
   triples, and tokens.css — so a change to any one of them would have silently split what
   a colour means between the screen, the PDF and the exported viewer. The three TypeScript
   consumers import this; tokens.css cannot, so appCss.test.ts pins it against this list. */
export const STRESS_RAMP = ["#0759d6", "#0ea5e9", "#22c55e", "#facc15", "#f97316", "#ef4444"];

/** The same stops as normalized 0-1 RGB triples, for WebGL consumers. */
export function stressRampFloatStops(): number[][] {
  return rampFloatStops(STRESS_RAMP);
}

/** The sequential ramp a result type is drawn with, as normalized 0-1 RGB triples, so the
 *  exported offline viewer colours each field type exactly as the workspace does. */
export function resultRampFloatStops(type: ResultMode): number[][] {
  return rampFloatStops(sequentialRamp(type));
}

function rampFloatStops(ramp: readonly string[]): number[][] {
  return ramp.map((hex) => [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255
  ].map((channel) => Number(channel.toFixed(3))));
}
const MOTION_RAMP = ["#0759d6", "#0ea5e9", "#10b8f0", "#2ee875", "#f2e94e", "#ff8f1f", "#ef4444"];
/** The factor of safety at which the material yields; the legend marks it. */
export const SAFETY_FACTOR_LIMIT = 1;
/** Below this the design margin is thin: the caution band runs from the limit to here. */
export const SAFETY_FACTOR_CAUTION = 2;
/** The top of the fixed safety-factor scale; larger factors clamp to the safe end. */
export const SAFETY_FACTOR_SCALE_MAX = 3;
/* Factor of safety is read against fixed thresholds, not against its own range. Coloured
   relative to the field's min..max, a part whose every factor was >= 158 rendered solid
   red beside an "Unlikely to yield" verdict. Three absolute bands with hard edges at
   SF = 1 and SF = 2: red (yields), orange-yellow (caution), blue (safe). The old ramp
   also ran red -> green, which collapses to one olive band for deuteranopes and
   protanopes (~8% of men); these are ColorBrewer RdYlBu stops, colour-blind safe. */
export const SAFETY_FACTOR_BANDS: ReadonlyArray<{ from: number; to: number; colors: readonly [string, string]; label: string }> = [
  { from: 0, to: SAFETY_FACTOR_LIMIT, colors: ["#a50026", "#d73027"], label: "Yields" },
  { from: SAFETY_FACTOR_LIMIT, to: SAFETY_FACTOR_CAUTION, colors: ["#fdae61", "#fee090"], label: "Caution" },
  { from: SAFETY_FACTOR_CAUTION, to: SAFETY_FACTOR_SCALE_MAX, colors: ["#91bfdb", "#4575b4"], label: "Safe" }
];
/** The bands' stops in order, for consumers that need a flat list (tests, swatches). */
export const SAFETY_RAMP = SAFETY_FACTOR_BANDS.flatMap((band) => [...band.colors]);
const DIVERGING_NEGATIVE = "#2563eb";
const DIVERGING_NEUTRAL = "#f5f5f4";
const DIVERGING_POSITIVE = "#dc2626";
const BAND_COUNT = 8;

export const DEFAULT_RESULT_COLOR_SCALE_SETTING: ResultColorScaleSetting = Object.freeze({
  rangeMode: "auto",
  bands: "continuous"
});

export function isDivergingStressComponent(component: StressComponent | undefined): boolean {
  return component === "principal_max" || component === "principal_min";
}

export function resultScaleRangeEpsilon(min: number, max: number): number {
  return Math.max(1, Math.abs(min), Math.abs(max)) * 1e-12;
}

export function validManualResultRange(min: number | undefined, max: number | undefined): min is number {
  return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && max - min > resultScaleRangeEpsilon(min, max);
}

export function automaticResultFieldRange(fields: ResultField[], semanticKey: (field: ResultField) => string, activeField: ResultField): { min: number; max: number } {
  const activeKey = semanticKey(activeField);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const field of fields) {
    if (semanticKey(field) !== activeKey) continue;
    if (Number.isFinite(field.min)) min = Math.min(min, field.min);
    if (Number.isFinite(field.max)) max = Math.max(max, field.max);
  }
  if (Number.isFinite(min) && Number.isFinite(max) && max - min > resultScaleRangeEpsilon(min, max)) return { min, max };
  const fallbackMin = Number.isFinite(activeField.min) ? activeField.min : 0;
  const fallbackMax = Number.isFinite(activeField.max) ? activeField.max : fallbackMin + 1;
  return fallbackMax - fallbackMin > resultScaleRangeEpsilon(fallbackMin, fallbackMax)
    ? { min: fallbackMin, max: fallbackMax }
    : { min: fallbackMin, max: fallbackMin + Math.max(1, Math.abs(fallbackMin)) * 1e-6 };
}

export function resolveResultColorScale({
  type,
  component,
  automaticRange,
  setting = DEFAULT_RESULT_COLOR_SCALE_SETTING
}: {
  type: ResultMode;
  component?: StressComponent;
  automaticRange: { min: number; max: number };
  setting?: ResultColorScaleSetting;
}): ResolvedResultColorScale {
  const manual = setting.rangeMode === "manual" && validManualResultRange(setting.manualMin, setting.manualMax);
  // Safety factor's automatic range is the fixed absolute scale, never the field's extent.
  const automatic = type === "safety_factor" ? SAFETY_FACTOR_FIXED_RANGE : automaticRange;
  return {
    type,
    ...(component ? { component } : {}),
    min: manual ? setting.manualMin! : automatic.min,
    max: manual ? setting.manualMax! : automatic.max,
    bands: setting.bands
  };
}

export const SAFETY_FACTOR_FIXED_RANGE: Readonly<{ min: number; max: number }> = Object.freeze({ min: 0, max: SAFETY_FACTOR_SCALE_MAX });

/** The colour of an absolute factor of safety: its band, interpolated within the band.
 *  Factors above the scale clamp to the safe end; an infinite factor (no stress) is safe. */
export function safetyFactorColor(value: number): string {
  if (Number.isNaN(value)) return SAFETY_FACTOR_BANDS[0]!.colors[0];
  const clamped = Math.max(0, Math.min(SAFETY_FACTOR_SCALE_MAX, value));
  const band = SAFETY_FACTOR_BANDS.find((candidate) => clamped < candidate.to) ?? SAFETY_FACTOR_BANDS[SAFETY_FACTOR_BANDS.length - 1]!;
  return interpolateHex(band.colors[0], band.colors[1], (clamped - band.from) / (band.to - band.from));
}

/** Where SF = 1 falls on a safety-factor scale (0-1), or null when it is off the scale or
 *  the scale is not a safety factor. The legend draws its mark here. */
export function safetyFactorLimitPosition(scale: Pick<ResolvedResultColorScale, "type" | "min" | "max">): number | null {
  if (scale.type !== "safety_factor") return null;
  const span = scale.max - scale.min;
  if (!Number.isFinite(span) || span <= resultScaleRangeEpsilon(scale.min, scale.max)) return null;
  if (SAFETY_FACTOR_LIMIT < scale.min || SAFETY_FACTOR_LIMIT > scale.max) return null;
  return (SAFETY_FACTOR_LIMIT - scale.min) / span;
}

export function normalizedResultScaleValue(value: number, scale: Pick<ResolvedResultColorScale, "min" | "max">): number {
  if (!Number.isFinite(value)) return 0;
  const span = scale.max - scale.min;
  if (!Number.isFinite(span) || span <= resultScaleRangeEpsilon(scale.min, scale.max)) return 0;
  return clamp01((value - scale.min) / span);
}

export function resultColorForValue(value: number, scale: ResolvedResultColorScale): string {
  // Absolute bands already quantize safety factor; eight equal bands across 0-3 would
  // straddle SF = 1 and paint 1.1 as yielding.
  if (scale.type === "safety_factor") return safetyFactorColor(Number.isFinite(value) ? Math.max(scale.min, Math.min(scale.max, value)) : value);
  const normalized = normalizedResultScaleValue(value, scale);
  const sample = scale.bands === "bands8" ? quantizedBandSample(normalized) : normalized;
  return colorAtScalePosition(sample, scale);
}

export function resultColorAtNormalized(type: ResultMode, component: StressComponent | undefined, value: number, bands: ResultColorBands = "continuous"): string {
  const normalized = clamp01(value);
  if (type === "safety_factor") return safetyFactorColor(normalized * SAFETY_FACTOR_SCALE_MAX);
  const sample = bands === "bands8" ? quantizedBandSample(normalized) : normalized;
  return colorAtScalePosition(sample, { type, component, min: 0, max: 1 });
}

export function resultScaleCssGradient(scale: ResolvedResultColorScale): string {
  if (scale.type === "safety_factor") return safetyFactorCssGradient(scale.min, scale.max);
  if (scale.bands === "bands8") {
    const stops: string[] = [];
    for (let index = 0; index < BAND_COUNT; index += 1) {
      const start = (index / BAND_COUNT) * 100;
      const end = ((index + 1) / BAND_COUNT) * 100;
      const color = colorAtScalePosition((index + 0.5) / BAND_COUNT, scale);
      stops.push(`${color} ${formatPercent(start)}%`, `${color} ${formatPercent(end)}%`);
    }
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }
  if (scale.type === "stress" && isDivergingStressComponent(scale.component)) {
    if (scale.min < 0 && scale.max > 0) {
      const zero = normalizedResultScaleValue(0, scale) * 100;
      return `linear-gradient(90deg, ${DIVERGING_NEGATIVE} 0%, ${DIVERGING_NEUTRAL} ${formatPercent(zero)}%, ${DIVERGING_POSITIVE} 100%)`;
    }
    return scale.min >= 0
      ? `linear-gradient(90deg, ${DIVERGING_NEUTRAL} 0%, ${DIVERGING_POSITIVE} 100%)`
      : `linear-gradient(90deg, ${DIVERGING_NEGATIVE} 0%, ${DIVERGING_NEUTRAL} 100%)`;
  }
  const ramp = sequentialRamp(scale.type);
  const denominator = Math.max(1, ramp.length - 1);
  return `linear-gradient(90deg, ${ramp.map((color, index) => `${color} ${formatPercent(index / denominator * 100)}%`).join(", ")})`;
}

/** The fixed bands clipped to [min, max], with hard stops where a band ends. */
function safetyFactorCssGradient(min: number, max: number): string {
  const span = max - min;
  if (!Number.isFinite(span) || span <= resultScaleRangeEpsilon(min, max)) {
    const color = safetyFactorColor(min);
    return `linear-gradient(90deg, ${color} 0%, ${color} 100%)`;
  }
  const percent = (value: number) => formatPercent(clamp01((value - min) / span) * 100);
  const stops: string[] = [];
  SAFETY_FACTOR_BANDS.forEach((band, index) => {
    const last = index === SAFETY_FACTOR_BANDS.length - 1;
    const start = Math.max(band.from, min);
    const end = Math.min(last ? Math.max(band.to, max) : band.to, max);
    if (end <= start) return;
    const startColor = safetyFactorColor(start);
    const endColor = interpolateHex(band.colors[0], band.colors[1], (Math.min(end, band.to) - band.from) / (band.to - band.from));
    stops.push(`${startColor} ${percent(start)}%`);
    if (last && end > band.to) stops.push(`${band.colors[1]} ${percent(band.to)}%`);
    stops.push(`${endColor} ${percent(end)}%`);
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function colorAtScalePosition(position: number, scale: Pick<ResolvedResultColorScale, "type" | "component" | "min" | "max">): string {
  if (scale.type === "safety_factor") return safetyFactorColor(scale.min + clamp01(position) * (scale.max - scale.min));
  if (scale.type === "stress" && isDivergingStressComponent(scale.component)) {
    return divergingColor(position, scale.min, scale.max);
  }
  return interpolateRamp(sequentialRamp(scale.type), position);
}

function divergingColor(position: number, min: number, max: number): string {
  if (min < 0 && max > 0) {
    const zero = clamp01((0 - min) / (max - min));
    if (position <= zero) return interpolateHex(DIVERGING_NEGATIVE, DIVERGING_NEUTRAL, zero > 0 ? position / zero : 1);
    return interpolateHex(DIVERGING_NEUTRAL, DIVERGING_POSITIVE, zero < 1 ? (position - zero) / (1 - zero) : 0);
  }
  return min >= 0
    ? interpolateHex(DIVERGING_NEUTRAL, DIVERGING_POSITIVE, position)
    : interpolateHex(DIVERGING_NEGATIVE, DIVERGING_NEUTRAL, position);
}

function sequentialRamp(type: ResultMode): string[] {
  if (type === "displacement" || type === "velocity" || type === "acceleration") return MOTION_RAMP;
  if (type === "safety_factor") return SAFETY_RAMP;
  return STRESS_RAMP;
}

function interpolateRamp(colors: string[], value: number): string {
  const position = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(position));
  return interpolateHex(colors[index]!, colors[index + 1]!, position - index);
}

function interpolateHex(start: string, end: string, value: number): string {
  const a = parseHex(start);
  const b = parseHex(end);
  const t = clamp01(value);
  return `#${[0, 1, 2].map((index) => Math.round(a[index]! + (b[index]! - a[index]!) * t).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(color: string): [number, number, number] {
  const value = color.startsWith("#") ? color.slice(1) : color;
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function quantizedBandSample(value: number): number {
  const band = Math.min(BAND_COUNT - 1, Math.floor(clamp01(value) * BAND_COUNT));
  return (band + 0.5) / BAND_COUNT;
}

function formatPercent(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
