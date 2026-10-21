import { describe, expect, test } from "vitest";
import { StudySchema, type DisplayModel, type Study } from "@openfea/schema";
import type { OpenFEAModelJson } from "@openfea/core";
import { BROWSER_SOLVE_LIMITS, solveStudyModelWithCorePipeline } from "@openfea/solve-pipeline";
import { buildOpenFeaCoreModelForStudy, trySolveOpenFeaCoreStudy } from "./openfeaCoreSolve";

// Local (in-browser) solve of the steel cantilever demo: 180 x 24 x 24 mm, 500 N tip
// load, clamped at x = 0. Compared against Timoshenko beam theory.
const FORCE_N = 500;
const YOUNG = 200e9;
const POISSON = 0.29;
const LENGTH = 0.18;
const SIDE = 0.024;
const INERTIA = (SIDE * SIDE ** 3) / 12;
const SHEAR = YOUNG / (2 * (1 + POISSON));
const TIP_DEFLECTION_MM =
  ((FORCE_N * LENGTH ** 3) / (3 * YOUNG * INERTIA) + (6 * FORCE_N * LENGTH) / (5 * SHEAR * SIDE * SIDE)) * 1000;
const ROOT_BENDING_STRESS_MPA = ((FORCE_N * LENGTH * (SIDE / 2)) / INERTIA) / 1e6;
const DENSITY = 7850; // kg/m^3, mat-steel in @openfea/materials
const AREA = SIDE * SIDE;

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

type StudyCommon = Omit<Extract<Study, { type: "static_stress" }>, "type" | "solverSettings">;

