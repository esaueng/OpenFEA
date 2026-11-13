import { describe, expect, test } from "vitest";
import type { DisplayFace } from "@openfea/schema";
import { modelHitLabelText, viewerFaceLabel } from "./CadViewer";
import { formatStepFaceAreaMm2 } from "../stepFaceLabels";

// One square inch and two square inches, measured in STEP model space (mm²), with the
// label the STEP importer stores for them.
const ONE_SQUARE_INCH_MM2 = 645.16;
const topFace: DisplayFace = {
  id: "step-face-1",
  label: `+Z planar face F1 (${formatStepFaceAreaMm2(ONE_SQUARE_INCH_MM2)})`,
  color: "#4da3ff",
  center: [0, 0, 1],
  normal: [0, 0, 1],
  stressValue: 0,
  area: ONE_SQUARE_INCH_MM2
};
const holeWall: DisplayFace = {
  id: "step-face-2",
  label: `Cylindrical hole wall F2 (${formatStepFaceAreaMm2(2 * ONE_SQUARE_INCH_MM2)})`,
  color: "#4da3ff",
  center: [0, 0, 0],
  normal: [1, 0, 0],
  stressValue: 0,
  area: 2 * ONE_SQUARE_INCH_MM2
};

describe("viewer face hover/pick label units", () => {
  test("an imperial project's hover label shows the face area in in², not mm²", () => {
    const label = modelHitLabelText({ face: topFace }, "US");
    expect(label).toBe("+Z planar F1 (1 in²)");
    expect(label).not.toContain("mm²");
    expect(modelHitLabelText({ face: holeWall }, "US")).toBe("Cylindrical hole wall F2 (2 in²)");
  });

  test("a metric project's hover label keeps the stored mm² suffix", () => {
    expect(modelHitLabelText({ face: topFace }, "SI")).toBe("+Z planar F1 (645 mm²)");
  });

  test("the selection chip and keyboard face list use the same project-unit label", () => {
    expect(viewerFaceLabel(topFace, "US")).toBe("+Z planar face F1 (1 in²)");
    expect(viewerFaceLabel(topFace, "SI")).toBe(topFace.label);
  });

  test("labels without a measured area or STEP suffix, and payload objects, are shown as stored", () => {
    expect(modelHitLabelText({ face: { ...topFace, area: undefined } }, "US")).toBe("+Z planar F1 (645 mm²)");
    expect(modelHitLabelText({ face: { ...topFace, label: "Top face" } }, "US")).toBe("Top");
    expect(
      modelHitLabelText({ face: topFace, payloadObject: { id: "payload-1", label: "Payload mass", center: [0, 0, 0] } }, "US")
    ).toBe("Payload mass");
  });
});
