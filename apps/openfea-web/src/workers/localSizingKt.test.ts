// Plan 036 R2.2 gate: local sizing on the hole wall improves the
// plate-with-hole Kt error at equal total DOF versus uniform refinement.
//
// Same geometry and oracle as the plan 013 benchmark (plateWithHoleKt.test.ts
// and the Validation gallery entry): W = 60, L = 120, t = 6, d = 15 mm, so
// d/W = 0.25 and the Heywood/Howland net-section fit gives
// Kt_net = 2 + (1 - d/W)^3 = 2.422. Unlike that benchmark (a .geo script
// with a hand-written MathEval field), this one runs the PRODUCTION STEP
// path: an OCC-exported STEP, the occt-import-js face registry, the persisted
// local-size rule resolved by B-rep face id + fingerprint, the pre-mesh DOF
// preflight, meshStepToMshV2 with Distance + Threshold fields, facet
// attribution, the Core model build and the browser solve pipeline.
//
// Compared quantity: the plane-stress oracle describes the hole-edge hoop
// stress averaged through the thickness (generalized plane stress), so that
// is what is measured; see holeEdgeHoopStress. The raw 3D peaks are logged
// for context only.
import { beforeAll, describe, expect, it } from "vitest";
import {
  attributeFacetsToStepFaces,
  buildCoreModelFromCloudMesh,
  enforceWasmMeshQualityGate,
  generateBoxWithBoreStep,
  meshStepToMshV2,
  parseGmshMeshToCoreVolumeMesh,
  type SelectionMappingDiagnostic
} from "@openfea/mesh-intake";
import { BROWSER_SOLVE_LIMITS, solveStudyModelWithCorePipeline } from "@openfea/solve-pipeline";
import type { MeshLocalSize, Study } from "@openfea/schema";
import { buildStepFaceRegistry, stepAttributionForRegistry, type StepFaceRecord, type StepFaceRegistry } from "../stepFaces";
import { meshLocalSizeForFace, planMeshLocalSizing } from "../meshLocalSizing";
import { studyForCoreGeometryDispatch } from "./openfeaCoreSolve";
import { stepProofScenario } from "./stepProofScenario";

const PLATE = { lengthMm: 120, widthMm: 60, thicknessMm: 6, holeDiameterMm: 15 };
const APPLIED_FORCE_N = 1000;
const D_OVER_W = PLATE.holeDiameterMm / PLATE.widthMm;
/** Heywood/Howland net-section fit: Kt_net ≈ 2 + (1 - d/W)^3. */
const KT_NET_ORACLE = 2 + (1 - D_OVER_W) ** 3;
const SIGMA_NET_MPA = APPLIED_FORCE_N / ((PLATE.widthMm - PLATE.holeDiameterMm) * PLATE.thicknessMm);
/** "Equal total DOF": the two meshes compared differ by at most 10%. */
const EQUAL_DOF_TOLERANCE = 0.1;
const REACTION_TOLERANCE = 0.01;
/** The compared pair: a uniform preset-style size, and a coarser global size with the hole wall refined. */
const UNIFORM_SIZE_MM = 3.8;
const LOCAL_GLOBAL_SIZE_MM = 6;
const LOCAL_SIZE_MM = 1;
/** The θ = ±90° lines must cross the hole wall over (nearly) the full thickness on both sides. */
const MIN_HOLE_EDGE_COVERAGE = 0.95;
/** Guard that the refined answer is close in absolute terms, not only better than uniform. */
const LOCAL_KT_ERROR_CEILING = 0.03;
/** The pre-mesh estimate's stated band (localSizing.ts). */
const ESTIMATE_RELATIVE_TOLERANCE = 0.3;
/** Surface nodes within 2% of the hole radius belong to the hole wall. */
const HOLE_WALL_RADIAL_TOLERANCE = 0.02;

type SurfaceMesh = { nodes: [number, number, number][]; triangles: [number, number, number][] };

/**
 * Hole-edge hoop stress the plane-stress Kt describes. At θ = ±90° (the
 * points of the hole wall on the line x = x_hole, normal to the load) the hoop
 * stress is σxx. Its average through the thickness is what generalized plane
 * stress — and so the analytical Kt — predicts; the 3D midplane peak runs a
 * few percent higher and the free faces lower. The surface nodal σxx is
 * interpolated linearly along every hole-wall triangle edge the line crosses
 * and integrated over z on both sides of the hole.
 */
