// The Model panel reports the Bracket Demo's volume and mass from
// bracketSolidVolumeMm3. Mesh the same descriptor with gmsh-wasm and check the
// analytic volume against the solved mesh, so the two cannot drift apart.
import { describe, expect, it } from "vitest";
import { bracketGeoScript, bracketGeometrySourceMetadata, bracketSolidVolumeMm3, type BracketGeometryDescriptor } from "./bracketGeo";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import type { CoreVolumeMeshArtifact } from "./types";
import { meshGeoScriptToMshV2 } from "./wasmMesher";

// The shipped Bracket Demo descriptor (apps/openfea-web/src/bracketGeometryMigration.ts).
const SAMPLE_BRACKET: BracketGeometryDescriptor = {
  base: { length: 120, width: 34, height: 10 },
  upright: { height: 88, width: 18, thickness: 34 },
  gusset: { length: 40, height: 40, thickness: 12 },
  rib: { length: 40, height: 40, thickness: 12 },
  holes: [
    { center: [68, 17, 5], diameter: 12 },
    { center: [100, 17, 5], diameter: 12 },
    { center: [9, 17, 56], diameter: 10 }
  ],
  meshSize: 18
};

describe("bracket solid volume", () => {
  it("sums base, upright and rib, minus the bores", () => {
    const expected = 120 * 34 * 10 + 18 * 34 * 78 + (40 * 40 / 2) * 12 - 2 * Math.PI * 36 * 10 - Math.PI * 25 * 34;
    expect(bracketSolidVolumeMm3(SAMPLE_BRACKET)).toBeCloseTo(expected, 6);
    expect(bracketSolidVolumeMm3(SAMPLE_BRACKET)).toBeCloseTo(93_203.7, 1);
  });

  it("matches the default descriptor's wedge solid without bores", () => {
    expect(bracketSolidVolumeMm3()).toBeCloseTo(120 * 34 * 10 + 18 * 34 * 78 + (72 * 58 / 2) * 34, 6);
  });

  it("matches the volume of the mesh gmsh-wasm builds from the same descriptor", { timeout: 180_000 }, async () => {
    const meshed = await meshGeoScriptToMshV2(bracketGeoScript(SAMPLE_BRACKET), { elementOrder: 1 });
    const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
      units: "mm",
      sourceSelectionRefs: bracketGeometrySourceMetadata(),
      diagnostics: ["bracket volume check"]
    });
    const meshVolumeMm3 = meshVolumeM3(artifact) * 1e9;
    // Faceted bores remove slightly less material than true cylinders.
    expect(meshVolumeMm3 / bracketSolidVolumeMm3(SAMPLE_BRACKET)).toBeGreaterThan(0.995);
    expect(meshVolumeMm3 / bracketSolidVolumeMm3(SAMPLE_BRACKET)).toBeLessThan(1.01);
  });
});

function meshVolumeM3(artifact: CoreVolumeMeshArtifact): number {
  const xyz = artifact.nodes.coordinates;
  let volume = 0;
  for (const element of artifact.elements) {
    const [a, b, c, d] = element.connectivity as [number, number, number, number];
    const bx = xyz[b * 3]! - xyz[a * 3]!, by = xyz[b * 3 + 1]! - xyz[a * 3 + 1]!, bz = xyz[b * 3 + 2]! - xyz[a * 3 + 2]!;
    const cx = xyz[c * 3]! - xyz[a * 3]!, cy = xyz[c * 3 + 1]! - xyz[a * 3 + 1]!, cz = xyz[c * 3 + 2]! - xyz[a * 3 + 2]!;
    const dx = xyz[d * 3]! - xyz[a * 3]!, dy = xyz[d * 3 + 1]! - xyz[a * 3 + 1]!, dz = xyz[d * 3 + 2]! - xyz[a * 3 + 2]!;
    volume += (bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)) / 6;
  }
  return volume;
}
