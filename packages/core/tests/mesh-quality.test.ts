import { describe, expect, test } from "vitest";
import {
  computeTetMeshQuality,
  MESH_QUALITY_POLICY,
  MESH_QUALITY_THRESHOLDS,
  tet10JacobianQuality,
  tetShapeQuality,
  TET10_GAUSS_POINTS
} from "../src";

// Metrics are computed in double precision from coordinates with O(1) error;
// this tolerance is far looser than round-off and far tighter than any threshold.
const METRIC_TOLERANCE = 1e-9;
const REGULAR_DIHEDRAL_DEG = (Math.acos(1 / 3) * 180) / Math.PI;

// Positively oriented: (p1 − p0) · ((p2 − p0) × (p3 − p0)) > 0.
const REGULAR_TET = [
  1, 1, 1,
  -1, 1, -1,
  1, -1, -1,
  -1, -1, 1
];
const CORNERS = [0, 1, 2, 3];

// The six midside nodes of a Tet10 on straight edges (VTK order, matching core's TET10_EDGE_VERTICES).
const EDGE_VERTICES = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]] as const;

function straightTet10(corners: number[]): number[] {
  const coordinates = [...corners];
  for (const [a, b] of EDGE_VERTICES) {
    for (let c = 0; c < 3; c += 1) coordinates.push((corners[a * 3 + c] + corners[b * 3 + c]) / 2);
  }
  return coordinates;
}

const TET10_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