function cantileverStudy(
  type: "static_stress" | "dynamic_structural" | "modal_analysis",
  loadDirection: [number, number, number] = [0, 0, -1]
): Study {
  const common: StudyCommon = {
    id: `study-${type}`,
    projectId: "project-1",
    name: "Cantilever accuracy",
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
    materialAssignments: [{ id: "mat-assignment", materialId: "mat-steel", selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      {
        id: "selection-body",
        name: "Body",
        entityType: "body",
        geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
        fingerprint: "body"
      },
      {
        id: "selection-fixed",
        name: "Fixed face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }],
        fingerprint: "face-fixed"
      },
      {
        id: "selection-load",
        name: "Load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }],
        fingerprint: "face-load"
      }
    ],
    contacts: [],
    constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
    loads: type === "modal_analysis"
      ? []
      : [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: FORCE_N, units: "N", direction: loadDirection }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
    validation: [],
    runs: []
  };
  // Dynamic values are the app's new-study defaults (localProjectFactory.ts), which
  // also equal the adapter's fallbacks for missing fields, so the gate certifies a
  // reachable configuration without changing the solve it ran before.
  const study: Study = type === "static_stress"
    ? { ...common, type, solverSettings: { backend: "opencae_core_local", fidelity: "standard" } }
    : type === "dynamic_structural"
      ? {
          ...common,
          type,
          solverSettings: {
            backend: "opencae_core_local",
            fidelity: "standard",
            startTime: 0,
            endTime: 0.1,
            timeStep: 0.005,
            outputInterval: 0.005,
            dampingRatio: 0.02,
            integrationMethod: "newmark_average_acceleration",
            loadProfile: "ramp"
          }
        }
      : { ...common, type, solverSettings: { backend: "opencae_core_local", fidelity: "standard", modeCount: 1 } };
  // Fail loudly on fixture drift instead of type-casting past it.
  return StudySchema.parse(study);
}

describe("local cantilever accuracy", () => {
  test("static local solve matches Timoshenko beam theory", () => {
    const outcome = trySolveOpenFeaCoreStudy({ study: cantileverStudy("static_stress"), runId: "run-bench", displayModel });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The local backend must preserve its CPU solver identity, browser runner
    // stamp, and solver-surface render mesh rather than the retired preview tier.
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-sparse-tet",
      meshSource: "structured_block_core",
      resultSource: "computed",
      runnerVersion: "browser-0.1.0"
    });
    expect((outcome.result as { surfaceMesh?: { id?: string } }).surfaceMesh?.id).toBe("solver-surface");
    const summary = (outcome.result as { summary?: { maxDisplacement?: number; maxStress?: number; reactionForce?: number } }).summary;
    // eslint-disable-next-line no-console
    console.log(
      `local static [${outcome.solverBackend}]: tip=${summary?.maxDisplacement?.toFixed(4)}mm ` +
      `(theory ${TIP_DEFLECTION_MM.toFixed(4)}, ratio ${((summary?.maxDisplacement ?? 0) / TIP_DEFLECTION_MM).toFixed(3)}) | ` +
      `vm=${summary?.maxStress?.toFixed(2)}MPa (theory ${ROOT_BENDING_STRESS_MPA.toFixed(2)}, ratio ${((summary?.maxStress ?? 0) / ROOT_BENDING_STRESS_MPA).toFixed(3)}) | ` +
      `reaction=${summary?.reactionForce?.toFixed(2)}N`
    );
    // Tip deflection within 3% of Timoshenko theory.
    expect(summary?.maxDisplacement ?? 0).toBeGreaterThan(TIP_DEFLECTION_MM * 0.97);
    expect(summary?.maxDisplacement ?? 0).toBeLessThan(TIP_DEFLECTION_MM * 1.03);
    // Peak von Mises at or above the outer-fiber value (clamped-face concentration), bounded.
    expect(summary?.maxStress ?? 0).toBeGreaterThan(ROOT_BENDING_STRESS_MPA * 0.9);
    expect(summary?.maxStress ?? 0).toBeLessThan(ROOT_BENDING_STRESS_MPA * 1.35);
    // Net reaction balances the applied load (not the sum of per-node magnitudes).
    expect(summary?.reactionForce ?? 0).toBeGreaterThan(FORCE_N - 1);
    expect(summary?.reactionForce ?? 0).toBeLessThan(FORCE_N + 1);
  });

  test("dynamic local ramp lands on the static answer", { timeout: 120000 }, () => {
    const outcome = trySolveOpenFeaCoreStudy({ study: cantileverStudy("dynamic_structural"), runId: "run-bench-dyn", displayModel });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-mdof-tet");
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-mdof-tet",
      resultSource: "computed",
      runnerVersion: "browser-0.1.0"
    });
    const summary = (outcome.result as { summary?: { maxDisplacement?: number; maxStress?: number } }).summary;
    // eslint-disable-next-line no-console
    console.log(
      `local dynamic [${outcome.solverBackend}]: peak=${summary?.maxDisplacement?.toFixed(4)}mm ` +
      `vm=${summary?.maxStress?.toFixed(2)}MPa`
    );
    expect(summary?.maxDisplacement ?? 0).toBeGreaterThan(TIP_DEFLECTION_MM * 0.95);
    expect(summary?.maxDisplacement ?? 0).toBeLessThan(TIP_DEFLECTION_MM * 1.1);
    expect(summary?.maxStress ?? 0).toBeGreaterThan(ROOT_BENDING_STRESS_MPA * 0.9);
    expect(summary?.maxStress ?? 0).toBeLessThan(ROOT_BENDING_STRESS_MPA * 1.35);
  });
});

// Off-axis gates. The load is tilted THETA in the cross-section plane (y-z, normal to
// the beam axis x). The square section has I_y = I_z, so each transverse component
// bends independently with the same Timoshenko compliance and the tip deflection
// magnitude is theta-independent: |delta| = TIP_DEFLECTION_MM. The peak outer-fiber
// stress is not: superposing the two bending moments (Navier) puts
// sigma = M (|sin| + |cos|) c / I at the root corner.
const THETA = Math.PI / 6;
const OBLIQUE_ROOT_STRESS_MPA = ROOT_BENDING_STRESS_MPA * (Math.abs(Math.sin(THETA)) + Math.abs(Math.cos(THETA)));
// Relative tip-deflection difference allowed between the tilted and axis-aligned
// load on the same mesh. The structured Tet10 split is not symmetric under y <-> z,
// so the two bending stiffnesses differ slightly; measured 0.43 % at "medium".
const LOAD_ROTATION_TOLERANCE = 0.01;
// Relative tolerance for a rigid rotation of geometry + load. Physics is exactly
// invariant, so the only slack is the iterative solve (tolerance 1e-10) and
// round-off in the rotated coordinates; measured ~1e-11.
const RIGID_ROTATION_TOLERANCE = 1e-8;

