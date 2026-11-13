// Safety-factor basis (plan 036 R3.4) against the real solver. Yield strength does
// not enter the stiffness, so a solve whose material yields at S produces the
// same stress and the safety factor S / von Mises. Re-basing the yield result to
// S must therefore reproduce that solve's safety factor exactly: the summary
// minimum, the element field and the solver-surface node field.
import { describe, expect, test } from "vitest";
import { StudySchema, type CustomMaterial, type DisplayModel, type ResultField, type StructuralResultSummary, type Study } from "@openfea/schema";
import { rebaseSafetyFactorFields, rebaseSafetyFactorSummary, resolveSafetyFactorBasis } from "../safetyFactorBasis";
import { trySolveOpenFeaCoreStudy } from "./openfeaCoreSolve";

/** Re-basing multiplies the solver's ratio by one constant; agreement is to round-off. */
const ROUNDOFF_RELATIVE_TOLERANCE = 1e-12;

const YIELD_PA = 250e6;
const ULTIMATE_PA = 400e6;
const ALLOWABLE_PA = 100e6;

const BASE: CustomMaterial = {
  id: "00000000-0000-4000-8000-0000000000e1",
  name: "Basis steel",
  category: "metal",
  youngsModulus: 200e9,
  poissonRatio: 0.29,
  density: 7850,
  yieldStrength: YIELD_PA,
  ultimateStrength: ULTIMATE_PA,
  verification: "user_supplied_unverified"
};
/** Same material, yielding at the strength the basis divides by. */
const YIELDS_AT_ULTIMATE: CustomMaterial = { ...BASE, id: "00000000-0000-4000-8000-0000000000e2", yieldStrength: ULTIMATE_PA };
const YIELDS_AT_ALLOWABLE: CustomMaterial = { ...BASE, id: "00000000-0000-4000-8000-0000000000e3", yieldStrength: ALLOWABLE_PA, ultimateStrength: undefined };
const CUSTOM_MATERIALS = [BASE, YIELDS_AT_ULTIMATE, YIELDS_AT_ALLOWABLE];

const displayModel = {
  id: "display-cantilever",
  name: "Cantilever",
  bodyCount: 1,
  dimensions: { x: 180, y: 24, z: 24, units: "mm" },
  faces: [
    { id: "face-fixed", label: "Fixed", color: "#94a3b8", center: [0, 12, 12], normal: [-1, 0, 0], stressValue: 0 },
    { id: "face-load", label: "Load", color: "#94a3b8", center: [180, 12, 12], normal: [1, 0, 0], stressValue: 0 }
  ]
} satisfies DisplayModel;

function cantilever(materialId: string, safetyFactorBasis?: unknown): Study {
  return StudySchema.parse({
    id: "study-basis",
    projectId: "project-1",
    name: "Cantilever basis",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
    materialAssignments: [{ id: "mat-assignment", materialId, selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      { id: "selection-body", name: "Body", entityType: "body", geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }], fingerprint: "body" },
      { id: "selection-fixed", name: "Fixed face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }], fingerprint: "face-fixed" },
      { id: "selection-load", name: "Load face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }], fingerprint: "face-load" }
    ],
    contacts: [],
    constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
    loads: [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: 500, units: "N", direction: [0, 0, -1] }, status: "complete" }],
    meshSettings: { preset: "coarse", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
    validation: [],
    runs: [],
    solverSettings: { backend: "opencae_core_local", fidelity: "standard" },
    ...(safetyFactorBasis ? { safetyFactorBasis } : {})
  });
}

type Solved = { summary: StructuralResultSummary; fields: ResultField[] };

function solve(materialId: string, force = 500, customMaterials = CUSTOM_MATERIALS): Solved {
  const study = cantilever(materialId);
  study.loads[0]!.parameters.value = force;
  const outcome = trySolveOpenFeaCoreStudy({ study, runId: `run-${materialId}`, displayModel, customMaterials });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.result as unknown as Solved;
}

function expectRelative(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(ROUNDOFF_RELATIVE_TOLERANCE * Math.max(Math.abs(expected), Number.MIN_VALUE));
}