describe("tetrahedral shape quality", () => {
  test("a regular tetrahedron is ideal", () => {
    const quality = tetShapeQuality(REGULAR_TET, CORNERS);
    expect(quality.scaledJacobian).toBeCloseTo(1, 12);
    expect(quality.aspectRatio).toBeCloseTo(1, 12);
    expect(quality.minDihedralDeg).toBeCloseTo(REGULAR_DIHEDRAL_DEG, 10);
    expect(quality.maxDihedralDeg).toBeCloseTo(REGULAR_DIHEDRAL_DEG, 10);
    expect(quality.degenerate).toBe(false);
  });

  test("a sliver (four nearly coplanar vertices with good edge lengths) has scaled Jacobian near 0", () => {
    const height = 1e-4;
    const sliver = [0, 0, 0, 1, 0, height, 1, 1, 0, 0, 1, height];
    const quality = tetShapeQuality(sliver, CORNERS);
    expect(quality.scaledJacobian).toBeGreaterThan(0);
    expect(quality.scaledJacobian).toBeLessThan(1e-3);
    expect(quality.aspectRatio).toBeGreaterThan(MESH_QUALITY_THRESHOLDS.aspectRatioWarnAbove);
    expect(quality.minDihedralDeg).toBeLessThan(MESH_QUALITY_THRESHOLDS.minDihedralWarnBelowDeg);
    expect(quality.maxDihedralDeg).toBeGreaterThan(MESH_QUALITY_THRESHOLDS.maxDihedralWarnAboveDeg);
  });

  test("an inverted tetrahedron has a negative scaled Jacobian but orientation-free shape metrics", () => {
    const inverted = tetShapeQuality(REGULAR_TET, [1, 0, 2, 3]);
    expect(inverted.scaledJacobian).toBeCloseTo(-1, 12);
    expect(inverted.aspectRatio).toBeCloseTo(1, 12);
    expect(inverted.minDihedralDeg).toBeCloseTo(REGULAR_DIHEDRAL_DEG, 10);
  });

  test("a zero-volume element is degenerate with unbounded aspect ratio", () => {
    const flat = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const quality = tetShapeQuality(flat, CORNERS);
    expect(quality.degenerate).toBe(true);
    expect(quality.scaledJacobian).toBe(0);
    expect(quality.aspectRatio).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Tet10 det J at the solver's Gauss points", () => {
  test("a straight-sided Tet10 has uniform positive det J", () => {
    const quality = tet10JacobianQuality(straightTet10(REGULAR_TET), TET10_IDS);
    expect(quality.nonPositive).toBe(false);
    expect(quality.detJRatio).toBeCloseTo(1, 12);
    expect(quality.minDetJ).toBeCloseTo(quality.maxDetJ, 12);
  });

  test("a midside node pushed past its vertex gives the closed-form negative det J", () => {
    // Reference tet with midside node 4 (edge 0-1) moved from (0.5,0,0) by δ along x:
    // x = ξ + 4δ L0 L1, so det J = 1 + 4δ (L0 − L1). At the Gauss point with
    // L1 = a, L0 = b this is 1 − 4δ (a − b) = 1 − 4δ/√5.
    const reference = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const delta = 0.75;
    const curved = straightTet10(reference);
    curved[4 * 3] += delta;
    const [a, b] = [TET10_GAUSS_POINTS[0][0], TET10_GAUSS_POINTS[0][1]];
    const expectedMin = 1 - 4 * delta * (a - b);
    const expectedMax = 1 + 4 * delta * (a - b);
    expect(expectedMin).toBeCloseTo(1 - (4 * delta) / Math.sqrt(5), 12);

    const quality = tet10JacobianQuality(curved, TET10_IDS);
    expect(quality.minDetJ).toBeCloseTo(expectedMin, 12);
    expect(quality.maxDetJ).toBeCloseTo(expectedMax, 12);
    expect(quality.minDetJ).toBeLessThan(0);
    expect(quality.nonPositive).toBe(true);
    expect(quality.detJRatio).toBeCloseTo(expectedMin / expectedMax, 12);
  });

  test("det J exactly at the solver tolerance counts as non-positive", () => {
    const reference = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const curved = straightTet10(reference);
    // det J = 1 − 4δ/√5 = 0 at the worst Gauss point.
    curved[4 * 3] += Math.sqrt(5) / 4;
    expect(tet10JacobianQuality(curved, TET10_IDS).nonPositive).toBe(true);
  });
});

describe("mesh quality summary", () => {
  // Two regular tets, one sliver, one inverted.
  const coordinates = [...REGULAR_TET, 0, 0, 0, 1, 0, 1e-4, 1, 1, 0, 0, 1, 1e-4];
  const connectivity = [0, 1, 2, 3, 1, 0, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3];

  test("reports worst, tail percentile and median, flags and the worst elements", () => {
    const summary = computeTetMeshQuality({ coordinates, connectivity, elementType: "Tet4" })!;
    expect(summary.elementCount).toBe(4);
    expect(summary.metrics.scaledJacobian.worst).toBeCloseTo(-1, 12);
    expect(summary.metrics.scaledJacobian.median).toBeGreaterThan(0);
    expect(summary.metrics.aspectRatio!.worst).toBeGreaterThan(MESH_QUALITY_THRESHOLDS.aspectRatioWarnAbove);
    expect(summary.flagged.scaledJacobian).toBe(2);
    expect(summary.flagged.aspectRatio).toBe(1);
    expect(summary.flagged.any).toBe(2);
    expect(summary.worstElements.slice(0, 2)).toEqual([1, 2]);
    expect(summary.metrics.scaledJacobian.histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(summary.metrics.scaledJacobian.histogram.counts).toHaveLength(MESH_QUALITY_POLICY.histogramBinCount);
    expect(summary.metrics.tet10DetJRatio).toBeUndefined();
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  test("bounds the worst-element list and percentiles stay exact on larger meshes", () => {
    const count = 1000;
    const coords: number[] = [];
    const conn: number[] = [];
    for (let element = 0; element < count; element += 1) {
      // Heights 1..1000/1000 of a right tet give a monotone quality ramp.
      const h = (element + 1) / count;
      const base = coords.length / 3;
      coords.push(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, h);
      conn.push(base, base + 1, base + 2, base + 3);
    }
    const summary = computeTetMeshQuality({ coordinates: coords, connectivity: conn, elementType: "Tet4" })!;
    expect(summary.worstElements).toHaveLength(MESH_QUALITY_POLICY.worstElementCount);
    expect(summary.worstElements[0]).toBe(0);
    const expectedAt = (element: number) => tetShapeQuality(coords, conn.slice(element * 4, element * 4 + 4)).scaledJacobian;
    // Scaled Jacobian increases with h on this ramp, so ranks map to element indices.
    expect(summary.metrics.scaledJacobian.p5).toBeCloseTo(expectedAt(Math.floor(0.05 * (count - 1))), 12);
    expect(summary.metrics.scaledJacobian.median).toBeCloseTo(expectedAt(Math.floor(0.5 * (count - 1))), 12);
  });

  test("Tet10 summaries add det J statistics and flag non-positive elements", () => {
    const reference = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const good = straightTet10(reference);
    const bad = straightTet10(reference);
    bad[4 * 3] += 0.75;
    const tet10Coordinates = [...good, ...bad];
    const tet10Connectivity = [...TET10_IDS, ...TET10_IDS.map((id) => id + 10)];
    const summary = computeTetMeshQuality({ coordinates: tet10Coordinates, connectivity: tet10Connectivity, elementType: "Tet10" })!;
    expect(summary.flagged.tet10NonPositiveDetJ).toBe(1);
    expect(summary.flagged.tet10DetJRatio).toBe(1);
    expect(summary.metrics.tet10DetJRatio!.worst).toBeLessThan(0);
    expect(summary.worstElements[0]).toBe(1);
  });

  test("metrics are dimensionless: identical at mm and m scale", () => {
    const reference = [0, 0, 0, 12, 0, 0, 1, 9, 0, 2, 3, 7];
    const curved = straightTet10(reference);
    curved[5 * 3 + 2] += 1.3;
    const mixed = [...curved, ...REGULAR_TET.map((value) => value * 25 + 40)];
    const tet10Connectivity = [...TET10_IDS, 10, 11, 12, 13, 0, 1, 2, 3, 4, 5];
    // Second element reuses node ids only to form a valid-length Tet10 connectivity; it is a
    // different shape, which is all the invariance check needs.
    const inMillimetres = computeTetMeshQuality({ coordinates: mixed, connectivity: tet10Connectivity, elementType: "Tet10" })!;
    const inMetres = computeTetMeshQuality({ coordinates: mixed.map((value) => value * 1e-3), connectivity: tet10Connectivity, elementType: "Tet10" })!;
    expect(inMetres.flagged).toEqual(inMillimetres.flagged);
    expect(inMetres.worstElements).toEqual(inMillimetres.worstElements);
    for (const key of Object.keys(inMillimetres.metrics) as Array<keyof typeof inMillimetres.metrics>) {
      const mm = inMillimetres.metrics[key]!;
      const m = inMetres.metrics[key]!;
      expect(Math.abs(m.worst - mm.worst)).toBeLessThan(METRIC_TOLERANCE);
      expect(Math.abs(m.p5 - mm.p5)).toBeLessThan(METRIC_TOLERANCE);
      expect(Math.abs(m.median - mm.median)).toBeLessThan(METRIC_TOLERANCE);
      expect(m.histogram.counts).toEqual(mm.histogram.counts);
    }
    expect(computeTetMeshQuality({ coordinates: mixed, connectivity: [], elementType: "Tet10" })).toBeNull();
  });
});
