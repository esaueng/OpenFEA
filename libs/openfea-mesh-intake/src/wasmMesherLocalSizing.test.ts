// Plan 036 R2.2: local sizing through the real gmsh-wasm session. A plate
// with a central hole is meshed from an OpenCASCADE .geo script in mm and in
// m; the hole wall gets a Distance + Threshold field identified by its area
// and centroid (the same descriptors the STEP display registry provides).
import { describe, expect, it } from "vitest";
import { estimateMeshSize, type LocalSizeTarget } from "./localSizing";
import { meshGeoScriptToMshV2 } from "./wasmMesher";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";

const PLATE_MM = { length: 120, width: 60, thickness: 6, holeRadius: 7.5 };
const HOLE_AREA_MM2 = 2 * Math.PI * PLATE_MM.holeRadius * PLATE_MM.thickness;
const PLATE_VOLUME_MM3 = PLATE_MM.length * PLATE_MM.width * PLATE_MM.thickness - Math.PI * PLATE_MM.holeRadius ** 2 * PLATE_MM.thickness;
const PLATE_AREA_MM2 = 2 * (PLATE_MM.length * PLATE_MM.width - Math.PI * PLATE_MM.holeRadius ** 2)
  + 2 * (PLATE_MM.length + PLATE_MM.width) * PLATE_MM.thickness + HOLE_AREA_MM2;
/** Estimate band asserted against real gmsh counts (the estimate is a planning APPROXIMATION). */
const ESTIMATE_RELATIVE_TOLERANCE = 0.3;
/** gmsh mm vs m meshes of the same solid differ by ~1% in counts (absolute tolerances, random perturbation). */
const GMSH_SCALE_COUNT_TOLERANCE = 0.03;
/** Same faceted solid in both unit systems. */
const VOLUME_RELATIVE_TOLERANCE = 1e-3;
/** Linear tets inscribe the curved hole wall, so the meshed volume is slightly larger than the exact solid. */
const FACETED_HOLE_VOLUME_TOLERANCE = 0.01;

function tetVolume(artifact: { nodes: { coordinates: number[] }; elements: Array<{ connectivity: number[] }> }): number {
  const c = artifact.nodes.coordinates;
  let total = 0;
  for (const element of artifact.elements) {
    const [a, b, d, e] = element.connectivity.map((node) => node * 3) as [number, number, number, number];
    const u = [c[b]! - c[a]!, c[b + 1]! - c[a + 1]!, c[b + 2]! - c[a + 2]!];
    const v = [c[d]! - c[a]!, c[d + 1]! - c[a + 1]!, c[d + 2]! - c[a + 2]!];
    const w = [c[e]! - c[a]!, c[e + 1]! - c[a + 1]!, c[e + 2]! - c[a + 2]!];
    total += Math.abs(u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!)) / 6;
  }
  return total;
}

function plateGeo(scale: number, globalSize: number): string {
  const { length, width, thickness, holeRadius } = PLATE_MM;
  const s = (value: number) => value * scale;
  return [
    'SetFactory("OpenCASCADE");',
    `Mesh.CharacteristicLengthMin = ${s(globalSize * 0.45)};`,
    `Mesh.CharacteristicLengthMax = ${s(globalSize)};`,
    `Box(1) = {0, 0, 0, ${s(length)}, ${s(width)}, ${s(thickness)}};`,
    `Cylinder(2) = {${s(length / 2)}, ${s(width / 2)}, ${s(-1)}, 0, 0, ${s(thickness + 2)}, ${s(holeRadius)}};`,
    "BooleanDifference(3) = { Volume{1}; Delete; }{ Volume{2}; Delete; };",
    'Physical Volume("solid") = {3};'
  ].join("\n");
}

function holeTarget(scale: number, size: number): LocalSizeTarget {
  const { length, width, thickness, holeRadius } = PLATE_MM;
  return {
    id: "rule-hole",
    faceId: "step-face-hole",
    size: size * scale,
    area: HOLE_AREA_MM2 * scale * scale,
    centroid: [length / 2 * scale, width / 2 * scale, thickness / 2 * scale],
    bounds: {
      min: [(length / 2 - holeRadius) * scale, (width / 2 - holeRadius) * scale, 0],
      max: [(length / 2 + holeRadius) * scale, (width / 2 + holeRadius) * scale, thickness * scale]
    }
  };
}

