import type { NormalizedOpenFEAModel } from "@openfea/core";
import { addSparseEntry, type SparseMatrixBuilder } from "./sparse";
import type { CpuSolverError } from "./types";
import { nearestProjection, triangleSpatialIndex, type Triangle } from "./connection-projection";

export type ConnectionAssemblyDiagnostics = {
  connectionCount: number;
  equationCount: number;
  unmatchedSourceNodes: number;
  formulation: "node-to-surface-penalty-mpc";
  kinematics: "small_sliding";
};

type Vec3 = [number, number, number];

export function assembleMeshConnectionStiffness(
  builder: SparseMatrixBuilder,
  model: NormalizedOpenFEAModel
): { ok: true; diagnostics: ConnectionAssemblyDiagnostics } | { ok: false; error: CpuSolverError } {
  const connections = model.meshConnections.filter((connection) => connection.type === "tie" || connection.type === "contact");
  const diagnostics: ConnectionAssemblyDiagnostics = {
    connectionCount: connections.length,
    equationCount: 0,
    unmatchedSourceNodes: 0,
    formulation: "node-to-surface-penalty-mpc",
    kinematics: "small_sliding"
  };
  if (!connections.length) return { ok: true, diagnostics };
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  const surfaceSets = new Map(model.surfaceSets.map((surface) => [surface.name, surface]));
  const characteristicLength = meshCharacteristicLength(model);
  const maxYoung = Math.max(...model.materials.map((material) => material.youngModulus));

  for (const connection of connections) {
    const sourceSet = surfaceSets.get(connection.source);
    const targetSet = surfaceSets.get(connection.target);
    if (!sourceSet || !targetSet) return failure("missing-connection-surface", `Connection ${connection.source} -> ${connection.target} references a missing surface set.`);
    const sourceNodes = new Set<number>();
    for (const facetId of sourceSet.facets) for (const node of facets.get(facetId)?.nodes ?? []) sourceNodes.add(node);
    const targetTriangles: Triangle[] = [];
    for (const facetId of targetSet.facets) {
      const facet = facets.get(facetId);
      if (!facet || facet.nodes.length < 3) continue;
      const a = point(model, facet.nodes[0]), b = point(model, facet.nodes[1]), c = point(model, facet.nodes[2]);
      const normal = normalized(cross(subtract(b, a), subtract(c, a)));
      if (norm(normal) <= Number.EPSILON) continue;
      targetTriangles.push({ nodes: Array.from(facet.nodes), a, b, c, normal });
    }
    if (!sourceNodes.size || !targetTriangles.length) return failure("empty-connection-surface", `Connection ${connection.source} -> ${connection.target} has an empty source or target surface.`);
    const tolerance = connection.searchTolerance ?? Math.max(characteristicLength * 0.2, Number.EPSILON);
    const spatial = triangleSpatialIndex(targetTriangles);
    const penalty = maxYoung * characteristicLength * (connection.penaltyScale ?? (connection.type === "tie" ? 100 : 20));
    let matched = 0;
    let unmatched = 0;
    for (const sourceNode of sourceNodes) {
      const sourcePoint = point(model, sourceNode);
      const projection = nearestProjection(sourcePoint, targetTriangles, spatial, tolerance);
      if (!projection) {
        diagnostics.unmatchedSourceNodes += 1;
        unmatched += 1;
        continue;
      }
      matched += 1;
      const surfaceWeights = targetShapeWeights(projection.triangle.nodes.length, projection.barycentric);
      const scalarTerms = [{ node: sourceNode, coefficient: 1 }];
      for (let local = 0; local < surfaceWeights.length; local += 1) {
        if (Math.abs(surfaceWeights[local]) <= Number.EPSILON) continue;
        scalarTerms.push({ node: projection.triangle.nodes[local], coefficient: -surfaceWeights[local] });
      }
      if (connection.type === "tie") {
        for (let axis = 0; axis < 3; axis += 1) {
          addPenaltyEquation(builder, scalarTerms.map((term) => ({ dof: term.node * 3 + axis, coefficient: term.coefficient })), penalty);
          diagnostics.equationCount += 1;
        }
      } else {
        const normalTerms = scalarTerms.flatMap((term) => projection.triangle.normal.map((component, axis) => ({
          dof: term.node * 3 + axis,
          coefficient: term.coefficient * component
        }))).filter((term) => Math.abs(term.coefficient) > Number.EPSILON);
        addPenaltyEquation(builder, normalTerms, penalty);
        diagnostics.equationCount += 1;
      }
    }
    if (matched === 0 || (connection.type === "tie" && unmatched > 0)) {
      return failure("connection-search-failed", `Connection ${connection.source} -> ${connection.target} could not map every source node within ${tolerance} solver units.`);
    }
  }
  return { ok: true, diagnostics };
}

function addPenaltyEquation(builder: SparseMatrixBuilder, terms: Array<{ dof: number; coefficient: number }>, penalty: number): void {
  for (const row of terms) for (const col of terms) addSparseEntry(builder, row.dof, col.dof, penalty * row.coefficient * col.coefficient);
}

function targetShapeWeights(nodeCount: number, barycentric: Vec3): number[] {
  const [l0, l1, l2] = barycentric;
  if (nodeCount < 6) return [l0, l1, l2];
  return [
    l0 * (2 * l0 - 1),
    l1 * (2 * l1 - 1),
    l2 * (2 * l2 - 1),
    4 * l0 * l1,
    4 * l1 * l2,
    4 * l2 * l0
  ];
}

function meshCharacteristicLength(model: NormalizedOpenFEAModel): number {
  const coordinates = model.nodes.coordinates;
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let node = 0; node < model.counts.nodes; node += 1) for (let axis = 0; axis < 3; axis += 1) {
    const value = coordinates[node * 3 + axis];
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  }
  return Math.max(norm(subtract(max, min)) / Math.cbrt(Math.max(model.counts.elements, 1)), 1e-12);
}

function point(model: NormalizedOpenFEAModel, node: number): Vec3 {
  return [model.nodes.coordinates[node * 3], model.nodes.coordinates[node * 3 + 1], model.nodes.coordinates[node * 3 + 2]];
}
function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a: Vec3, value: number): Vec3 { return [a[0] * value, a[1] * value, a[2] * value]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
function normalized(a: Vec3): Vec3 { const length = Math.max(norm(a), Number.EPSILON); return scale(a, 1 / length); }
function failure(code: string, message: string): { ok: false; error: CpuSolverError } { return { ok: false, error: { code, message } }; }
