import type { ResultField } from "@openfea/schema";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { resultPeakCalloutPoint, resultPeakLocationForMode, solverSurfaceDisplayFootprint } from "./CadViewer";

// A 1 m x 0.1 m x 0.2 m block in solver space (metres, Z-up), as the solver surface mesh arrives.
const surfaceMesh = {
  id: "run-surface",
  nodes: [
    [0, 0, 0], [1, 0, 0], [1, 0.1, 0], [0, 0.1, 0],
    [0, 0, 0.2], [1, 0, 0.2], [1, 0.1, 0.2], [0, 0.1, 0.2],
    [0.5, 0.05, 0.1]
  ] as [number, number, number][],
  triangles: [[0, 1, 5], [0, 5, 4], [3, 2, 6], [3, 6, 7], [4, 5, 6], [4, 6, 7]] as [number, number, number][],
  coordinateSpace: "solver" as const,
  source: "opencae_core_volume_mesh" as const,
  nodeMap: [0, 1, 2, 3, 4, 5, 6, 7, 8]
};

// The same block in display space: millimetres, Y-up after the legacy sample base rotation.
const displayBounds = new THREE.Box3(new THREE.Vector3(-500, -100, -50), new THREE.Vector3(500, 100, 50));
const baseRotation: [number, number, number] = [-Math.PI / 2, 0, 0];

describe("result peak callout placement", () => {
  test("maps a located surface node into the display footprint the result surface renders in", () => {
    const footprint = solverSurfaceDisplayFootprint(surfaceMesh, displayBounds, baseRotation);
    const point = resultPeakCalloutPoint({
      surfaceMesh,
      location: { surfaceMeshId: "run-surface", surfaceNodeIndex: 1 },
      footprint,
      showDeformed: false,
      deformationScale: 1
    });
    expect(footprint.scale).toBeCloseTo(1000, 9);
    // Node 1 is the solver (x max, y min, z min) corner; it lands on the matching corner
    // of the display bounds rotated into the outer (Z-up) results frame.
    const rotated = displayBounds.clone().applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...baseRotation)));
    expect(point?.[0]).toBeCloseTo(rotated.max.x, 6);
    expect(point?.[1]).toBeCloseTo(rotated.min.y, 6);
    expect(point?.[2]).toBeCloseTo(rotated.min.z, 6);
  });

  test("follows the deformed surface the same way result probes do", () => {
    const displacementField: ResultField = {
      id: "displacement",
      runId: "run",
      type: "displacement",
      location: "node",
      values: surfaceMesh.nodes.map(() => 1),
      vectors: surfaceMesh.nodes.map(() => [0, 0, -1] as [number, number, number]),
      min: 1,
      max: 1,
      units: "mm",
      surfaceMeshRef: surfaceMesh.id
    };
    const args = { surfaceMesh, location: { surfaceMeshId: "run-surface", surfaceNodeIndex: 5 }, footprint: null, displacementField, deformationScale: 1 };
    const undeformed = resultPeakCalloutPoint({ ...args, showDeformed: false });
    const deformed = resultPeakCalloutPoint({ ...args, showDeformed: true });
    expect(undeformed).toEqual([1, 0, 0.2]);
    expect(deformed?.[0]).toBeCloseTo(1, 12);
    expect(deformed?.[2]).toBeLessThan(0.2);
  });

  test("shows nothing when the location cannot be trusted on this mesh", () => {
    const base = { surfaceMesh, footprint: null, showDeformed: false, deformationScale: 1 };
    expect(resultPeakCalloutPoint({ ...base, location: undefined })).toBeNull();
    expect(resultPeakCalloutPoint({ ...base, location: { surfaceMeshId: "other-surface", surfaceNodeIndex: 1 } })).toBeNull();
    expect(resultPeakCalloutPoint({ ...base, location: { surfaceMeshId: "run-surface", surfaceNodeIndex: 99 } })).toBeNull();
    // Node 8 belongs to no rendered triangle.
    expect(resultPeakCalloutPoint({ ...base, location: { surfaceMeshId: "run-surface", surfaceNodeIndex: 8 } })).toBeNull();
  });

  test("only von Mises stress and displacement have a located peak", () => {
    const locations = {
      stress: { surfaceMeshId: "run-surface", surfaceNodeIndex: 1, elementIndex: 4 },
      displacement: { surfaceMeshId: "run-surface", surfaceNodeIndex: 5 }
    };
    expect(resultPeakLocationForMode(locations, "stress", "von_mises")).toBe(locations.stress);
    expect(resultPeakLocationForMode(locations, "stress", "principal_max")).toBeUndefined();
    expect(resultPeakLocationForMode(locations, "displacement", "von_mises")).toBe(locations.displacement);
    expect(resultPeakLocationForMode(locations, "safety_factor", "von_mises")).toBeUndefined();
    expect(resultPeakLocationForMode(undefined, "stress", "von_mises")).toBeUndefined();
  });
});
