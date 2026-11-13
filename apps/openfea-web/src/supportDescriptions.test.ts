import { describe, expect, test } from "vitest";
import type { Constraint, DisplayFace } from "@openfea/schema";
import { ConstraintSchema } from "@openfea/schema";
import { elasticSupportParameters, fixedSupportParameters, foundationModulusForDisplay, foundationModulusFromDisplay, isPartialFixedSupport, structuralSupportDescription, symmetryCheckForDisplayFace, symmetryCheckForFaces } from "./supportDescriptions";

function face(label: string, normal: [number, number, number], surfaceType: DisplayFace["surfaceType"] = "planar"): DisplayFace {
  return { id: label, label, color: "#888", center: [0, 0, 0], normal, stressValue: 0, surfaceType };
}

function support(type: Constraint["type"], parameters: Record<string, unknown> = {}): Constraint {
  return { id: `s-${type}`, type, selectionRef: "selection-a", parameters, status: "complete" };
}

describe("support descriptions (plan 036 R1.4)", () => {
  test("rows name every component a fixed support holds and the ones it leaves free", () => {
    expect(structuralSupportDescription(support("fixed"))).toBe("Fixed support (X, Y, Z)");
    expect(structuralSupportDescription(support("fixed", { components: ["x", "z"] }))).toBe("Fixed support (X, Z; Y free)");
    expect(structuralSupportDescription(support("fixed", { components: ["y"] }))).toBe("Fixed support (Y; X, Z free)");
    expect(structuralSupportDescription(support("prescribed_displacement", { value: 1, component: "x" }))).toBeUndefined();
  });

  test("symmetry rows name the face-normal axis when the faces are known", () => {
    expect(structuralSupportDescription(support("symmetry"), [face("Top", [0, 0, 1])])).toBe("Symmetry / roller (holds Z, the face normal)");
    expect(structuralSupportDescription(support("symmetry"))).toBe("Symmetry / roller (holds the face normal)");
  });

  test("the panel pre-check accepts axis-aligned flat faces and refuses tilted or curved ones explicitly", () => {
    expect(symmetryCheckForDisplayFace(face("Side", [0, -1, 0]))).toEqual({ ok: true, component: "y" });
    const tilt = (Math.PI / 180) * 0.5;
    expect(symmetryCheckForDisplayFace(face("Almost", [0, Math.sin(tilt), Math.cos(tilt)]))).toEqual({ ok: true, component: "z" });
    const tilted = symmetryCheckForDisplayFace(face("Chamfer", [Math.SQRT1_2, 0, Math.SQRT1_2]));
    expect(tilted.ok).toBe(false);
    if (!tilted.ok) expect(tilted.message).toBe("Chamfer is 45° from the X axis. A symmetry/roller face must be within 1° of a global axis; use a fixed support with chosen components instead.");
    const curved = symmetryCheckForDisplayFace(face("Hole", [0, 0, 1], "cylindrical"));
    expect(curved.ok).toBe(false);
    if (!curved.ok) expect(curved.message).toMatch(/^Hole is curved\./);
    expect(symmetryCheckForFaces([face("A", [1, 0, 0]), face("B", [-1, 0, 0])])).toEqual({ ok: true, component: "x" });
    expect(symmetryCheckForFaces([face("A", [1, 0, 0]), face("B", [0, 1, 0])])).toMatchObject({ ok: false });
    expect(symmetryCheckForFaces([])).toBeUndefined();
  });

  test("holding all three components stores no list, so the support is byte-identical to a legacy one", () => {
    expect(fixedSupportParameters({ label: "FS 1" }, ["x", "y", "z"])).toEqual({ label: "FS 1" });
    expect(fixedSupportParameters({ label: "FS 1", components: ["x"] }, ["z", "x"])).toEqual({ label: "FS 1", components: ["x", "z"] });
    expect(isPartialFixedSupport(support("fixed"))).toBe(false);
    expect(isPartialFixedSupport(support("fixed", { components: ["x"] }))).toBe(true);
    expect(isPartialFixedSupport(support("symmetry"))).toBe(false);
  });

  test("elastic support rows show both stiffnesses in project units; the study keeps N/m^3 (plan 036 R1.5)", () => {
    const elastic = support("elastic_support", elasticSupportParameters({ label: "ES 1" }, 5e7, 2.714471e5));
    expect(elastic.parameters).toEqual({ label: "ES 1", normalStiffness: 5e7, tangentialStiffness: 2.714471e5, units: "N/m^3" });
    expect(structuralSupportDescription(elastic, [], "SI")).toBe("Elastic support (normal 0.05 N/mm³, tangential 0.0002714 N/mm³)");
    expect(structuralSupportDescription(elastic, [], "US")).toMatch(/^Elastic support \(normal 184(\.\d+)? lbf\/in³, tangential 1 lbf\/in³\)$/);
    expect(foundationModulusFromDisplay(foundationModulusForDisplay(5e7, "US"), "US")).toBeCloseTo(5e7, 3);
    expect(foundationModulusFromDisplay(0.05, "SI")).toBeCloseTo(5e7, 3);
    expect(ConstraintSchema.safeParse(elastic).success).toBe(true);
    for (const parameters of [{ normalStiffness: 0, tangentialStiffness: 0 }, { normalStiffness: -1, tangentialStiffness: 1 }, { normalStiffness: 1, tangentialStiffness: 1, units: "N/mm^3" }, {}]) {
      expect(ConstraintSchema.safeParse(support("elastic_support", parameters)).success, JSON.stringify(parameters)).toBe(false);
    }
  });

  test("the schema accepts the new support shapes and rejects malformed component lists", () => {
    expect(ConstraintSchema.safeParse(support("symmetry")).success).toBe(true);
    expect(ConstraintSchema.safeParse(support("fixed", { components: ["x", "y"] })).success).toBe(true);
    for (const components of [[], ["x", "x"], ["w"], "xyz"]) {
      expect(ConstraintSchema.safeParse(support("fixed", { components })).success, JSON.stringify(components)).toBe(false);
    }
  });
});