function holeEdgeHoopStress(mesh: SurfaceMesh, field: { values: number[]; tensorValues?: number[] }) {
  const scale = Math.max(...mesh.nodes.map((node) => node[0])) > 1 ? 1 : 1000;
  const p = mesh.nodes.map((node) => node.map((value) => value * scale) as [number, number, number]);
  const radius = PLATE.holeDiameterMm / 2;
  const cx = PLATE.lengthMm / 2;
  const cy = PLATE.widthMm / 2;
  const onWall = p.map((node) => Math.abs(Math.hypot(node[0] - cx, node[1] - cy) - radius) < HOLE_WALL_RADIAL_TOLERANCE * radius);
  const tensor = field.tensorValues!;
  const sxx = (node: number) => tensor[node * 6]!;
  let peakVonMises = 0;
  p.forEach((_node, index) => {
    if (onWall[index]) peakVonMises = Math.max(peakVonMises, field.values[index]!);
  });
  let integral = 0;
  let length = 0;
  for (const triangle of mesh.triangles) {
    if (!triangle.every((node) => onWall[node])) continue;
    // Points where the triangle's edges cross the plane x = cx.
    const crossings: Array<{ z: number; y: number; value: number }> = [];
    for (let edge = 0; edge < 3; edge += 1) {
      const a = triangle[edge]!;
      const b = triangle[(edge + 1) % 3]!;
      const da = p[a]![0] - cx;
      const db = p[b]![0] - cx;
      if (da === db || da * db > 0) continue;
      const t = da / (da - db);
      crossings.push({ z: p[a]![2] + t * (p[b]![2] - p[a]![2]), y: p[a]![1] + t * (p[b]![1] - p[a]![1]), value: sxx(a) + t * (sxx(b) - sxx(a)) });
    }
    if (crossings.length < 2) continue;
    const [first, second] = crossings as [typeof crossings[number], typeof crossings[number]];
    const dz = Math.abs(second.z - first.z);
    integral += dz * (first.value + second.value) / 2;
    length += dz;
  }
  return { thicknessAveragedHoop: integral / length, coverage: length / (2 * PLATE.thicknessMm), peakVonMises };
}

type KtRun = {
  label: string;
  dofs: number;
  elements: number;
  elementType: string;
  /** Thickness-averaged hole-edge hoop stress over the net-section stress. */
  kt: number;
  ktError: number;
  holeEdgeCoverage: number;
  /** Context only: the 3D peak on the hole wall and the raw element peak (anywhere). */
  peakHoleVonMisesKt: number;
  rawElementPeakKt: number;
  reaction: number;
  estimatedDofs?: number;
  appliedLocalSizes: number;
};

