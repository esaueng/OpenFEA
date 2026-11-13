import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { effectiveMaterialProperties, starterMaterials } from "@openfea/materials";
import { StudySchema, safeParseLocalProject, type CustomMaterial, type ResultField, type StructuralResultSummary, type Study } from "@openfea/schema";
import { PASCALS_PER_PSI } from "@openfea/units";
import {
  DEFAULT_SAFETY_FACTOR_BASIS,
  rebaseSafetyFactorFields,
  rebaseSafetyFactorResults,
  rebaseSafetyFactorSummary,
  resolveSafetyFactorBasis,
  storedSafetyFactorBasis
} from "./safetyFactorBasis";
import { SAFETY_FACTOR_DISPLAY_CAP, SAFETY_FACTOR_DISPLAY_FLOOR } from "./resultFields";
import { projectStressUnit, stressPascalsFromProjectUnits, stressPascalsToProjectUnits } from "./unitDisplay";

/** Re-basing multiplies by one constant, so agreement is to floating-point round-off. */
const ROUNDOFF_RELATIVE_TOLERANCE = 1e-12;

function expectRelative(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(Math.abs(expected), Number.MIN_VALUE));
}

const SHOP_STEEL: CustomMaterial = {
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "Shop steel",
  category: "metal",
  youngsModulus: 200e9,
  poissonRatio: 0.29,
  density: 7850,
  yieldStrength: 250e6,
  ultimateStrength: 400e6,
  verification: "user_supplied_unverified"
};

const legacyFixture = JSON.parse(readFileSync(new URL("./fixtures/pre-safety-factor-basis-project.json", import.meta.url), "utf8")) as {
  project: unknown;
  results: { summary: StructuralResultSummary; fields: ResultField[] };
};

function legacyStudy(): Study {
  const parsed = safeParseLocalProject(legacyFixture.project);
  if (!parsed.success) throw new Error("fixture project no longer parses");
  return parsed.data.studies[0]!;
}

function withBasis(study: Study, safetyFactorBasis: unknown): Study {
  return StudySchema.parse({ ...study, safetyFactorBasis });
}

function withMaterial(study: Study, materialId: string, parameters: Record<string, unknown> = {}): Study {
  return { ...study, materialAssignments: study.materialAssignments.map((assignment) => ({ ...assignment, materialId, parameters })) };
}

describe("a project saved before the safety-factor basis existed", () => {
  test("reads as yield over von Mises and leaves the stored result untouched", () => {
    const study = legacyStudy();
    expect("safetyFactorBasis" in study ? study.safetyFactorBasis : undefined).toBeUndefined();
    expect(storedSafetyFactorBasis(study)).toEqual(DEFAULT_SAFETY_FACTOR_BASIS);
    const basis = resolveSafetyFactorBasis({ study, customMaterials: [SHOP_STEEL], unitSystem: "SI" });
    expect(basis).toMatchObject({ strength: "yield", factor: 1, shortLabel: "yield, von Mises", description: "Yield strength over von Mises stress" });
    expect(basis.fallbackReason).toBeUndefined();
    // Golden: the default is the identity, by reference, so nothing downstream recomputes.
    const { summary, fields } = legacyFixture.results;
    const rebased = rebaseSafetyFactorResults(summary, fields, basis.factor);
    expect(rebased.summary).toBe(summary);
    expect(rebased.fields).toBe(fields);
    expect(rebased.summary).toMatchObject({ safetyFactor: 2 });
  });

  test("an unreadable stored basis reads as absent instead of rejecting the study", () => {
    const study = legacyStudy();
    for (const unreadable of [{ strength: "allowable" }, { strength: "proof" }, { strength: "allowable", allowableStress: -5 }, "yield"]) {
      const parsed = withBasis(study, unreadable);
      expect(storedSafetyFactorBasis(parsed)).toEqual(DEFAULT_SAFETY_FACTOR_BASIS);
    }
  });

  test("a stored basis round-trips through the project file, allowable kept in Pa", () => {
    const study = withBasis(legacyStudy(), { strength: "ultimate", allowableStress: 180e6 });
    const reread = StudySchema.parse(JSON.parse(JSON.stringify(study)));
    expect(storedSafetyFactorBasis(reread)).toEqual({ strength: "ultimate", allowableStress: 180e6 });
  });

  test("modal and thermal studies have no basis", () => {
    const modal = { ...legacyStudy(), type: "modal_analysis", solverSettings: { modeCount: 3 }, safetyFactorBasis: { strength: "ultimate" } };
    expect(storedSafetyFactorBasis(StudySchema.parse(modal))).toEqual(DEFAULT_SAFETY_FACTOR_BASIS);
  });
});

