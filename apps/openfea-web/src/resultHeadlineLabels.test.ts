import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { structuralHeadlineLabels } from "./resultHeadlineLabels";

describe("structural headline labels", () => {
  test("static runs keep their plain labels", () => {
    expect(structuralHeadlineLabels({})).toEqual({
      stress: "Max stress",
      displacement: "Max displacement",
      safetyFactor: "Safety factor",
      reactionForce: "Reaction force",
      peak: "Peak"
    });
  });

  test("dynamic runs say the headline is a peak over time, not the static result", () => {
    // Live review: the Bracket Demo's dynamic headline (1.827 MPa, 0.001433 mm)
    // matched static. That is physics, not a stale static result: the default
    // 0.1 s ramp is quasi-static for the stiff bracket, so the end-of-ramp
    // frame peaks at the static answer (computed dynamic and static differ in
    // the fifth significant figure). The labels must make the distinction.
    const labels = structuralHeadlineLabels({
      transient: { frameCount: 21, analysisType: "dynamic_structural", startTime: 0, endTime: 0.1, timeStep: 0.005, outputInterval: 0.005, peakDisplacement: 0.001433, peakDisplacementTimeSeconds: 0.1 }
    });
    expect(labels.stress).toBe("Peak stress over time");
    expect(labels.displacement).toBe("Peak displacement over time");
    expect(labels.safetyFactor).toBe("Min safety factor over time");
    expect(labels.reactionForce).toBe("Reaction force, final frame");
    expect(labels.peak).toBe("Peak over time");
  });

  test("with a safety-factor basis the label names it and that it is the model minimum (plan 036 R3.4)", () => {
    expect(structuralHeadlineLabels({}, "yield, von Mises").safetyFactor).toBe("Min safety factor (yield, von Mises)");
    expect(structuralHeadlineLabels({}, "allowable 138 MPa, von Mises").safetyFactor).toBe("Min safety factor (allowable 138 MPa, von Mises)");
    const dynamic = structuralHeadlineLabels({
      transient: { frameCount: 21, analysisType: "dynamic_structural", startTime: 0, endTime: 0.1, timeStep: 0.005, outputInterval: 0.005, peakDisplacement: 0.001433, peakDisplacementTimeSeconds: 0.1 }
    }, "ultimate, von Mises");
    expect(dynamic.safetyFactor).toBe("Min safety factor over time (ultimate, von Mises)");
  });

  test("the results headline and the legend peak both use these labels", () => {
    const panel = readFileSync(resolve(__dirname, "components/panels/ResultsPanels.tsx"), "utf8");
    expect(panel).toContain("structuralHeadlineLabels(resultSummary, safetyFactorBasis.shortLabel)");
    expect(panel).not.toMatch(/label: "Max stress", value: formatResultMetric\(resultSummary\.maxStress/);
    const workspace = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    expect(workspace).toContain("structuralHeadlineLabels(resultSummaryForUi)");
  });
});
