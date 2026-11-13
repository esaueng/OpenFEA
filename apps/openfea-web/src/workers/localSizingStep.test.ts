// Plan 036 R2.2: the browser local sizing proof (meshHarness.ts
// ?meshProof=localsizing) run in Node on the same corpus fixture, so its gate
// is exercised by `pnpm test` before the headless-Chrome run.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { meshStepToMshV2, parseGmshMeshToCoreVolumeMesh } from "@openfea/mesh-intake";
import { BROWSER_SOLVE_LIMITS } from "@openfea/solve-pipeline/limits";
import { buildStepFaceRegistry, type StepFaceRegistry } from "../stepFaces";
import { meshLocalSizeForFace, planMeshLocalSizing } from "../meshLocalSizing";

const fixtureUrl = new URL("../../../../libs/openfea-mesh-intake/fixtures/box-with-bore.step", import.meta.url);
/** Same sizes and band as the browser proof gate (localSizingProofPasses). */
const GLOBAL_MM = 6;
const LOCAL_MM = 1.5;
const ESTIMATE_BAND = { min: 0.7, max: 1.3 };

describe("local sizing on a STEP bore wall (Node mirror of the browser proof)", () => {
  let stepText: string;
  let registry: StepFaceRegistry;

  beforeAll(async () => {
    stepText = readFileSync(fixtureUrl, "utf8");
    const { default: occtimportjs } = await import("occt-import-js");
    const occt = await occtimportjs();
    const imported = occt.ReadStepFile(new TextEncoder().encode(stepText), null);
    registry = buildStepFaceRegistry(imported.meshes ?? []);
  }, 120_000);

  it("resolves the rule, passes the preflight, reaches gmsh and refines the bore", { timeout: 300_000 }, async () => {
    const bore = registry.faces.find((face) => face.cylinder?.interior)!;
    expect(bore).toBeDefined();
    const plan = planMeshLocalSizing({
      rules: [meshLocalSizeForFace({ id: bore.faceId, label: "Bore wall" }, LOCAL_MM, registry, "local-size-proof")],
      registry,
      globalSizeMm: GLOBAL_MM,
      elementOrder: 2,
      maxDofs: BROWSER_SOLVE_LIMITS.maxDofs
    })!;
    expect(plan.unresolved).toEqual([]);
    expect(plan.preflight.status).toBe("ok");
    const uniform = await meshStepToMshV2(stepText, { elementOrder: 2, meshSizeMm: GLOBAL_MM });
    const local = await meshStepToMshV2(stepText, { elementOrder: 2, meshSizeMm: GLOBAL_MM, localSizing: plan.targets });
    expect(uniform.localSizing).toBeUndefined();
    expect(local.localSizing?.applied).toEqual([expect.objectContaining({ faceId: bore.faceId, size: LOCAL_MM, mode: "exact" })]);
    expect(local.localSizing?.unmatched).toEqual([]);
    const uniformArtifact = parseGmshMeshToCoreVolumeMesh(uniform.msh, { units: "mm" });
    const localArtifact = parseGmshMeshToCoreVolumeMesh(local.msh, { units: "mm" });
    expect(localArtifact.metadata.elementCount).toBeGreaterThan(1.5 * uniformArtifact.metadata.elementCount);
    expect(localArtifact.metadata.meshQuality.invertedElementCount).toBe(0);
    const ratio = plan.estimate.elements / localArtifact.metadata.elementCount;
    console.log(`[R2.2 bore] uniform=${uniformArtifact.metadata.elementCount} local=${localArtifact.metadata.elementCount} estimate=${plan.estimate.elements} ratio=${ratio.toFixed(3)} dofs=${localArtifact.metadata.nodeCount * 3} estDofs=${plan.preflight.estimatedDofs}`);
    expect(ratio).toBeGreaterThan(ESTIMATE_BAND.min);
    expect(ratio).toBeLessThan(ESTIMATE_BAND.max);
  });

  it("blocks an over-limit refinement in the preflight, before any gmsh session", () => {
    const bore = registry.faces.find((face) => face.cylinder?.interior)!;
    const plan = planMeshLocalSizing({
      rules: [meshLocalSizeForFace({ id: bore.faceId }, 0.5, registry)],
      registry,
      globalSizeMm: GLOBAL_MM,
      elementOrder: 2,
      maxDofs: 5_000
    })!;
    expect(plan.preflight.status).toBe("block");
    expect(plan.preflight.message).toMatch(/above the 5,000 DOF browser solver limit/);
  });
});