describe("local cantilever off-axis invariance", () => {
  test("tilted tip load keeps the Timoshenko deflection magnitude and the biaxial root stress", () => {
    const aligned = trySolveOpenFeaCoreStudy({ study: cantileverStudy("static_stress"), runId: "run-aligned", displayModel });
    const tilted = trySolveOpenFeaCoreStudy({
      study: cantileverStudy("static_stress", [0, Math.sin(THETA), -Math.cos(THETA)]),
      runId: "run-tilted",
      displayModel
    });
    expect(aligned.ok && tilted.ok).toBe(true);
    if (!aligned.ok || !tilted.ok) return;
    const alignedTip = structuralSummary(aligned.result).maxDisplacement;
    const { maxDisplacement: tip, maxStress: stress, reactionForce } = structuralSummary(tilted.result);
    // eslint-disable-next-line no-console
    console.log(
      `local tilted ${((THETA * 180) / Math.PI).toFixed(0)}deg: tip=${tip.toFixed(4)}mm (aligned ${alignedTip.toFixed(4)}, ` +
      `rel diff ${(Math.abs(tip - alignedTip) / alignedTip).toExponential(2)}) | vm=${stress.toFixed(2)}MPa ` +
      `(theory ${OBLIQUE_ROOT_STRESS_MPA.toFixed(2)}, ratio ${(stress / OBLIQUE_ROOT_STRESS_MPA).toFixed(3)})`
    );
    expect(Math.abs(tip - alignedTip) / alignedTip).toBeLessThan(LOAD_ROTATION_TOLERANCE);
    // Same +/-3 % Timoshenko band and stress band as the axis-aligned gate.
    expect(tip).toBeGreaterThan(TIP_DEFLECTION_MM * 0.97);
    expect(tip).toBeLessThan(TIP_DEFLECTION_MM * 1.03);
    expect(stress).toBeGreaterThan(OBLIQUE_ROOT_STRESS_MPA * 0.9);
    expect(stress).toBeLessThan(OBLIQUE_ROOT_STRESS_MPA * 1.35);
    expect(reactionForce).toBeGreaterThan(FORCE_N - 1);
    expect(reactionForce).toBeLessThan(FORCE_N + 1);
  });

  test("rigidly rotating geometry and load leaves deflection and root stress unchanged", () => {
    const { model } = buildOpenFeaCoreModelForStudy(cantileverStudy("static_stress"), displayModel);
    const rotation = rotationMatrix([1, 2, 3], (37 * Math.PI) / 180);
    const rotated = rotateModel(model, rotation);
    const reference = solveStudyModelWithCorePipeline({ model, analysisType: "static_stress", limits: BROWSER_SOLVE_LIMITS });
    const turned = solveStudyModelWithCorePipeline({ model: rotated, analysisType: "static_stress", limits: BROWSER_SOLVE_LIMITS });
    expect(reference.ok && turned.ok).toBe(true);
    if (!reference.ok || !turned.ok) return;
    const ref = structuralSummary(reference.result);
    const rot = structuralSummary(turned.result);
    // eslint-disable-next-line no-console
    console.log(
      `local rigid rotation: tip rel diff ${(Math.abs(rot.maxDisplacement - ref.maxDisplacement) / ref.maxDisplacement).toExponential(2)} | ` +
      `vm rel diff ${(Math.abs(rot.maxStress - ref.maxStress) / ref.maxStress).toExponential(2)}`
    );
    expect(Math.abs(rot.maxDisplacement - ref.maxDisplacement) / ref.maxDisplacement).toBeLessThan(RIGID_ROTATION_TOLERANCE);
    expect(Math.abs(rot.maxStress - ref.maxStress) / ref.maxStress).toBeLessThan(RIGID_ROTATION_TOLERANCE);
    expect(Math.abs(rot.reactionForce - ref.reactionForce)).toBeLessThan(FORCE_N * RIGID_ROTATION_TOLERANCE);

    // Every surface displacement vector must rotate with the body: u' = R u.
    const refVectors = displacementVectors(reference.result);
    const rotVectors = displacementVectors(turned.result);
    expect(rotVectors.length).toBe(refVectors.length);
    expect(refVectors.length).toBeGreaterThan(0);
    let worst = 0;
    refVectors.forEach((vector, index) => {
      const expected = applyRotation(rotation, vector);
      const actual = rotVectors[index] ?? [Number.NaN, Number.NaN, Number.NaN];
      worst = Math.max(worst, Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]));
    });
    expect(worst / ref.maxDisplacement).toBeLessThan(RIGID_ROTATION_TOLERANCE);
  });
});

