import { describe, expect, test } from "vitest";
import { BRACKET_CORE_CLOUD_GEOMETRY } from "./bracketGeometryMigration";
import { massGramsForVolume, sampleSolidVolumeMm3, sampleSolverGeometryLabel, shouldShowSampleModelPicker } from "./modelPanelState";

describe("model panel state", () => {
  test("hides sample model controls for a blank new project", () => {
    expect(shouldShowSampleModelPicker({ geometryFiles: [] })).toBe(false);
  });

  test("shows sample model controls for projects opened from the sample menu", () => {
    expect(shouldShowSampleModelPicker({ geometryFiles: [{ metadata: { source: "sample", sampleModel: "bracket" } }] })).toBe(true);
  });

  test("hides sample model controls for uploaded models", () => {
    expect(shouldShowSampleModelPicker({ geometryFiles: [{ metadata: { source: "local-upload" } }] })).toBe(false);
  });

  test("reads the structural volume from a structured block solver geometry", () => {
    expect(sampleSolidVolumeMm3({ kind: "structured_block", units: "mm", descriptor: { length: 180, width: 24, height: 24 } })).toBe(103_680);
    expect(sampleSolidVolumeMm3({ kind: "structured_block", units: "m", descriptor: { length: 0.18, width: 0.024, height: 0.024 } })).toBeCloseTo(103_680, 6);
    expect(sampleSolverGeometryLabel({ kind: "structured_block", units: "mm", descriptor: {} })).toBe("Structured block");
  });

  test("reads the Bracket Demo volume from the procedural geometry that is meshed", () => {
    // 120x34x10 base + 18x34x78 upright + 40x40/2x12 rib - two 12 mm and one 10 mm bore.
    // The old hard-coded 41,280 mm^3 / 111 g was less than half of this.
    expect(sampleSolidVolumeMm3(BRACKET_CORE_CLOUD_GEOMETRY)).toBeCloseTo(93_203.7, 1);
    expect(sampleSolverGeometryLabel(BRACKET_CORE_CLOUD_GEOMETRY)).toBe("Procedural sample (simplified)");
  });

  test("reports no volume for geometry whose volume is not recorded", () => {
    expect(sampleSolidVolumeMm3(undefined)).toBeUndefined();
    expect(sampleSolidVolumeMm3({ kind: "uploaded_cad", format: "step", units: "mm" })).toBeUndefined();
    expect(sampleSolidVolumeMm3({ kind: "structured_block", units: "mm", descriptor: { length: 180, width: 24 } })).toBeUndefined();
    expect(sampleSolverGeometryLabel({ kind: "uploaded_cad", format: "step", units: "mm" })).toBeUndefined();
  });

  test("converts volume and density to grams", () => {
    // 103,680 mm^3 of 6061 aluminum (2700 kg/m^3) vs. ABS (1040 kg/m^3).
    expect(massGramsForVolume(103_680, 2700)).toBeCloseTo(279.936, 6);
    expect(massGramsForVolume(103_680, 1040)).toBeCloseTo(107.8272, 6);
    expect(massGramsForVolume(103_680, 0)).toBeUndefined();
    expect(massGramsForVolume(Number.NaN, 2700)).toBeUndefined();
  });
});