describe("ultimate strength basis", () => {
  test("is unavailable for every built-in material, with the reason, and a stored ultimate falls back to yield", () => {
    expect(starterMaterials.filter((material) => material.ultimateStrength !== undefined)).toEqual([]);
    const study = withBasis(withMaterial(legacyStudy(), "mat-aluminum-6061"), { strength: "ultimate" });
    const basis = resolveSafetyFactorBasis({ study, unitSystem: "SI" });
    const ultimate = basis.options.find((option) => option.strength === "ultimate");
    expect(ultimate).toMatchObject({ available: false });
    expect(ultimate?.reason).toMatch(/Aluminum 6061 has no ultimate strength on file/);
    expect(basis).toMatchObject({ strength: "yield", factor: 1 });
    expect(basis.fallbackReason).toMatch(/Ultimate strength basis is unavailable/);
  });

  test("re-bases every safety factor by ultimate over yield", () => {
    const study = withBasis(legacyStudy(), { strength: "ultimate" });
    const basis = resolveSafetyFactorBasis({ study, customMaterials: [SHOP_STEEL], unitSystem: "SI" });
    expect(basis).toMatchObject({ strength: "ultimate", shortLabel: "ultimate, von Mises", description: "Ultimate strength (400 MPa) over von Mises stress" });
    expectRelative(basis.factor, 1.6, ROUNDOFF_RELATIVE_TOLERANCE);
    const { summary, fields } = rebaseSafetyFactorResults(legacyFixture.results.summary, legacyFixture.results.fields, basis.factor);
    // Summary min SF = Sy / sigma_max = 2 at 125 MPa; on ultimate it is 400 / 125.
    expectRelative((summary as StructuralResultSummary).safetyFactor, 400 / 125, ROUNDOFF_RELATIVE_TOLERANCE);
    const element = fields.find((field) => field.id === "safety-factor")!;
    expect(element.values[0]).toBe(0);
    expectRelative(element.values[1]!, 6.4, ROUNDOFF_RELATIVE_TOLERANCE);
    expectRelative(element.values[2]!, 3.2, ROUNDOFF_RELATIVE_TOLERANCE);
    expect(element.min).toBe(0);
    expectRelative(element.max, 6.4, ROUNDOFF_RELATIVE_TOLERANCE);
    const surface = fields.find((field) => field.id === "safety-factor-surface")!;
    expect(surface.values[0]).toBe(SAFETY_FACTOR_DISPLAY_CAP);
    expectRelative(surface.values[2]!, 3.2, ROUNDOFF_RELATIVE_TOLERANCE);
    // Stress and the input objects are untouched.
    expect(fields.find((field) => field.id === "stress-surface")).toBe(legacyFixture.results.fields[0]);
    expect(legacyFixture.results.summary.safetyFactor).toBe(2);
  });

  test("rejects an ultimate strength below yield and models with more than one material", () => {
    const low: CustomMaterial = { ...SHOP_STEEL, ultimateStrength: 200e6 };
    const study = withBasis(legacyStudy(), { strength: "ultimate" });
    const lowBasis = resolveSafetyFactorBasis({ study, customMaterials: [low], unitSystem: "SI" });
    expect(lowBasis.options.find((option) => option.strength === "ultimate")?.reason).toMatch(/below its yield strength/);
    expect(lowBasis.strength).toBe("yield");

    const twoBodies: Study = {
      ...study,
      materialAssignments: [
        { id: "a", materialId: SHOP_STEEL.id, selectionRef: "selection-body", bodyId: "step-object-1", parameters: {}, status: "complete" },
        { id: "b", materialId: "mat-aluminum-6061", selectionRef: "selection-body", bodyId: "step-object-2", parameters: {}, status: "complete" }
      ]
    };
    const multi = resolveSafetyFactorBasis({ study: twoBodies, customMaterials: [SHOP_STEEL], unitSystem: "SI" });
    for (const strength of ["ultimate", "allowable"] as const) {
      expect(multi.options.find((option) => option.strength === strength)?.reason).toMatch(/different materials/);
    }
    expect(multi.strength).toBe("yield");
  });

  test("an additive knockdown scales ultimate with yield, so the ratio is the datasheet ratio", () => {
    const pla = starterMaterials.find((material) => material.id === "mat-pla")!;
    const printedPla: CustomMaterial = { ...pla, id: "00000000-0000-4000-8000-0000000000d1", name: "PLA with UTS", category: "plastic", ultimateStrength: 66e6, verification: "user_supplied_unverified" };
    const parameters = { manufacturingProcessId: "fdm", infillDensity: 40, wallCount: 2 };
    const effective = effectiveMaterialProperties(printedPla, parameters);
    expect(effective.yieldStrength).toBeLessThan(printedPla.yieldStrength);
    expectRelative(effective.ultimateStrength! / effective.yieldStrength, 66 / 60, ROUNDOFF_RELATIVE_TOLERANCE);
    const study = withBasis(withMaterial(legacyStudy(), printedPla.id, parameters), { strength: "ultimate" });
    const basis = resolveSafetyFactorBasis({ study, customMaterials: [printedPla], unitSystem: "SI" });
    expectRelative(basis.factor, 66 / 60, ROUNDOFF_RELATIVE_TOLERANCE);

    // The allowable divides by the effective (knocked-down) yield the solver used.
    const allowable = resolveSafetyFactorBasis({ study: withBasis(study, { strength: "allowable", allowableStress: 20e6 }), customMaterials: [printedPla], unitSystem: "SI" });
    expectRelative(allowable.factor, 20e6 / effective.yieldStrength, ROUNDOFF_RELATIVE_TOLERANCE);
  });
});