// First bending frequency of the clamped-free benchmark cantilever (s = 24 mm square,
// L = 180 mm, E = 200 GPa, nu = 0.29, rho = 7850 kg/m^3).
// Euler-Bernoulli: f1 = (beta1 L)^2 / (2 pi L^2) * sqrt(E I / (rho A)), beta1 L = 1.875104
//   -> 603.99 Hz (plan 012's ~604 Hz).
// At L/s = 7.5 shear flexibility and rotary inertia are material (-1.4 %), so the gate
// uses the Timoshenko root (shear coefficient 5/6, as in the static oracle):
//   -> 595.68 Hz.
const EULER_BERNOULLI_F1_HZ = (1.875104068711961 ** 2 / (2 * Math.PI * LENGTH ** 2)) * Math.sqrt((YOUNG * INERTIA) / (DENSITY * AREA));
const TIMOSHENKO_F1_HZ = timoshenkoCantileverFirstFrequencyHz();
// Medium Tet10 mesh: the static gate on the same mesh is +/-3 % on stiffness; f ~ sqrt(k/m)
// halves that, plus slack for the 3-D vs beam-theory section kinematics. Measured +0.69 %.
const FREQUENCY_TOLERANCE = 0.02;

describe("local cantilever modal accuracy", () => {
  test("first bending frequency matches the Timoshenko cantilever", { timeout: 120000 }, () => {
    const outcome = trySolveOpenFeaCoreStudy({ study: cantileverStudy("modal_analysis"), runId: "run-bench-modal", displayModel });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-modal-tet");
    const modes = (outcome.result.summary as { modes?: Array<{ frequencyHz: number }> }).modes ?? [];
    const f1 = modes[0]?.frequencyHz ?? 0;
    // eslint-disable-next-line no-console
    console.log(
      `local modal: f1=${f1.toFixed(2)}Hz (Timoshenko ${TIMOSHENKO_F1_HZ.toFixed(2)}, ratio ${(f1 / TIMOSHENKO_F1_HZ).toFixed(4)}; ` +
      `Euler-Bernoulli ${EULER_BERNOULLI_F1_HZ.toFixed(2)})`
    );
    expect(Math.abs(f1 - TIMOSHENKO_F1_HZ) / TIMOSHENKO_F1_HZ).toBeLessThan(FREQUENCY_TOLERANCE);
  });
});

/**
 * Lowest root of the clamped-free Timoshenko beam frequency equation (SI units).
 * w = A1 cosh(ax) + A2 sinh(ax) + A3 cos(bx) + A4 sin(bx) with the matching rotation
 * field; BCs w = psi = 0 at x = 0, EI psi' = 0 and kGA (w' - psi) = 0 at x = L.
 * Bisection on det of the 4x4 BC matrix between 0.8 f_EB and f_EB (Timoshenko is
 * always below Euler-Bernoulli). Valid below the shear cutoff sqrt(kGA / (rho I)).
 */
