import { describe, expect, test } from "vitest";
import { elevateTet4MeshToTet10, normalizeModelJson, type OpenFEAModelJson, type SolverSurfaceMesh } from "@openfea/core";
import { solveStaticLinearTet4Cpu, staticPeakSurfaceLocations } from "../src";
import { createStructuredCantileverModel } from "./helpers";

const LENGTH = 1;
const WIDTH = 0.1;
const HEIGHT = 0.1;

function cantilever(elementType: "Tet4" | "Tet10"): OpenFEAModelJson {
  const model = createStructuredCantileverModel({ length: LENGTH, width: WIDTH, height: HEIGHT, force: 1000, xDivisions: 10, yDivisions: 2, zDivisions: 2 });
  if (elementType === "Tet4") return model;
  const tet4 = model.elementBlocks[0]!.connectivity;
  const elements = Array.from({ length: tet4.length / 4 }, (_value, index) => tet4.slice(index * 4, index * 4 + 4));
  const elevated = elevateTet4MeshToTet10({ coordinates: model.nodes.coordinates, elements });
  const coordinates = elevated.coordinates;
  const nodesAtX = (x: number) => Array.from({ length: coordinates.length / 3 }, (_value, node) => node).filter((node) => Math.abs(coordinates[node * 3]! - x) < 1e-9);
  const tipNodes = nodesAtX(LENGTH);
  return {
    ...model,
    nodes: { coordinates },
    elementBlocks: [{ ...model.elementBlocks[0]!, type: "Tet10", connectivity: elevated.elements.flat() }],
    surfaceFacets: undefined,
    surfaceSets: [],
    nodeSets: [{ name: "fixedNodes", nodes: nodesAtX(0) }, { name: "tipNodes", nodes: tipNodes }],
    loads: [{ name: "tipLoad", type: "nodalForce", nodeSet: "tipNodes", vector: [0, 0, -1000 / tipNodes.length] }]
  } as OpenFEAModelJson;
}

describe("static peak surface locations", () => {
  for (const elementType of ["Tet4", "Tet10"] as const) {
    test(`${elementType} cantilever reports the stress peak at the root outer fibre and the displacement peak at the tip`, () => {
      const solved = solveStaticLinearTet4Cpu(cantilever(elementType), { tolerance: 1e-12 });
      expect(solved.ok).toBe(true);
      if (!solved.ok) return;
      const core = solved.result.coreResult!;
      const locations = core.summary.peakLocations;
      const surfaceMesh = core.surfaceMesh!;
      expect(locations?.stress?.surfaceMeshId).toBe(surfaceMesh.id);
      expect(locations?.displacement?.surfaceMeshId).toBe(surfaceMesh.id);

      // The located element carries exactly the reported peak.
      const peaks = solved.result.vonMisesPeak!;
      const reported = core.artifacts!.rawMaxStress as number;
      expect(peaks[locations!.stress!.elementIndex!]).toBe(reported);

      // The anchor is a node of that element, in the root bay.
      const anchorVolumeNode = surfaceMesh.nodeMap[locations!.stress!.surfaceNodeIndex]!;
      const nodesPerElement = elementType === "Tet4" ? 4 : 10;
      const connectivity = cantilever(elementType).elementBlocks[0]!.connectivity;
      const elementNodes = connectivity.slice(locations!.stress!.elementIndex! * nodesPerElement, (locations!.stress!.elementIndex! + 1) * nodesPerElement);
      expect(elementNodes).toContain(anchorVolumeNode);
      const [x, , z] = surfaceMesh.nodes[locations!.stress!.surfaceNodeIndex]!;
      expect(x).toBeLessThanOrEqual(LENGTH / 10 + 1e-9);
      // Tet10 samples the linear in-element field at its nodes, so the peak sits on the
      // outer fibre; a constant-stress Tet4 element is located by any of its surface nodes.
      if (elementType === "Tet10") expect(Math.abs(Math.abs(z) - HEIGHT / 2)).toBeLessThan(1e-9);

      const tipNode = surfaceMesh.nodes[locations!.displacement!.surfaceNodeIndex]!;
      expect(tipNode[0]).toBeCloseTo(LENGTH, 9);
      const volumeNode = surfaceMesh.nodeMap[locations!.displacement!.surfaceNodeIndex]!;
      const displacement = solved.result.displacement;
      expect(Math.hypot(displacement[volumeNode * 3]!, displacement[volumeNode * 3 + 1]!, displacement[volumeNode * 3 + 2]!))
        .toBe(core.artifacts!.rawMaxDisplacement);
    });
  }

  test("an interior peak gets no location instead of a guessed one", () => {
    const normalized = normalizeModelJson(cantilever("Tet10"));
    if (!normalized.ok) throw new Error("model did not normalize");
    const model = normalized.model;
    const nodeCount = model.nodes.coordinates.length / 3;
    const peakElement = 3;
    const peakNode = model.elementBlocks[0]!.connectivity[peakElement * 10 + 4]!;
    const vonMises = new Float64Array(model.counts.elements).fill(1);
    const vonMisesPeak = Float64Array.from(vonMises);
    vonMisesPeak[peakElement] = 9;
    const vonMisesPeakNode = new Int32Array(model.counts.elements).fill(-1);
    vonMisesPeakNode[peakElement] = peakNode;
    const displacement = new Float64Array(nodeCount * 3);
    displacement[peakNode * 3 + 2] = -1;
    // A surface mesh that does not contain the peak node: the peak lies inside the body.
    const otherNodes = Array.from({ length: nodeCount }, (_value, node) => node).filter((node) => node !== peakNode).slice(0, 3);
    const surfaceMesh: SolverSurfaceMesh = {
      id: "surface",
      nodes: otherNodes.map(() => [0, 0, 0]),
      triangles: [[0, 1, 2]],
      coordinateSpace: "solver",
      source: "opencae_core_volume_mesh",
      nodeMap: otherNodes
    };
    expect(staticPeakSurfaceLocations(model, surfaceMesh, { displacement, vonMises, vonMisesPeak, vonMisesPeakNode })).toEqual({});

    // The same peak on the surface is located at that node, not elsewhere in the element.
    const withPeak = { ...surfaceMesh, nodes: [...surfaceMesh.nodes, [0, 0, 0] as [number, number, number]], nodeMap: [...otherNodes, peakNode] };
    expect(staticPeakSurfaceLocations(model, withPeak, { displacement, vonMises, vonMisesPeak, vonMisesPeakNode })).toEqual({
      stress: { surfaceMeshId: "surface", surfaceNodeIndex: 3, elementIndex: peakElement },
      displacement: { surfaceMeshId: "surface", surfaceNodeIndex: 3 }
    });
  });
});
