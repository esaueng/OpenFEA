import { describe, expect, it } from "vitest";
import type { ResultField } from "@openfea/schema";
import {
  automaticResultFieldRange,
  normalizedResultScaleValue,
  resolveResultColorScale,
  resultColorForValue,
  resultRampFloatStops,
  resultScaleCssGradient,
  SAFETY_FACTOR_BANDS,
  SAFETY_FACTOR_LIMIT,
  SAFETY_FACTOR_SCALE_MAX,
  SAFETY_RAMP,
  safetyFactorColor,
  safetyFactorLimitPosition,
  stressRampFloatStops,
  validManualResultRange
} from "./resultColorScale";

const baseScale = { type: "stress" as const, component: "von_mises" as const, min: 0, max: 100, bands: "continuous" as const };

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function linear(hex: string): [number, number, number] {
  return channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function applyMatrix(matrix: number[][], rgb: [number, number, number]): [number, number, number] {
  return matrix.map((row) => Math.min(1, Math.max(0, row[0]! * rgb[0] + row[1]! * rgb[1] + row[2]! * rgb[2]))) as [number, number, number];
}

/** Linear sRGB -> CIELAB (D65). */
function lab([red, green, blue]: [number, number, number]): [number, number, number] {
  const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
  const y = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The band stop closest to a colour (a value just under an edge interpolates to it). */
function nearestStop(hex: string): string {
  const [r, g, b] = channels(hex);
  return [...SAFETY_RAMP].sort((left, right) => {
    const distance = (stop: string) => { const [sr, sg, sb] = channels(stop); return Math.hypot(sr - r, sg - g, sb - b); };
    return distance(left) - distance(right);
  })[0]!;
}

function deltaE(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("result color scale", () => {
  it("clamps endpoint colors without changing the supplied numerical value", () => {
    expect(resultColorForValue(-20, baseScale)).toBe(resultColorForValue(0, baseScale));
    expect(resultColorForValue(120, baseScale)).toBe(resultColorForValue(100, baseScale));
    expect(normalizedResultScaleValue(40, baseScale)).toBe(0.4);
  });

  it("uses the same generated colors in the renderer and continuous legend", () => {
    const gradient = resultScaleCssGradient(baseScale);
    expect(gradient).toContain(`${resultColorForValue(0, baseScale)} 0%`);
    expect(gradient).toContain(`${resultColorForValue(100, baseScale)} 100%`);
  });

  it("quantizes values into eight shared bands and changes at boundaries", () => {
    const bands = { ...baseScale, bands: "bands8" as const };
    expect(resultColorForValue(0, bands)).toBe(resultColorForValue(12.499, bands));
    expect(resultColorForValue(12.5, bands)).not.toBe(resultColorForValue(12.499, bands));
    expect(resultScaleCssGradient(bands).match(/%/g)).toHaveLength(16);
  });

  it("keeps low safety values red and runs high values to blue, not green", () => {
    const safety = { ...baseScale, type: "safety_factor" as const, component: undefined };
    expect(resultColorForValue(0, safety)).toBe(SAFETY_RAMP[0]);
    expect(resultColorForValue(100, safety)).toBe(SAFETY_RAMP[SAFETY_RAMP.length - 1]);
    const [lowRed, , lowBlue] = channels(resultColorForValue(0, safety));
    const [highRed, , highBlue] = channels(resultColorForValue(100, safety));
    expect(lowRed).toBeGreaterThan(lowBlue);
    expect(highBlue).toBeGreaterThan(highRed);
  });

  it("keeps the safety-factor bands apart under red-green colour blindness", () => {
    // Simulated with the Machado et al. (2009) severity-1.0 matrices, compared in CIELAB.
    // The old red -> green ramp measured ends ΔE 37 (protanopia) / 13 (deuteranopia); this
    // one measures 57 / 76, and each band edge (SF = 1, SF = 2) at least ΔE 26.
    const machado = {
      protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
      deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]]
    };
    for (const [name, matrix] of Object.entries(machado)) {
      const seen = (hex: string) => lab(applyMatrix(matrix, linear(hex)));
      expect(deltaE(seen(SAFETY_RAMP[0]!), seen(SAFETY_RAMP[SAFETY_RAMP.length - 1]!)), `${name} ends`).toBeGreaterThan(50);
      for (let index = 1; index < SAFETY_FACTOR_BANDS.length; index += 1) {
        const below = SAFETY_FACTOR_BANDS[index - 1]!.colors[1];
        const above = SAFETY_FACTOR_BANDS[index]!.colors[0];
        expect(deltaE(seen(below), seen(above)), `${name} edge at SF ${SAFETY_FACTOR_BANDS[index]!.from}`).toBeGreaterThan(20);
      }
    }
    // No stop is green-dominant: the ramp never asks the eye to separate red from green.
    for (const hex of SAFETY_RAMP) {
      const [red, green, blue] = channels(hex);
      expect(green > red + 24 && green > blue + 24, hex).toBe(false);
    }
  });

  it("colours safety factor on fixed absolute bands, not relative to the field range", () => {
    // A field whose every factor is >= 158 rendered solid red when coloured min..max.
    const automatic = resolveResultColorScale({ type: "safety_factor", automaticRange: { min: 158, max: 10000 } });
    expect(automatic).toMatchObject({ min: 0, max: SAFETY_FACTOR_SCALE_MAX });
    expect(resultColorForValue(158, automatic)).toBe(SAFETY_FACTOR_BANDS[2]!.colors[1]);
    expect(resultColorForValue(10000, automatic)).toBe(SAFETY_FACTOR_BANDS[2]!.colors[1]);
    // Hard edges at SF = 1 and SF = 2.
    expect(resultColorForValue(0.99, automatic)).toBe(safetyFactorColor(0.99));
    expect(SAFETY_FACTOR_BANDS[0]!.colors).toContain(nearestStop(resultColorForValue(0.999, automatic)));
    expect(resultColorForValue(1, automatic)).toBe(SAFETY_FACTOR_BANDS[1]!.colors[0]);
    expect(resultColorForValue(2, automatic)).toBe(SAFETY_FACTOR_BANDS[2]!.colors[0]);
    expect(resultColorForValue(1.5, { ...automatic, bands: "bands8" })).toBe(safetyFactorColor(1.5));
    // An infinite factor (no stress) is safe; a manual range still takes precedence.
    expect(safetyFactorColor(Number.POSITIVE_INFINITY)).toBe(SAFETY_FACTOR_BANDS[2]!.colors[1]);
    expect(resolveResultColorScale({
      type: "safety_factor",
      automaticRange: { min: 158, max: 10000 },
      setting: { rangeMode: "manual", bands: "continuous", manualMin: 1, manualMax: 5 }
    })).toMatchObject({ min: 1, max: 5 });
    // The legend gradient has hard stops at the band edges.
    const gradient = resultScaleCssGradient(automatic);
    expect(gradient).toContain(`${SAFETY_FACTOR_BANDS[0]!.colors[1]} 33.333333%, ${SAFETY_FACTOR_BANDS[1]!.colors[0]} 33.333333%`);
    expect(gradient).toContain(`${SAFETY_FACTOR_BANDS[1]!.colors[1]} 66.666667%, ${SAFETY_FACTOR_BANDS[2]!.colors[0]} 66.666667%`);
    expect(resultScaleCssGradient({ ...automatic, min: 0, max: 6 })).toContain(`${SAFETY_FACTOR_BANDS[2]!.colors[1]} 50%, ${SAFETY_FACTOR_BANDS[2]!.colors[1]} 100%`);
  });

  it("locates SF = 1 on safety-factor scales only when it is in range", () => {
    const safety = { type: "safety_factor" as const, min: 0.5, max: 3, bands: "continuous" as const };
    expect(SAFETY_FACTOR_LIMIT).toBe(1);
    expect(safetyFactorLimitPosition(safety)).toBeCloseTo(0.2, 12);
    expect(safetyFactorLimitPosition({ ...safety, min: 1, max: 4 })).toBe(0);
    expect(safetyFactorLimitPosition({ ...safety, min: 1.2, max: 4 })).toBeNull();
    expect(safetyFactorLimitPosition({ ...safety, min: 0.1, max: 0.9 })).toBeNull();
    expect(safetyFactorLimitPosition({ ...safety, min: 1, max: 1 })).toBeNull();
    expect(safetyFactorLimitPosition({ ...baseScale, min: 0, max: 3 })).toBeNull();
  });

  it("exports the per-type ramps for the offline viewer", () => {
    expect(resultRampFloatStops("stress")).toEqual(stressRampFloatStops());
    // #a50026 -> 165/255, 0, 38/255
    expect(resultRampFloatStops("safety_factor")[0]).toEqual([0.647, 0, 0.149]);
    expect(resultRampFloatStops("safety_factor")).toHaveLength(SAFETY_RAMP.length);
  });

  it("places the diverging neutral stop at physical zero without forcing symmetry", () => {
    const signed = { ...baseScale, component: "principal_max" as const, min: -20, max: 80 };
    expect(normalizedResultScaleValue(0, signed)).toBe(0.2);
    expect(resultColorForValue(0, signed)).toBe("#f5f5f4");
    expect(resultScaleCssGradient(signed)).toContain("#f5f5f4 20%");
  });

  it("requires finite manual limits separated by a scale-relative epsilon", () => {
    expect(validManualResultRange(1, 2)).toBe(true);
    expect(validManualResultRange(2, 1)).toBe(false);
    expect(validManualResultRange(1e12, 1e12 + 0.1)).toBe(false);
    expect(validManualResultRange(Number.NaN, 2)).toBe(false);
  });

  it("uses the run-wide range for fields with one semantic identity", () => {
    const fields = [
      { id: "a", runId: "run", type: "stress", location: "node", units: "MPa", values: [2], min: 2, max: 4 },
      { id: "b", runId: "run", type: "stress", location: "node", units: "MPa", values: [8], min: -3, max: 8 }
    ] as ResultField[];
    expect(automaticResultFieldRange(fields, (field) => `${field.runId}:${field.type}:${field.location}`, fields[0]!)).toEqual({ min: -3, max: 8 });
  });

  it("falls back to automatic range when a persisted manual range is invalid", () => {
    expect(resolveResultColorScale({
      type: "stress",
      automaticRange: { min: 2, max: 9 },
      setting: { rangeMode: "manual", bands: "continuous", manualMin: 4, manualMax: 4 }
    })).toMatchObject({ min: 2, max: 9 });
  });
});
