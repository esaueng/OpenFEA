import { describe, expect, test } from "vitest";
import { MESH_QUALITY_POLICY, TET10_GAUSS_POINTS as CORE_TET10_GAUSS_POINTS } from "@openfea/core";
import { ELEMENT_GEOMETRY_POLICY, TET10_GAUSS_POINTS } from "../src";

// The Mesh panel's Tet10 det J check claims to evaluate the solver's own
// quadrature rule and degeneracy tolerance; keep the core copies identical.
describe("mesh quality metrics track the solver", () => {
  test("core's Tet10 Gauss rule is the solver's rule", () => {
    expect(CORE_TET10_GAUSS_POINTS).toEqual(TET10_GAUSS_POINTS);
  });

  test("core's degeneracy tolerance is the solver's", () => {
    expect(MESH_QUALITY_POLICY.relativeVolumeTolerance).toBe(ELEMENT_GEOMETRY_POLICY.relativeVolumeTolerance);
  });
});