describe("plate-with-hole Kt: local hole-wall sizing vs uniform refinement at equal DOF (plan 036 R2.2)", () => {
  let stepText: string;
  let registry: StepFaceRegistry;
  let holeWall: StepFaceRecord;

  beforeAll(async () => {
    stepText = await generateBoxWithBoreStep({ x: PLATE.lengthMm, y: PLATE.widthMm, z: PLATE.thicknessMm, boreDiameter: PLATE.holeDiameterMm });
    const { default: occtimportjs } = await import("occt-import-js");
    const occt = await occtimportjs();
    const imported = occt.ReadStepFile(new TextEncoder().encode(stepText), null);
    expect(imported.success).toBe(true);
    registry = buildStepFaceRegistry(imported.meshes ?? []);
    holeWall = registry.faces.find((face) => face.cylinder?.interior)!;
    expect(holeWall).toBeDefined();
  }, 120_000);

  async function runKt(label: string, globalSizeMm: number, localSizes: MeshLocalSize[] = []): Promise<KtRun> {
    const contentBase64 = Buffer.from(stepText, "utf8").toString("base64");
    const scenario = stepProofScenario(registry, { filename: "plate-with-hole.step", contentBase64 });
    const loadFace = registry.faces.reduce((best, face) => (face.avgNormal[0] > best.avgNormal[0] ? face : best));
    const study: Study = {
      ...scenario.study,
      namedSelections: scenario.study.namedSelections.map((selection) => selection.id === "selection-step-proof-load"
        ? { ...selection, name: loadFace.faceId, geometryRefs: [{ ...selection.geometryRefs[0]!, entityId: loadFace.faceId }], fingerprint: loadFace.fingerprint }
        : selection),
      loads: scenario.study.loads.map((load) => ({ ...load, parameters: { ...load.parameters, value: APPLIED_FORCE_N, direction: [1, 0, 0] } })),
      meshSettings: { preset: "medium", status: "not_started", ...(localSizes.length ? { localSizing: localSizes } : {}) }
    };

    const plan = planMeshLocalSizing({
      rules: study.meshSettings.localSizing,
      registry,
      globalSizeMm,
      elementOrder: 2,
      maxDofs: BROWSER_SOLVE_LIMITS.maxDofs
    });
    if (plan) {
      expect(plan.unresolved).toEqual([]);
      expect(plan.preflight.status).toBe("ok");
    }
    const meshed = await meshStepToMshV2(stepText, { elementOrder: 2, meshSizeMm: globalSizeMm, ...(plan ? { localSizing: plan.targets } : {}) });
    const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm", diagnostics: [`R2.2 Kt ${label}`] });
    enforceWasmMeshQualityGate(artifact, meshed.qualityMinSICN, "R2.2 Kt benchmark");
    attributeFacetsToStepFaces(artifact, stepAttributionForRegistry(registry));
    const dispatchStudy = studyForCoreGeometryDispatch(study, scenario.displayModel);
    const mappingDiagnostics: SelectionMappingDiagnostic[] = [];
    const elementOrder = artifact.elements[0]?.type === "Tet10" ? 2 : 1;
    const model = buildCoreModelFromCloudMesh({
      study: {
        id: dispatchStudy.id,
        type: "static_stress",
        materialAssignments: dispatchStudy.materialAssignments,
        namedSelections: dispatchStudy.namedSelections,
        constraints: dispatchStudy.constraints,
        loads: dispatchStudy.loads,
        solverSettings: dispatchStudy.solverSettings as Record<string, unknown>
      },
      displayModel: scenario.displayModel,
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: { elementOrder },
      mappingDiagnostics
    });
    expect(mappingDiagnostics.map((diagnostic) => diagnostic.mode).every((mode) => mode === "bySelection" || mode === "byFace")).toBe(true);
    const outcome = solveStudyModelWithCorePipeline({ model, analysisType: "static_stress", solverSettings: { elementOrder }, limits: BROWSER_SOLVE_LIMITS });
    expect(outcome.ok, outcome.ok ? undefined : JSON.stringify(outcome.error)).toBe(true);
    if (!outcome.ok) throw new Error("solve failed");
    const res = outcome.result as unknown as {
      summary: { maxStress: number; reactionForce: number };
      surfaceMesh: SurfaceMesh;
      fields: Array<{ id: string; values: number[]; tensorValues?: number[] }>;
    };
    const hole = holeEdgeHoopStress(res.surfaceMesh, res.fields.find((field) => field.id === "stress-surface")!);
    const kt = hole.thicknessAveragedHoop / SIGMA_NET_MPA;
    const run: KtRun = {
      label,
      dofs: artifact.metadata.nodeCount * 3,
      elements: artifact.metadata.elementCount,
      elementType: artifact.elements[0]?.type ?? "none",
      kt,
      ktError: Math.abs(kt - KT_NET_ORACLE) / KT_NET_ORACLE,
      holeEdgeCoverage: hole.coverage,
      peakHoleVonMisesKt: hole.peakVonMises / SIGMA_NET_MPA,
      rawElementPeakKt: res.summary.maxStress / SIGMA_NET_MPA,
      reaction: res.summary.reactionForce,
      ...(plan ? { estimatedDofs: plan.preflight.estimatedDofs } : {}),
      appliedLocalSizes: meshed.localSizing?.applied.length ?? 0
    };
    const round = (value: number) => Number(value.toFixed(4));
    console.log(`[R2.2 Kt] ${JSON.stringify({ ...run, kt: round(kt), ktErrorPercent: round(run.ktError * 100), peakHoleVonMisesKt: round(run.peakHoleVonMisesKt), rawElementPeakKt: round(run.rawElementPeakKt), oracle: round(KT_NET_ORACLE) })}`);
    return run;
  }

  it("GATE: local hole-wall sizing has a smaller Kt error than uniform refinement at equal DOF (±10%)", { timeout: 1_800_000 }, async () => {
    const uniform = await runKt(`uniform ${UNIFORM_SIZE_MM} mm`, UNIFORM_SIZE_MM);
    const local = await runKt(
      `local ${LOCAL_SIZE_MM} mm on the hole wall, ${LOCAL_GLOBAL_SIZE_MM} mm elsewhere`,
      LOCAL_GLOBAL_SIZE_MM,
      [meshLocalSizeForFace({ id: holeWall.faceId, label: "Hole wall" }, LOCAL_SIZE_MM, registry, "local-size-hole")]
    );
    for (const run of [uniform, local]) {
      expect(run.elementType).toBe("Tet10");
      expect(Math.abs(run.reaction - APPLIED_FORCE_N) / APPLIED_FORCE_N).toBeLessThanOrEqual(REACTION_TOLERANCE);
      expect(run.holeEdgeCoverage).toBeGreaterThan(MIN_HOLE_EDGE_COVERAGE);
    }
    expect(uniform.appliedLocalSizes).toBe(0);
    expect(local.appliedLocalSizes).toBe(1);
    expect(Math.abs(local.dofs / uniform.dofs - 1)).toBeLessThanOrEqual(EQUAL_DOF_TOLERANCE);
    expect(local.ktError).toBeLessThan(uniform.ktError);
    expect(local.ktError).toBeLessThan(LOCAL_KT_ERROR_CEILING);
    // The pre-mesh preflight estimate stayed in its stated band for the refined mesh.
    expect(Math.abs(local.estimatedDofs! / local.dofs - 1)).toBeLessThan(ESTIMATE_RELATIVE_TOLERANCE);
  });
});