async function meshPlate(options: { units: "mm" | "m"; globalSizeMm: number; localSizeMm?: number; elementOrder?: 1 | 2 }) {
  const scale = options.units === "m" ? 0.001 : 1;
  const meshed = await meshGeoScriptToMshV2(plateGeo(scale, options.globalSizeMm), {
    elementOrder: options.elementOrder ?? 1,
    ...(options.localSizeMm !== undefined ? { localSizing: [holeTarget(scale, options.localSizeMm)] } : {})
  });
  const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: options.units });
  return { meshed, artifact };
}

describe("local sizing (plan 036 R2.2) through gmsh-wasm", () => {
  it("refines the hole wall identified by area and centroid", { timeout: 120_000 }, async () => {
    const uniform = await meshPlate({ units: "mm", globalSizeMm: 6 });
    const local = await meshPlate({ units: "mm", globalSizeMm: 6, localSizeMm: 1 });
    expect(local.meshed.localSizing?.applied).toEqual([
      expect.objectContaining({ targetId: "rule-hole", faceId: "step-face-hole", size: 1, mode: "exact", surfaceTags: [expect.any(Number)] })
    ]);
    expect(local.meshed.localSizing?.unmatched).toEqual([]);
    expect(local.meshed.localSizing?.globalSize).toBe(6);
    expect(local.artifact.metadata.elementCount).toBeGreaterThan(2 * uniform.artifact.metadata.elementCount);
    expect(local.artifact.metadata.connectedComponentCount).toBe(1);

    // The smallest hole-wall edges are near the local size, far edges near the global one.
    const coordinates = local.artifact.nodes.coordinates;
    const center = [0.06, 0.03];
    let nearMax = 0;
    for (const element of local.artifact.elements) {
      const corners = element.connectivity.slice(0, 4);
      for (let a = 0; a < 4; a += 1) {
        for (let b = a + 1; b < 4; b += 1) {
          const p = corners[a]! * 3;
          const q = corners[b]! * 3;
          const radiusP = Math.hypot(coordinates[p]! - center[0]!, coordinates[p + 1]! - center[1]!);
          const radiusQ = Math.hypot(coordinates[q]! - center[0]!, coordinates[q + 1]! - center[1]!);
          if (Math.max(radiusP, radiusQ) > 0.0076) continue;
          nearMax = Math.max(nearMax, Math.hypot(coordinates[p]! - coordinates[q]!, coordinates[p + 1]! - coordinates[q + 1]!, coordinates[p + 2]! - coordinates[q + 2]!));
        }
      }
    }
    // Edges touching the hole wall stay within twice the 1 mm local size (gmsh sizes are targets, not bounds).
    expect(nearMax).toBeLessThan(0.002);
  });

  it("produces the same mesh in mm and in m (size field equivalence)", { timeout: 120_000 }, async () => {
    const millimetres = await meshPlate({ units: "mm", globalSizeMm: 6, localSizeMm: 1 });
    const metres = await meshPlate({ units: "m", globalSizeMm: 6, localSizeMm: 1 });
    const uniformMetres = await meshPlate({ units: "m", globalSizeMm: 6 });
    const uniformMillimetres = await meshPlate({ units: "mm", globalSizeMm: 6 });
    expect(metres.meshed.localSizing?.applied).toHaveLength(1);
    expect(metres.meshed.localSizing?.applied[0]?.size).toBeCloseTo(millimetres.meshed.localSizing!.applied[0]!.size / 1000, 15);
    expect(metres.meshed.localSizing!.globalSize / millimetres.meshed.localSizing!.globalSize).toBeCloseTo(1 / 1000, 15);
    // gmsh is not bit-for-bit scale invariant (absolute geometry tolerances
    // and random point perturbation), so the meshes agree statistically.
    const relative = (left: number, right: number) => Math.abs(left - right) / right;
    expect(relative(metres.artifact.metadata.elementCount, millimetres.artifact.metadata.elementCount)).toBeLessThan(GMSH_SCALE_COUNT_TOLERANCE);
    expect(relative(metres.artifact.metadata.nodeCount, millimetres.artifact.metadata.nodeCount)).toBeLessThan(GMSH_SCALE_COUNT_TOLERANCE);
    const refinementMetres = metres.artifact.metadata.elementCount / uniformMetres.artifact.metadata.elementCount;
    const refinementMillimetres = millimetres.artifact.metadata.elementCount / uniformMillimetres.artifact.metadata.elementCount;
    expect(relative(refinementMetres, refinementMillimetres)).toBeLessThan(GMSH_SCALE_COUNT_TOLERANCE);
    // Both artifacts are parsed into solver metres: the meshed volume is the same solid.
    expect(relative(tetVolume(metres.artifact), tetVolume(millimetres.artifact))).toBeLessThan(VOLUME_RELATIVE_TOLERANCE);
    expect(relative(tetVolume(millimetres.artifact), PLATE_VOLUME_MM3 * 1e-9)).toBeLessThan(FACETED_HOLE_VOLUME_TOLERANCE);
  });

  it("reports rules it cannot apply instead of guessing", { timeout: 120_000 }, async () => {
    const meshed = await meshGeoScriptToMshV2(plateGeo(1, 6), {
      elementOrder: 1,
      localSizing: [
        { ...holeTarget(1, 8), id: "rule-coarse" },
        { ...holeTarget(1, 1), id: "rule-missing", faceId: "step-face-missing", area: 5000, centroid: [10, 10, 10] }
      ]
    });
    expect(meshed.localSizing?.applied).toEqual([]);
    expect(meshed.localSizing?.unmatched).toEqual([
      { targetId: "rule-coarse", faceId: "step-face-hole", reason: "not_finer_than_global" },
      { targetId: "rule-missing", faceId: "step-face-missing", reason: "no_matching_surface" }
    ]);
  });

  it("keeps the pre-mesh estimate within its stated band of real gmsh counts", { timeout: 300_000 }, async () => {
    // Global sizes up to the 6 mm wall thickness: the stated ±30% band.
    // Above it (10 mm) the estimate may only err high, which errs toward the
    // preflight blocking, never toward letting an over-limit mesh through.
    const cases = [
      { globalSizeMm: 6 },
      { globalSizeMm: 3 },
      { globalSizeMm: 2 },
      { globalSizeMm: 6, localSizeMm: 1 },
      { globalSizeMm: 6, localSizeMm: 0.5 },
      { globalSizeMm: 6, localSizeMm: 2 },
      { globalSizeMm: 4, localSizeMm: 1 },
      { globalSizeMm: 4, localSizeMm: 1, elementOrder: 2 as const },
      { globalSizeMm: 3, elementOrder: 2 as const },
      { globalSizeMm: 10, localSizeMm: 1.5 }
    ];
    for (const testCase of cases) {
      const { artifact } = await meshPlate({ units: "mm", ...testCase });
      const estimate = estimateMeshSize({
        volume: PLATE_VOLUME_MM3,
        surfaceArea: PLATE_AREA_MM2,
        globalSize: testCase.globalSizeMm,
        faces: testCase.localSizeMm !== undefined ? [{ area: HOLE_AREA_MM2, size: testCase.localSizeMm, cylinder: { radius: PLATE_MM.holeRadius, interior: true } }] : []
      });
      const estimatedNodes = testCase.elementOrder === 2 ? estimate.tet10Nodes : estimate.tet4Nodes;
      console.log(`[local sizing estimate] ${JSON.stringify(testCase)} elements actual=${artifact.metadata.elementCount} est=${estimate.elements} nodes actual=${artifact.metadata.nodeCount} est=${estimatedNodes}`);
      const elementError = (estimate.elements - artifact.metadata.elementCount) / artifact.metadata.elementCount;
      const nodeError = (estimatedNodes - artifact.metadata.nodeCount) / artifact.metadata.nodeCount;
      expect(elementError).toBeGreaterThan(-ESTIMATE_RELATIVE_TOLERANCE);
      expect(nodeError).toBeGreaterThan(-ESTIMATE_RELATIVE_TOLERANCE);
      if (testCase.globalSizeMm <= PLATE_MM.thickness) {
        expect(elementError).toBeLessThan(ESTIMATE_RELATIVE_TOLERANCE);
        expect(nodeError).toBeLessThan(ESTIMATE_RELATIVE_TOLERANCE);
      }
    }
  });
});
