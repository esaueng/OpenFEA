// Thin-geometry mesh rescue stack (July 2026), innermost first:
//   1. Netgen optimizer — thin walls leave a tiny sliver TAIL in the linear
//      mesh (often 1-2 elements out of thousands, minSICN ~0.01) that no
//      global size change reliably removes; one optimize("Netgen") pass
//      repairs it locally (~50 ms). Netgen can hard-crash the wasm module on
//      some meshes, so a crash aborts the session and it reruns without it.
//   2. Straight-edge Tet10 elevation — curved elevation snaps mid-side nodes
//      onto the CAD surface and inverts elements on bent thin regions
//      (minSICN -0.29 on a 3 mm bent shell whose linear mesh scores +0.31).
//   3. Quality-aware 3D algorithm fallback — a completed but sub-floor
//      Delaunay mesh is retried with Frontal instead of being accepted merely
//      because generation did not throw.
//   4. Bidirectional size ladder — the backstop when both algorithms still
//      miss the floor: try one adjacent coarser size and two finer sizes.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { meshStepToMshV2 } from "./wasmMesher";
import { generateBentShellStandStep, generateThinClipStandStep, generateThinSheetStandStep } from "./stepFixtures";
import { MESH_QUALITY_REJECT_MIN_SICN, MESH_QUALITY_WARN_MIN_SICN } from "./meshQualityGate";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";

const MEDIUM_PRESET_MM = 12;

describe("STEP Tet10 elevation rescue", () => {
  test("bent thin shell re-elevates with straight edges and passes the quality floor", async () => {
    const step = await generateBentShellStandStep();
    const meshed = await meshStepToMshV2(new TextEncoder().encode(step), {
      elementOrder: 2,
      meshSizeMm: MEDIUM_PRESET_MM
    });

    expect(meshed.elevation).toBe("straight_edge");
    // Corner-node optimization is attempted before the straight-edge rescue,
    // but this thin shell still needs the fallback to clear the same floor.
    expect(meshed.optimizer).toBe("netgen");
    expect(meshed.qualityMinSICN).toBeDefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
    // Still a quadratic mesh: msh2 element type 11 = Tet10.
    expect(/^\d+ 11 /m.test(meshed.msh)).toBe(true);
  }, 120_000);

  test.each([8, 6])("filleted block retains valid CAD-curved Tet10 at %s mm (Fine/Ultra)", async (meshSizeMm) => {
    const step = readFileSync(new URL("../fixtures/filleted-block.step", import.meta.url), "utf8");
    const meshed = await meshStepToMshV2(step, { elementOrder: 2, meshSizeMm });
    expect(meshed.elevation).toBe("curved");
    expect(meshed.optimizer).toBe("netgen");
    expect(meshed.qualityMinSICN).toBeGreaterThanOrEqual(MESH_QUALITY_WARN_MIN_SICN);
    expect(meshed.elementOrderFallback).toBeUndefined();
    expect(meshed.qualityRefinement).toBeUndefined();
    const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm" });
    expect(artifact.elements.every((element) => element.type === "Tet10")).toBe(true);
    expect(artifact.metadata.meshQuality.invertedElementCount).toBe(0);
    expect(artifact.metadata.meshQuality.minTetVolume).toBeGreaterThan(0);
    expect(artifact.metadata.connectedComponentCount).toBe(1);

    // The analytic boundary is the 3 mm offset of [3,57]x[3,37]x[3,17].
    // Verify actual boundary coordinates, not just the elevation label: a
    // straight-edge fallback would put fillet midside nodes inside this skin.
    const boundaryNodes = new Set(artifact.surfaceFacets.flatMap((facet) => facet.nodes));
    expect(boundaryNodes.size).toBeGreaterThan(0);
    for (const node of boundaryNodes) {
      const point = artifact.nodes.coordinates.slice(node * 3, node * 3 + 3).map((value) => value * 1_000);
      const distance = Math.hypot(...point.map((value, axis) => Math.max(3 - value, value - [57, 37, 17][axis]!, 0)));
      expect(distance).toBeCloseTo(3, 6);
    }
  }, 120_000);

  test("geometry that elevates cleanly keeps gmsh's curved elevation", async () => {
    const stepText = readFileSync(new URL("../fixtures/box-with-bore.step", import.meta.url), "utf8");
    const meshed = await meshStepToMshV2(new TextEncoder().encode(stepText), { elementOrder: 2 });

    expect(meshed.elevation).toBe("curved");
    expect(meshed.optimizer).toBeUndefined();
    expect(meshed.qualityMinSICN).toBeDefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
  }, 120_000);

  test("linear meshes carry no elevation marker", async () => {
    const stepText = readFileSync(new URL("../fixtures/box-with-bore.step", import.meta.url), "utf8");
    const meshed = await meshStepToMshV2(new TextEncoder().encode(stepText), { elementOrder: 1 });

    expect(meshed.elevation).toBeUndefined();
  }, 120_000);
});

describe("STEP thin-wall sliver repair (Netgen)", () => {
  test("2 mm clip passes the quality floor at the medium preset via Netgen", async () => {
    const step = await generateThinClipStandStep();
    const meshed = await meshStepToMshV2(new TextEncoder().encode(step), {
      elementOrder: 2,
      meshSizeMm: MEDIUM_PRESET_MM
    });

    expect(meshed.optimizer).toBe("netgen");
    expect(meshed.qualityMinSICN).toBeDefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
    // Netgen repairs the mesh in-session; the size ladder must not be needed.
    expect(meshed.qualityRefinement).toBeUndefined();
  }, 240_000);

  test("1.5 mm sheet stand (reported production shape) passes at the medium preset", async () => {
    const step = await generateThinSheetStandStep();
    const meshed = await meshStepToMshV2(new TextEncoder().encode(step), {
      elementOrder: 2,
      meshSizeMm: MEDIUM_PRESET_MM
    });

    expect(meshed.optimizer).toBe("netgen");
    expect(meshed.qualityMinSICN).toBeDefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
    expect(meshed.qualityRefinement).toBeUndefined();
    expect(/^\d+ 11 /m.test(meshed.msh)).toBe(true);
  }, 240_000);

  test("healthy geometry reports neither optimizer nor refinement", async () => {
    const stepText = readFileSync(new URL("../fixtures/box-with-bore.step", import.meta.url), "utf8");
    const meshed = await meshStepToMshV2(new TextEncoder().encode(stepText), { elementOrder: 2, meshSizeMm: MEDIUM_PRESET_MM });

    expect(meshed.optimizer).toBeUndefined();
    expect(meshed.qualityRefinement).toBeUndefined();
    expect(meshed.qualityMinSICN!).toBeGreaterThanOrEqual(MESH_QUALITY_REJECT_MIN_SICN);
  }, 120_000);
});
