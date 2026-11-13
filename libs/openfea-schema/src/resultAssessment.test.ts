import { describe, expect, test } from "vitest";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor } from "./index";

describe("assessResultFailure", () => {
  test("marks a result as failed when factor of safety is below one", () => {
    expect(assessResultFailure({ safetyFactor: 0.82, maxStress: 338, maxStressUnits: "MPa" })).toMatchObject({
      status: "fail",
      title: "Likely to fail"
    });
  });

  test("warns when the factor of safety has little margin", () => {
    expect(assessResultFailure({ safetyFactor: 1.2, maxStress: 210, maxStressUnits: "MPa" })).toMatchObject({
      status: "warning",
      title: "Low safety margin"
    });
  });

  test("passes when the factor of safety has usable margin", () => {
    expect(assessResultFailure({ safetyFactor: 1.8, maxStress: 142, maxStressUnits: "MPa" })).toMatchObject({
      status: "pass",
      title: "Unlikely to yield"
    });
  });

  test("names the safety-factor basis it was given; the default reads exactly as before (plan 036 R3.4)", () => {
    const passing = { safetyFactor: 1.8, maxStress: 142, maxStressUnits: "MPa" };
    const failing = { safetyFactor: 0.82, maxStress: 338, maxStressUnits: "MPa" };
    expect(assessResultFailure(passing, "yield")).toEqual(assessResultFailure(passing));
    expect(assessResultFailure(passing)).toEqual({
      status: "pass",
      title: "Unlikely to yield",
      message: "Safety factor is 1.8. Peak stress is below the assigned material yield limit."
    });
    expect(assessResultFailure(failing).message).toBe("Peak stress is 338 MPa, which exceeds the assigned material yield limit.");
    expect(assessResultFailure(passing, "ultimate")).toMatchObject({ status: "pass", title: "Below ultimate strength", message: "Safety factor is 1.8. Peak stress is below the assigned material ultimate strength." });
    expect(assessResultFailure(failing, "ultimate")).toMatchObject({ status: "fail", title: "Likely to fail", message: "Peak stress is 338 MPa, which exceeds the assigned material ultimate strength." });
    expect(assessResultFailure(passing, "allowable")).toMatchObject({ status: "pass", title: "Within allowable stress" });
    expect(assessResultFailure(failing, "allowable")).toMatchObject({ status: "fail", title: "Exceeds allowable stress", message: "Peak stress is 338 MPa, which exceeds the allowable stress." });
  });

  test("estimates max load for a target factor of safety by linear scaling", () => {
    expect(estimateAllowableLoadForSafetyFactor({ safetyFactor: 0.75, reactionForce: 500, reactionForceUnits: "N" }, 1.5)).toMatchObject({
      status: "available",
      allowableLoad: 250,
      loadScale: 0.5,
      loadUnits: "N"
    });
  });

  test("does not estimate max load when the current result is invalid", () => {
    expect(estimateAllowableLoadForSafetyFactor({ safetyFactor: 0, reactionForce: 500, reactionForceUnits: "N" }, 1.5)).toMatchObject({
      status: "unknown",
      allowableLoad: 0
    });
  });
});