function expectSameSafetyFactors(rebased: ResultField[], reference: ResultField[]) {
  const safety = (fields: ResultField[]) => fields.filter((field) => field.type === "safety_factor");
  const actual = safety(rebased);
  const expected = safety(reference);
  expect(actual.map((field) => field.id)).toEqual(expected.map((field) => field.id));
  expect(actual.length).toBeGreaterThan(0);
  actual.forEach((field, index) => {
    const target = expected[index]!;
    expect(field.values.length).toBe(target.values.length);
    field.values.forEach((value, valueIndex) => expectRelative(value, target.values[valueIndex]!));
    expectRelative(field.min, target.min);
    expectRelative(field.max, target.max);
  });
}

// Each test runs a real solve; allow for a loaded machine like the other solver-backed tests.
describe("safety-factor basis against the solver", { timeout: 120000 }, () => {
  const yieldResult = solve(BASE.id);

  test("the stress does not depend on the strength, so re-basing is exact", () => {
    const reference = solve(YIELDS_AT_ULTIMATE.id);
    expect(reference.summary.maxStress).toBe(yieldResult.summary.maxStress);
    expect(yieldResult.summary.safetyFactor).toBeGreaterThan(0);
  });

  test("ultimate: re-based yield result equals a solve that divides by the ultimate strength", () => {
    const basis = resolveSafetyFactorBasis({ study: cantilever(BASE.id, { strength: "ultimate" }), customMaterials: CUSTOM_MATERIALS, displayModel, unitSystem: "SI" });
    expect(basis.strength).toBe("ultimate");
    const reference = solve(YIELDS_AT_ULTIMATE.id);
    expectRelative(rebaseSafetyFactorSummary(yieldResult.summary, basis.factor).safetyFactor, reference.summary.safetyFactor);
    expectSameSafetyFactors(rebaseSafetyFactorFields(yieldResult.fields, basis.factor, basis.strengthPascals), reference.fields);
  });

  test("allowable: re-based yield result equals a solve that divides by the allowable", () => {
    const basis = resolveSafetyFactorBasis({ study: cantilever(BASE.id, { strength: "allowable", allowableStress: ALLOWABLE_PA }), customMaterials: CUSTOM_MATERIALS, displayModel, unitSystem: "SI" });
    expect(basis.strength).toBe("allowable");
    const reference = solve(YIELDS_AT_ALLOWABLE.id);
    const summary = rebaseSafetyFactorSummary(yieldResult.summary, basis.factor);
    expectRelative(summary.safetyFactor, reference.summary.safetyFactor);
    // ...which is the allowable over the element-peak von Mises the summary reports.
    expectRelative(summary.safetyFactor, (ALLOWABLE_PA / 1e6) / yieldResult.summary.maxStress);
    expectSameSafetyFactors(rebaseSafetyFactorFields(yieldResult.fields, basis.factor, basis.strengthPascals), reference.fields);
  });

  test("a low allowable reconstructs capped yield contours and matches a fresh solve", () => {
    const strength = 25;
    const referenceMaterial = { ...YIELDS_AT_ALLOWABLE, yieldStrength: strength };
    const original = solve(BASE.id, 0.001);
    const reference = solve(referenceMaterial.id, 0.001, [BASE, referenceMaterial]);
    const originalSurface = original.fields.find((field) => field.type === "safety_factor" && field.location === "node")!;
    expect(originalSurface.values.some((value) => value === 10000)).toBe(true);
    expect(reference.fields.some((field) => field.type === "safety_factor" && field.location === "node" && field.values.some((value) => value < 1))).toBe(true);
    expectSameSafetyFactors(rebaseSafetyFactorFields(original.fields, strength / YIELD_PA, strength), reference.fields);
  });

  test("yield (default): the solver result is shown as solved", () => {
    const basis = resolveSafetyFactorBasis({ study: cantilever(BASE.id), customMaterials: CUSTOM_MATERIALS, displayModel, unitSystem: "SI" });
    expect(basis.factor).toBe(1);
    expect(rebaseSafetyFactorFields(yieldResult.fields, basis.factor)).toBe(yieldResult.fields);
  });
});
