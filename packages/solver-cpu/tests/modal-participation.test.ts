import { describe, expect, test } from "vitest";
import { normalizeModelJson, validateCoreResult, type OpenFEAModelJson } from "@openfea/core";
import { singleTetStaticFixture } from "@openfea/examples";
import { modalMassParticipation, solveModalLinearTet, solveModalSubspace } from "../src";
import { prepareStructuralSystem } from "../src/structural-system";
import { createStructuredCantileverModel } from "./helpers";

// Sums and ratios are built from the same lumped diagonal, so they agree to
// roundoff; mode-shape quantities inherit the 1e-6 modal residual tolerance.
const ROUNDOFF_RELATIVE_TOLERANCE = 1e-9;
const MODAL_RESIDUAL_RELATIVE_TOLERANCE = 1e-5;
// Uniform Euler–Bernoulli cantilever, first bending mode: m_eff / m = 0.6131.
const EULER_BERNOULLI_FIRST_MODE_FRACTION = 0.6131;
// 24 axial Tet4 divisions with lumped mass: the effective-mass fraction
// converges from below (0.5999 → 0.6089 → 0.6099 for 10 → 20 → 40 divisions
// on a 4×2 section), and the shape error, root-mass exclusion and the 2.5:1
// section's shear and Poisson effects each stay well under 1% of the mass.
const CANTILEVER_FRACTION_TOLERANCE = 0.01;

function cantileverModal(modeCount: number, xDivisions = 24): OpenFEAModelJson {
  const base = createStructuredCantileverModel({ length: 1, width: 0.1, height: 0.04, force: 1, xDivisions, yDivisions: 2, zDivisions: 1 });
  return { ...base, loads: [], steps: [{ name: "modes", type: "modal", boundaryConditions: ["fixedSupport"], modeCount }] };
}

const tinyModal: OpenFEAModelJson = {
  ...singleTetStaticFixture,
  schemaVersion: "0.3.0",
  materials: [{ ...singleTetStaticFixture.materials[0], density: 1200 }],
  loads: [],
  steps: [{
    name: "modes",
    type: "modal",
    boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
    modeCount: 10
  }]
};

function expectRelativeClose(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(Math.abs(expected), Number.MIN_VALUE));
}