describe("allowable stress basis", () => {
  test("re-bases by allowable over yield: the minimum becomes allowable over peak stress", () => {
    const study = withBasis(legacyStudy(), { strength: "allowable", allowableStress: 100e6 });
    const basis = resolveSafetyFactorBasis({ study, customMaterials: [SHOP_STEEL], unitSystem: "SI" });
    expect(basis).toMatchObject({ strength: "allowable", allowableStress: 100e6, shortLabel: "allowable 100 MPa, von Mises" });
    expectRelative(basis.factor, 0.4, ROUNDOFF_RELATIVE_TOLERANCE);
    const summary = rebaseSafetyFactorSummary(legacyFixture.results.summary, basis.factor) as StructuralResultSummary;
    expectRelative(summary.safetyFactor, 100 / 125, ROUNDOFF_RELATIVE_TOLERANCE);
    expect(summary.failureAssessment).toBeUndefined();
  });

  test("a safety factor of zero (no stress) stays zero and node values keep the display clamp", () => {
    const zero = rebaseSafetyFactorSummary({ ...legacyFixture.results.summary, safetyFactor: 0 }, 0.4) as StructuralResultSummary;
    expect(zero.safetyFactor).toBe(0);
    const node: ResultField = { id: "sf", runId: "r", type: "safety_factor", location: "node", values: [SAFETY_FACTOR_DISPLAY_CAP, SAFETY_FACTOR_DISPLAY_FLOOR, 0.02, 9000], min: SAFETY_FACTOR_DISPLAY_FLOOR, max: SAFETY_FACTOR_DISPLAY_CAP, units: "ratio" };
    const [scaled] = rebaseSafetyFactorFields([node], 0.4);
    expect(scaled!.values[0]).toBe(SAFETY_FACTOR_DISPLAY_CAP);
    expect(scaled!.values[1]).toBe(SAFETY_FACTOR_DISPLAY_FLOOR);
    expect(scaled!.values[2]).toBe(SAFETY_FACTOR_DISPLAY_FLOOR);
    expectRelative(scaled!.values[3]!, 3600, ROUNDOFF_RELATIVE_TOLERANCE);
    const [up] = rebaseSafetyFactorFields([node], 2);
    expect(up!.values[3]).toBe(SAFETY_FACTOR_DISPLAY_CAP);
  });

  test("an allowable basis without a value falls back to yield", () => {
    const study = legacyStudy();
    // The schema refuses this shape on read; an in-memory study can still hold it mid-edit.
    const unset = { ...study, safetyFactorBasis: { strength: "allowable" } } as Study;
    const basis = resolveSafetyFactorBasis({ study: unset, customMaterials: [SHOP_STEEL], unitSystem: "SI" });
    expect(basis.strength).toBe("yield");
    expect(basis.fallbackReason).toMatch(/allowable stress is not set/);
  });
});

describe("allowable stress units", () => {
  test("SI projects enter MPa and US projects enter ksi; storage is Pa", () => {
    expect(projectStressUnit("SI")).toBe("MPa");
    expect(projectStressUnit("US")).toBe("ksi");
    expect(stressPascalsFromProjectUnits(137.9, "SI")).toBe(137.9e6);
    // 20 ksi is 20,000 psi: the US entry agrees with the psi definition in @openfea/units.
    expectRelative(stressPascalsFromProjectUnits(20, "US"), 20_000 * PASCALS_PER_PSI, ROUNDOFF_RELATIVE_TOLERANCE);
    expectRelative(stressPascalsToProjectUnits(stressPascalsFromProjectUnits(20, "US"), "US"), 20, ROUNDOFF_RELATIVE_TOLERANCE);
    expectRelative(stressPascalsToProjectUnits(137.9e6, "SI"), 137.9, ROUNDOFF_RELATIVE_TOLERANCE);
  });

  test("the same allowable gives the same safety factor whichever unit it was typed in", () => {
    const fromKsi = stressPascalsFromProjectUnits(20, "US");
    const fromMpa = stressPascalsFromProjectUnits(stressPascalsToProjectUnits(fromKsi, "SI"), "SI");
    const study = legacyStudy();
    const us = resolveSafetyFactorBasis({ study: withBasis(study, { strength: "allowable", allowableStress: fromKsi }), customMaterials: [SHOP_STEEL], unitSystem: "US" });
    const si = resolveSafetyFactorBasis({ study: withBasis(study, { strength: "allowable", allowableStress: fromMpa }), customMaterials: [SHOP_STEEL], unitSystem: "SI" });
    expectRelative(us.factor, si.factor, ROUNDOFF_RELATIVE_TOLERANCE);
    expectRelative(us.factor, (20_000 * PASCALS_PER_PSI) / SHOP_STEEL.yieldStrength, ROUNDOFF_RELATIVE_TOLERANCE);
    expect(us.shortLabel).toBe("allowable 20 ksi, von Mises");
    expect(si.shortLabel).toBe("allowable 137.9 MPa, von Mises");
  });
});
