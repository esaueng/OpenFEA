import { describe, expect, test } from "vitest";
import { nearestGlobalAxis, SUPPORT_GEOMETRY_POLICY, symmetrySupportAxisForFacets } from "../src";

// Two triangles of the unit square in a plane through the origin, rotated by
// `degrees` about the X axis from the XY plane (normal +Z at 0°).
function tiltedSquare(degrees: number, scale = 1) {
  const radians = (degrees * Math.PI) / 180;
  const point = (x: number, y: number): number[] => [x * scale, y * Math.cos(radians) * scale, y * Math.sin(radians) * scale];
  const coordinates = [...point(0, 0), ...point(1, 0), ...point(1, 1), ...point(0, 1)];
  return { coordinates, facets: [{ nodes: [0, 1, 2] }, { nodes: [0, 2, 3] }] };
}

describe("support geometry policy (plan 036 R1.4)", () => {
  test("names a one-degree axis tolerance", () => {
    expect(SUPPORT_GEOMETRY_POLICY.symmetryAxisToleranceDegrees).toBe(1);
  });

  test("finds the nearest axis in either sense", () => {
    expect(nearestGlobalAxis([0, 0, -3])).toEqual({ component: "z", deviationDegrees: 0 });
    expect(nearestGlobalAxis([0, 2, 0])?.component).toBe("y");
    const tilted = nearestGlobalAxis([Math.sin(0.1), 0, Math.cos(0.1)]);
    expect(tilted?.component).toBe("z");
    expect(tilted?.deviationDegrees).toBeCloseTo((0.1 * 180) / Math.PI, 10);
    expect(nearestGlobalAxis([0, 0, 0])).toBeUndefined();
  });

  test("accepts an axis-aligned face and constrains its normal component", () => {
    const { coordinates, facets } = tiltedSquare(0);
    expect(symmetrySupportAxisForFacets(coordinates, facets)).toEqual({ ok: true, component: "z", maxDeviationDegrees: 0, facetCount: 2 });
  });

  test("accepts a face just inside the tolerance and rejects one just outside, with the measured angle", () => {
    const inside = tiltedSquare(0.9);
    const accepted = symmetrySupportAxisForFacets(inside.coordinates, inside.facets);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.maxDeviationDegrees).toBeCloseTo(0.9, 9);

    const outside = tiltedSquare(5);
    const rejected = symmetrySupportAxisForFacets(outside.coordinates, outside.facets);
    expect(rejected).toMatchObject({ ok: false, code: "symmetry-face-not-axis-aligned", component: "z" });
    if (!rejected.ok) {
      expect(rejected.message).toContain("within 1° of a global axis");
      expect(rejected.message).toContain("5° from the Z axis");
    }
  });

  test("is independent of the model length unit", () => {
    const metres = tiltedSquare(0.5, 0.04);
    const millimetres = tiltedSquare(0.5, 40);
    const inMetres = symmetrySupportAxisForFacets(metres.coordinates, metres.facets);
    const inMillimetres = symmetrySupportAxisForFacets(millimetres.coordinates, millimetres.facets);
    expect(inMetres.ok && inMillimetres.ok).toBe(true);
    if (inMetres.ok && inMillimetres.ok) {
      expect(inMillimetres.component).toBe(inMetres.component);
      expect(inMillimetres.maxDeviationDegrees).toBeCloseTo(inMetres.maxDeviationDegrees, 9);
    }
  });

  test("rejects faces on two different axes and empty selections", () => {
    // An XY square (normal Z) plus an XZ triangle (normal Y).
    const coordinates = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1];
    expect(symmetrySupportAxisForFacets(coordinates, [{ nodes: [0, 1, 2] }, { nodes: [0, 2, 3] }, { nodes: [0, 4, 1] }]))
      .toMatchObject({ ok: false, code: "mixed-symmetry-axes" });
    expect(symmetrySupportAxisForFacets(coordinates, [])).toMatchObject({ ok: false, code: "empty-symmetry-surface" });
  });

  test("ignores Tri6 midside nodes and accepts opposite parallel faces", () => {
    // Corners first; the midside indices point at arbitrary nodes and must not matter.
    const coordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 1, 0, 2, 0, 1, 2];
    const facets = [{ nodes: [0, 1, 2, 3, 4, 5] }, { nodes: [3, 5, 4, 0, 1, 2] }];
    expect(symmetrySupportAxisForFacets(coordinates, facets)).toMatchObject({ ok: true, component: "z", facetCount: 2 });
  });
});
