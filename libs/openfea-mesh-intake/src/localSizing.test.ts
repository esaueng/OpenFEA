import { describe, expect, it } from "vitest";
import {
  estimateMeshSize,
  localSizeDistanceSampling,
  localSizeThresholdDistance,
  localSizingPreflight,
  matchLocalSizeSurfaces,
  millimetresToModelLength,
  type LocalSizeSurfaceDescriptor,
  type LocalSizeTarget
} from "./localSizing";

const surfaces: LocalSizeSurfaceDescriptor[] = [
  { tag: 1, area: 360, centroid: [0, 30, 3], bounds: { min: [0, 0, 0], max: [0, 60, 6] } },
  { tag: 7, area: 282.74, centroid: [60, 30, 3], bounds: { min: [52.5, 22.5, 0], max: [67.5, 37.5, 6] } },
  // A face split in two by a conformal fragment.
  { tag: 8, area: 180, centroid: [120, 15, 3], bounds: { min: [120, 0, 0], max: [120, 30, 6] } },
  { tag: 9, area: 180, centroid: [120, 45, 3], bounds: { min: [120, 30, 0], max: [120, 60, 6] } }
];

function target(overrides: Partial<LocalSizeTarget>): LocalSizeTarget {
  return {
    id: "rule",
    faceId: "step-face-0",
    size: 1,
    area: 282,
    centroid: [60, 30, 3],
    bounds: { min: [52.5, 22.5, 0], max: [67.5, 37.5, 6] },
    ...overrides
  };
}

describe("local size surface matching", () => {
  const diagonal = Math.hypot(120, 60, 6);

  it("matches a face by area and centroid within the tessellation tolerance", () => {
    const { matches, unmatched } = matchLocalSizeSurfaces(surfaces, [target({})], diagonal);
    expect(unmatched).toEqual([]);
    expect(matches).toEqual([{ targetId: "rule", faceId: "step-face-0", size: 1, surfaceTags: [7], mode: "exact" }]);
  });

  it("matches a split face as the union of the surfaces inside its bounds", () => {
    const end = target({ area: 360, centroid: [120, 30, 3], bounds: { min: [120, 0, 0], max: [120, 60, 6] } });
    expect(matchLocalSizeSurfaces(surfaces, [end], diagonal).matches[0]).toMatchObject({ surfaceTags: [8, 9], mode: "union" });
  });

  it("reports a face it cannot identify and an invalid size instead of guessing", () => {
    const { matches, unmatched } = matchLocalSizeSurfaces(surfaces, [
      target({ id: "far", centroid: [30, 30, 3] }),
      target({ id: "zero", size: 0 }),
      target({ id: "wrong-area", area: 400 })
    ], diagonal);
    expect(matches).toEqual([]);
    expect(unmatched.map((entry) => [entry.targetId, entry.reason])).toEqual([
      ["far", "no_matching_surface"],
      ["zero", "invalid_size"],
      ["wrong-area", "no_matching_surface"]
    ]);
  });

  it("is unit independent: the same model in metres matches the same surfaces", () => {
    const metres = surfaces.map((surface) => ({
      ...surface,
      area: surface.area * 1e-6,
      centroid: surface.centroid.map((value) => value / 1000) as [number, number, number],
      bounds: { min: surface.bounds.min.map((value) => value / 1000) as [number, number, number], max: surface.bounds.max.map((value) => value / 1000) as [number, number, number] }
    }));
    const t = target({});
    const scaled = target({
      size: millimetresToModelLength(t.size, "m"),
      area: t.area * 1e-6,
      centroid: t.centroid.map((value) => value / 1000) as [number, number, number],
      bounds: { min: t.bounds.min.map((value) => value / 1000) as [number, number, number], max: t.bounds.max.map((value) => value / 1000) as [number, number, number] }
    });
    expect(matchLocalSizeSurfaces(metres, [scaled], diagonal / 1000).matches[0]?.surfaceTags).toEqual([7]);
  });
});

describe("threshold and sampling", () => {
  it("grows from the local to the global size at the growth rate", () => {
    expect(localSizeThresholdDistance(1, 6)).toBeCloseTo(10, 12);
    expect(localSizeThresholdDistance(0.001, 0.006)).toBeCloseTo(0.01, 15);
    expect(localSizeThresholdDistance(6, 6)).toBe(0);
  });

  it("samples about two points per local element, bounded", () => {
    expect(localSizeDistanceSampling(22, 1)).toBe(44);
    expect(localSizeDistanceSampling(0.022, 0.001)).toBe(44);
    expect(localSizeDistanceSampling(1, 1)).toBe(20);
    expect(localSizeDistanceSampling(1000, 0.5)).toBe(120);
  });
});

describe("pre-mesh estimate and preflight", () => {
  const plate = { volume: 42140, surfaceArea: 16489, globalSize: 6 };
  const hole = { area: 282.74, size: 1, cylinder: { radius: 7.5, interior: true } };

  it("adds the refined band to the uniform estimate and is scale invariant", () => {
    const millimetres = estimateMeshSize({ ...plate, faces: [hole] });
    expect(millimetres.uniformElements).toBeLessThan(millimetres.elements);
    expect(millimetres.tet10Dofs).toBeGreaterThan(millimetres.tet4Dofs);
    const metres = estimateMeshSize({
      volume: plate.volume * 1e-9,
      surfaceArea: plate.surfaceArea * 1e-6,
      globalSize: plate.globalSize / 1000,
      faces: [{ ...hole, area: hole.area * 1e-6, size: hole.size / 1000, cylinder: { radius: 0.0075, interior: true } }]
    });
    for (const key of ["elements", "tet4Nodes", "tet10Nodes", "uniformElements"] as const) {
      expect(Math.abs(metres[key] - millimetres[key])).toBeLessThanOrEqual(1);
    }
  });

  it("ignores rules that are not finer than the global size", () => {
    const estimate = estimateMeshSize({ ...plate, faces: [{ ...hole, size: 6 }] });
    expect(estimate.elements).toBe(estimate.uniformElements);
  });

  it("blocks when even Tet4 exceeds the ceiling, warns when only Tet10 does", () => {
    const estimate = estimateMeshSize({ ...plate, faces: [hole] });
    expect(localSizingPreflight(estimate, { elementOrder: 2, maxDofs: 150_000 }).status).toBe("ok");
    const warn = localSizingPreflight(estimate, { elementOrder: 2, maxDofs: Math.floor((estimate.tet4Dofs + estimate.tet10Dofs) / 2) });
    expect(warn.status).toBe("warn");
    expect(warn.message).toMatch(/linear Tet4/);
    expect(localSizingPreflight(estimate, { elementOrder: 1, maxDofs: estimate.tet4Dofs + 1 }).status).toBe("ok");
    const block = localSizingPreflight(estimate, { elementOrder: 2, maxDofs: estimate.tet4Dofs - 1 });
    expect(block.status).toBe("block");
    expect(block.message).toMatch(/Increase the local size/);
  });

  it("converts millimetres to the model length unit", () => {
    expect(millimetresToModelLength(2, "mm")).toBe(2);
    expect(millimetresToModelLength(2, "m")).toBeCloseTo(0.002, 15);
  });
});
