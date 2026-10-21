import { describe, expect, test } from "vitest";
import {
  addDistinctMaterial,
  bodyElementBlockName,
  bodyIdFromElementBlockName,
  bodyLabelForId,
  hasPerBodyMaterialAssignments,
  materialAssignmentForBody
} from "./bodyAssignments";

describe("per-body material assignments", () => {
  const legacy = [{ id: "a", materialId: "mat-steel" }];
  const mixed = [
    { id: "default", materialId: "mat-steel" },
    { id: "b2", materialId: "mat-aluminum-6061", bodyId: "step-object-2" }
  ];

  test("a single legacy assignment covers every body", () => {
    expect(hasPerBodyMaterialAssignments(legacy)).toBe(false);
    expect(materialAssignmentForBody(legacy, "step-object-1")?.id).toBe("a");
    expect(materialAssignmentForBody(legacy, undefined)?.id).toBe("a");
  });

  test("a body's own assignment wins over the whole-model default", () => {
    expect(hasPerBodyMaterialAssignments(mixed)).toBe(true);
    expect(materialAssignmentForBody(mixed, "step-object-2")?.id).toBe("b2");
    expect(materialAssignmentForBody(mixed, "step-object-1")?.id).toBe("default");
    expect(materialAssignmentForBody([mixed[1]!], "step-object-1")).toBeUndefined();
  });

  test("element block names round-trip body ids", () => {
    expect(bodyElementBlockName("step-object-3")).toBe("body:step-object-3");
    expect(bodyIdFromElementBlockName("body:step-object-3")).toBe("step-object-3");
    expect(bodyIdFromElementBlockName("solid")).toBeUndefined();
    expect(bodyIdFromElementBlockName("body:")).toBeUndefined();
    expect(bodyLabelForId("step-object-3")).toBe("Body 3");
  });

  test("materials are shared when identical and suffixed when a name clashes", () => {
    const materials: Array<{ name: string; youngModulus: number }> = [];
    const steel = addDistinctMaterial(materials, { name: "mat-pla", youngModulus: 3.5e9 });
    expect(addDistinctMaterial(materials, { name: "mat-pla", youngModulus: 3.5e9 })).toBe(steel);
    // Same catalog id, different infill: a second material, not an alias.
    expect(addDistinctMaterial(materials, { name: "mat-pla", youngModulus: 1.2e9 }).name).toBe("mat-pla#2");
    expect(materials.map((material) => material.name)).toEqual(["mat-pla", "mat-pla#2"]);
  });
});