function timoshenkoCantileverFirstFrequencyHz(): number {
  const kGA = (5 / 6) * SHEAR * AREA;
  const EI = YOUNG * INERTIA;
  const determinant = (omega: number): number => {
    const w2 = omega * omega;
    // kGA EI l^4 + rho w^2 (I kGA + A EI) l^2 + rho A w^2 (rho I w^2 - kGA) = 0, in l^2.
    const qa = kGA * EI;
    const qb = DENSITY * w2 * (INERTIA * kGA + AREA * EI);
    const qc = DENSITY * AREA * w2 * (DENSITY * INERTIA * w2 - kGA);
    const disc = Math.sqrt(qb * qb - 4 * qa * qc);
    const a = Math.sqrt((-qb + disc) / (2 * qa));
    const b = Math.sqrt((qb + disc) / (2 * qa));
    const c = (DENSITY * AREA * w2) / kGA;
    const pa = a + c / a;
    const pb = b - c / b;
    const [ch, sh, co, si] = [Math.cosh(a * LENGTH), Math.sinh(a * LENGTH), Math.cos(b * LENGTH), Math.sin(b * LENGTH)];
    return det4([
      [1, 0, 1, 0],
      [0, pa, 0, pb],
      [pa * a * ch, pa * a * sh, -pb * b * co, -pb * b * si],
      [sh / a, ch / a, si / b, -co / b]
    ]);
  };
  let lo = 2 * Math.PI * EULER_BERNOULLI_F1_HZ * 0.8;
  let hi = 2 * Math.PI * EULER_BERNOULLI_F1_HZ;
  const loSign = Math.sign(determinant(lo));
  if (loSign === Math.sign(determinant(hi))) throw new Error("Timoshenko root not bracketed.");
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const mid = (lo + hi) / 2;
    if (Math.sign(determinant(mid)) === loSign) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / (4 * Math.PI);
}

function det4(m: number[][]): number {
  const det3 = (n: number[][]): number =>
    n[0]![0]! * (n[1]![1]! * n[2]![2]! - n[1]![2]! * n[2]![1]!) -
    n[0]![1]! * (n[1]![0]! * n[2]![2]! - n[1]![2]! * n[2]![0]!) +
    n[0]![2]! * (n[1]![0]! * n[2]![1]! - n[1]![1]! * n[2]![0]!);
  let total = 0;
  for (let column = 0; column < 4; column += 1) {
    const minor = m.slice(1).map((row) => row.filter((_, index) => index !== column));
    total += (column % 2 === 0 ? 1 : -1) * m[0]![column]! * det3(minor);
  }
  return total;
}

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];
type Vec3 = [number, number, number];

// Rodrigues rotation about an arbitrary (normalized) axis.
function rotationMatrix(axis: Vec3, angle: number): Mat3 {
  const length = Math.hypot(...axis);
  const [x, y, z] = axis.map((value) => value / length) as Vec3;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c]
  ];
}

function applyRotation(r: Mat3, v: readonly number[]): Vec3 {
  const [x = 0, y = 0, z = 0] = v;
  return [
    r[0][0] * x + r[0][1] * y + r[0][2] * z,
    r[1][0] * x + r[1][1] * y + r[1][2] * z,
    r[2][0] * x + r[2][1] * y + r[2][2] * z
  ];
}

function rotateModel(model: OpenFEAModelJson, r: Mat3): OpenFEAModelJson {
  const coordinates = model.nodes.coordinates;
  const rotatedCoordinates: number[] = [];
  for (let index = 0; index < coordinates.length; index += 3) {
    rotatedCoordinates.push(...applyRotation(r, coordinates.slice(index, index + 3)));
  }
  const loads = model.loads.map((load) => {
    if (load.type !== "surfaceForce") throw new Error(`Unexpected cantilever load type ${load.type}.`);
    return { ...load, totalForce: applyRotation(r, load.totalForce) };
  });
  return {
    ...model,
    nodes: { coordinates: rotatedCoordinates },
    surfaceFacets: model.surfaceFacets?.map((facet) => ({
      ...facet,
      ...(facet.normal ? { normal: applyRotation(r, facet.normal) } : {}),
      ...(facet.center ? { center: applyRotation(r, facet.center) } : {})
    })),
    loads
  };
}

function structuralSummary(result: { summary: unknown }): { maxDisplacement: number; maxStress: number; reactionForce: number } {
  const summary = result.summary as { maxDisplacement?: number; maxStress?: number; reactionForce?: number };
  return {
    maxDisplacement: summary.maxDisplacement ?? Number.NaN,
    maxStress: summary.maxStress ?? Number.NaN,
    reactionForce: summary.reactionForce ?? Number.NaN
  };
}

function displacementVectors(result: unknown): Vec3[] {
  const fields = (result as { fields?: Array<{ type?: string; vectors?: Vec3[] }> }).fields ?? [];
  return fields.find((field) => field.type === "displacement" && Array.isArray(field.vectors))?.vectors ?? [];
}