describe("modal mass participation", () => {
  test("first cantilever bending mode carries the Euler–Bernoulli effective-mass fraction", () => {
    const solved = solveModalLinearTet(cantileverModal(2));
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;
    const participation = solved.result.massParticipation!;
    expect(participation.massUnits).toBe("kg");
    expect(participation.computedOnProjectedModel).toBe(false);
    // Thin direction is Z, so mode 1 bends in Z and mode 2 in Y.
    const [first, second] = participation.modes;
    expect(Math.abs(first.effectiveMassRatio[2] - EULER_BERNOULLI_FIRST_MODE_FRACTION)).toBeLessThanOrEqual(CANTILEVER_FRACTION_TOLERANCE);
    expect(Math.abs(second.effectiveMassRatio[1] - EULER_BERNOULLI_FIRST_MODE_FRACTION)).toBeLessThanOrEqual(CANTILEVER_FRACTION_TOLERANCE);
    expect(first.effectiveMassRatio[0]).toBeLessThan(CANTILEVER_FRACTION_TOLERANCE);
    expectRelativeClose(participation.totalMass, 2700 * 1 * 0.1 * 0.04, ROUNDOFF_RELATIVE_TOLERANCE);
    // Γ follows the exported shape's sign: Γ_d = Σ m φ_d over the shape's own d components.
    const shape = solved.result.modes[0].shape;
    let shapeZSum = 0;
    for (let node = 0; node < shape.length / 3; node += 1) shapeZSum += shape[node * 3 + 2];
    expect(Math.sign(first.participationFactor[2])).toBe(Math.sign(shapeZSum));
    const summary = solved.result.coreResult!;
    expect(summary.summary.massParticipation).toEqual(participation);
    expect(validateCoreResult(summary).ok).toBe(true);
  });

  test("cumulative effective mass of a lightly supported block approaches the total mass", () => {
    // A stiff squat block on a soft first-layer pad: the lowest modes are its
    // near-rigid translations on the pad, which carry almost all translational
    // mass; only the pad's own deformation and the fixed-face mass stay out.
    const xDivisions = 5;
    const block = createStructuredCantileverModel({ length: 0.05, width: 0.2, height: 0.2, force: 1, xDivisions, yDivisions: 2, zDivisions: 2 });
    const base: OpenFEAModelJson = { ...block, loads: [], steps: [{ name: "modes", type: "modal", boundaryConditions: ["fixedSupport"], modeCount: 6 }] };
    const connectivity = base.elementBlocks[0].connectivity;
    const coordinates = base.nodes.coordinates;
    const padElements: number[] = [];
    const blockElements: number[] = [];
    for (let offset = 0; offset < connectivity.length; offset += 4) {
      const centroidX = [0, 1, 2, 3].reduce((sum, local) => sum + coordinates[connectivity[offset + local] * 3], 0) / 4;
      (centroidX < 0.05 / xDivisions ? padElements : blockElements).push(...connectivity.slice(offset, offset + 4));
    }
    const pad = { ...base.materials[0], name: "pad", youngModulus: base.materials[0].youngModulus * 1e-4 };
    const model: OpenFEAModelJson = {
      ...base,
      materials: [base.materials[0], pad],
      elementBlocks: [
        { name: "pad", type: "Tet4", material: "pad", connectivity: padElements },
        { name: "block", type: "Tet4", material: base.materials[0].name, connectivity: blockElements }
      ],
      elementSets: []
    };
    const solved = solveModalLinearTet(model);
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;
    const participation = solved.result.massParticipation!;
    const cumulative = participation.modes.at(-1)!.cumulativeEffectiveMassRatio;
    for (let direction = 0; direction < 3; direction += 1) {
      const ceiling = participation.unconstrainedMass[direction] / participation.totalMass;
      expect(cumulative[direction]).toBeGreaterThan(0.95 * ceiling);
      expect(cumulative[direction]).toBeLessThanOrEqual(ceiling * (1 + ROUNDOFF_RELATIVE_TOLERANCE));
    }
  });

  test("effective mass summed over every mode equals the unconstrained mass on a tiny model", () => {
    const solved = solveModalLinearTet(tinyModal);
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;
    expect(solved.result.modes).toHaveLength(solved.diagnostics.freeDofs);
    const participation = solved.result.massParticipation!;
    expectRelativeClose(participation.totalMass, 200, ROUNDOFF_RELATIVE_TOLERANCE);

    const normalized = normalizeModelJson(tinyModal);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const prepared = prepareStructuralSystem(normalized.model, tinyModal.steps[0].boundaryConditions, [], undefined, "Modal");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const constrainedMass = [0, 0, 0];
    for (const dof of prepared.system.constraints.keys()) constrainedMass[dof % 3] += prepared.system.fullMass[dof];

    const last = participation.modes.at(-1)!;
    for (let direction = 0; direction < 3; direction += 1) {
      const sum = participation.modes.reduce((total, mode) => total + mode.effectiveMass[direction], 0);
      expectRelativeClose(sum, participation.unconstrainedMass[direction], MODAL_RESIDUAL_RELATIVE_TOLERANCE);
      expectRelativeClose(participation.unconstrainedMass[direction] + constrainedMass[direction], participation.totalMass, ROUNDOFF_RELATIVE_TOLERANCE);
      expectRelativeClose(last.cumulativeEffectiveMassRatio[direction], participation.unconstrainedMass[direction] / participation.totalMass, MODAL_RESIDUAL_RELATIVE_TOLERANCE);
    }
  });

  test("effective mass is invariant to eigenvector sign and mass-normalization scale", () => {
    const normalized = normalizeModelJson(tinyModal);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const prepared = prepareStructuralSystem(normalized.model, tinyModal.steps[0].boundaryConditions, [], undefined, "Modal");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const solved = solveModalSubspace(prepared.system, 10);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const shared = { mass: prepared.system.mass, free: prepared.system.free, totalMass: prepared.system.totalMass, massUnits: "kg" as const, computedOnProjectedModel: false };
    const reference = modalMassParticipation({ ...shared, modes: solved.modes });
    const rescaled = modalMassParticipation({
      ...shared,
      modes: solved.modes.map((mode, index) => ({
        modeIndex: mode.modeIndex,
        vector: mode.vector.map((value) => value * (index % 2 === 0 ? -3.7 : 0.021))
      }))
    });
    reference.modes.forEach((mode, index) => {
      const scaled = rescaled.modes[index];
      for (let direction = 0; direction < 3; direction += 1) {
        expectRelativeClose(scaled.effectiveMass[direction], mode.effectiveMass[direction], ROUNDOFF_RELATIVE_TOLERANCE);
        expectRelativeClose(scaled.cumulativeEffectiveMassRatio[direction], mode.cumulativeEffectiveMassRatio[direction], ROUNDOFF_RELATIVE_TOLERANCE);
        const sign = index % 2 === 0 ? -1 : 1;
        expectRelativeClose(scaled.participationFactor[direction], sign * mode.participationFactor[direction], ROUNDOFF_RELATIVE_TOLERANCE);
      }
    });
  });

  test("reports equivalent participation in m-N-s-Pa and mm-N-s-MPa solver units", () => {
    const meterModel = cantileverModal(2);
    const millimeterModel: OpenFEAModelJson = {
      ...meterModel,
      coordinateSystem: { solverUnits: "mm-N-s-MPa", renderCoordinateSpace: "solver" },
      nodes: { coordinates: meterModel.nodes.coordinates.map((coordinate) => coordinate * 1_000) },
      materials: meterModel.materials.map((material) => ({
        ...material,
        youngModulus: material.youngModulus / 1_000_000,
        yieldStrength: material.yieldStrength === undefined ? undefined : material.yieldStrength / 1_000_000,
        density: (material.density ?? 0) / 1e12
      }))
    };
    const meter = solveModalLinearTet(meterModel);
    const millimeter = solveModalLinearTet(millimeterModel);
    expect(meter.ok && millimeter.ok).toBe(true);
    if (!meter.ok || !millimeter.ok) return;
    const si = meter.result.massParticipation!;
    const mm = millimeter.result.massParticipation!;
    expect(si.massUnits).toBe("kg");
    expect(mm.massUnits).toBe("t");
    const KILOGRAMS_PER_TONNE = 1_000;
    expectRelativeClose(mm.totalMass * KILOGRAMS_PER_TONNE, si.totalMass, ROUNDOFF_RELATIVE_TOLERANCE);
    si.modes.forEach((mode, index) => {
      for (let direction = 0; direction < 3; direction += 1) {
        const tolerance = MODAL_RESIDUAL_RELATIVE_TOLERANCE * si.totalMass;
        expect(Math.abs(mm.modes[index].effectiveMass[direction] * KILOGRAMS_PER_TONNE - mode.effectiveMass[direction])).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(mm.modes[index].effectiveMassRatio[direction] - mode.effectiveMassRatio[direction])).toBeLessThanOrEqual(MODAL_RESIDUAL_RELATIVE_TOLERANCE);
      }
    });
  });

  test("core validation accepts results without participation and rejects inconsistent participation", () => {
    const solved = solveModalLinearTet(cantileverModal(2, 8));
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const result = solved.result.coreResult!;
    const { massParticipation, ...legacySummary } = result.summary;
    expect(massParticipation).toBeDefined();
    expect(validateCoreResult({ ...result, summary: legacySummary }).ok).toBe(true);

    const mismatched = validateCoreResult({ ...result, summary: { ...result.summary, massParticipation: { ...massParticipation!, modes: massParticipation!.modes.slice(1) } } });
    expect(mismatched.errors.map((error) => error.code)).toContain("mass-participation-mode-mismatch");
    const nonFinite = validateCoreResult({
      ...result,
      summary: {
        ...result.summary,
        massParticipation: {
          ...massParticipation!,
          modes: massParticipation!.modes.map((mode) => ({ ...mode, effectiveMass: [Number.NaN, 0, 0] as [number, number, number] }))
        }
      }
    });
    expect(nonFinite.errors.map((error) => error.code)).toContain("invalid-mass-participation-mode");
  });
});
