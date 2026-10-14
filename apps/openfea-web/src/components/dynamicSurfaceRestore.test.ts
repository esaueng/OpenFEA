import { expect, test } from "vitest";
import type { ResultField } from "@openfea/schema";
import { parseResultBundle } from "../appPersistence";
import { createPackedResultPlaybackCache } from "../resultFields";
import { buildSolverSurfaceResultGeometry, solverSurfaceResultFields } from "./CadViewer";

test("project roundtrip renders the final dynamic stress frame on its retained solver surface", () => {
  const surfaceMesh = {
    id: "solver-surface", nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    triangles: [[0, 1, 2]], nodeMap: [0, 4, 7], volumeNodeCount: 8
  };
  const fields: ResultField[] = [0, 20].flatMap((frameIndex) => [{
    id: `stress-${frameIndex}`, runId: "run-dynamic", type: "stress" as const,
    component: "von_mises" as const, location: "node" as const, surfaceMeshRef: surfaceMesh.id,
    values: frameIndex ? [1, 20, 40] : [0, 0, 0], min: 0, max: frameIndex ? 40 : 0,
    units: "MPa", frameIndex, timeSeconds: frameIndex / 200
  }]);
  const restored = parseResultBundle(JSON.parse(JSON.stringify({
    summary: { maxStress: 40, maxStressUnits: "MPa", maxDisplacement: 0.5, maxDisplacementUnits: "mm", safetyFactor: 5, reactionForce: 500, reactionForceUnits: "N" },
    fields, surfaceMesh
  })));
  expect(restored?.surfaceMesh).toBeDefined();
  const cache = createPackedResultPlaybackCache(restored!.fields)!;
  const selected = solverSurfaceResultFields(restored!.surfaceMesh, cache.fieldsForFrame(20), "stress")!;
  const geometry = buildSolverSurfaceResultGeometry({
    surfaceMesh: restored!.surfaceMesh!, scalarField: selected.scalarField,
    resultMode: "stress", showDeformed: false, deformationScale: 1
  });
  try {
    const colors = geometry.getAttribute("color");
    expect(colors.count).toBe(3);
    expect(colors.getZ(0)).toBeGreaterThan(colors.getX(0));
    expect(colors.getX(2)).toBeGreaterThan(colors.getZ(2));
    expect(selected.scalarField.values).toEqual([1, 20, 40]);
    expect(restored!.surfaceMesh!.nodeMap).toEqual([0, 4, 7]);
  } finally { geometry.dispose(); }
});
