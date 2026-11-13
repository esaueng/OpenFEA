import type { NormalizedOpenFEAModel } from "@openfea/core";
import { addSparseEntry, createSparseMatrixBuilder, csrMatVec, toCsrMatrix, type CsrMatrix } from "./sparse";
import type { CpuSolverError, ElasticSupportDiagnostics } from "./types";

export type { ElasticSupportDiagnostics } from "./types";

/**
 * Elastic (Winkler foundation) supports, plan 036 R1.5.
 *
 * Each support face carries distributed linear springs with a normal and a
 * tangential stiffness per unit area per unit displacement (foundation modulus
 * k, N/m^3 in m-N-s-Pa models and N/mm^3 in mm-N-s-MPa models). The face
 * stiffness is the consistent matrix
 *
 *   K_e = integral over the face of N^T N dA  (x)  (k_n n n^T + k_t (I - n n^T))
 *
 * with the facet's own unit normal n. For straight-sided Tri3 and Tri6 facets
 * the scalar matrix integral N_a N_b dA is exact in closed form (below). K_e is
 * symmetric positive semidefinite per facet, and positive definite on the face
 * DOFs when both stiffnesses are positive, so a model held only by such a face
 * has no rigid-body modes.
 *
 * Approximations, stated wherever the support is shown: the springs act
 * independently (no shear coupling through the foundation), carry tension as
 * well as compression (no lift-off), and use each facet's flat corner geometry.
 */

/** Scalar consistent "mass" matrix of a Tri3 facet, times 12 / area. */
const TRI3_FACE_MATRIX = [
  2, 1, 1,
  1, 2, 1,
  1, 1, 2
] as const;
const TRI3_FACE_DIVISOR = 12;

/**
 * Scalar consistent matrix of a straight-sided Tri6 facet, times 180 / area.
 * Node order: corners a, b, c, then midsides (a,b), (b,c), (c,a), as built by
 * the Tet10 face tables and Tet4 -> Tet10 elevation. A corner couples with -4
 * to the midside of its opposite edge and 0 to its two adjacent midsides.
 * Corner rows sum to 0 and midside rows to 60, matching the consistent load
 * vector of a uniform traction (corners 0, midsides area / 3).
 */
const TRI6_FACE_MATRIX = [
  6, -1, -1, 0, -4, 0,
  -1, 6, -1, 0, 0, -4,
  -1, -1, 6, -4, 0, 0,
  0, 0, -4, 32, 16, 16,
  -4, 0, 0, 16, 32, 16,
  0, -4, 0, 16, 16, 32
] as const;
const TRI6_FACE_DIVISOR = 180;

export type ElasticSupportAssembly = {
  /** Global 3N x 3N foundation stiffness, or undefined when no active elastic support exists. */
  matrix?: CsrMatrix;
  diagnostics?: ElasticSupportDiagnostics;
};

/** Active elastic-support conditions of a step. */
export function activeElasticSupports(model: NormalizedOpenFEAModel, boundaryConditionNames: readonly string[] | undefined) {
  if (!boundaryConditionNames?.length) return [];
  const active = new Set(boundaryConditionNames);
  return model.boundaryConditions.flatMap((condition) => condition.type === "elasticSupport" && active.has(condition.name) ? [condition] : []);
}

/** Scalar consistent face matrix entry count for one facet (for triplet capacity). */
export function elasticSupportTripletCount(model: NormalizedOpenFEAModel, boundaryConditionNames: readonly string[] | undefined): number {
  const supports = activeElasticSupports(model, boundaryConditionNames);
  if (!supports.length) return 0;
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  const surfaceSets = new Map(model.surfaceSets.map((set) => [set.name, set]));
  let count = 0;
  for (const support of supports) {
    for (const facetId of surfaceSets.get(support.surfaceSet)?.facets ?? []) {
      const nodes = facets.get(facetId)?.nodes.length ?? 0;
      count += (3 * nodes) ** 2;
    }
  }
  return count;
}

/**
 * Assembles the foundation stiffness of every elastic support active in the
 * step. Facets are integrated with their corner geometry; a Tri6 facet uses
 * the exact straight-sided Tri6 matrix. Facets sliced to three nodes (the
 * modal Tet10 -> Tet4 projection) use the Tri3 matrix.
 */
export function assembleElasticSupportStiffness(
  model: NormalizedOpenFEAModel,
  boundaryConditionNames: readonly string[] | undefined
): { ok: true; assembly: ElasticSupportAssembly } | { ok: false; error: CpuSolverError } {
  const supports = activeElasticSupports(model, boundaryConditionNames);
  if (!supports.length) return { ok: true, assembly: {} };
  const dofs = model.counts.nodes * 3;
  const builder = createSparseMatrixBuilder(dofs, dofs, elasticSupportTripletCount(model, boundaryConditionNames));
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  const surfaceSets = new Map(model.surfaceSets.map((set) => [set.name, set]));
  const coordinates = model.nodes.coordinates;
  let facetCount = 0;
  let totalArea = 0;
  for (const support of supports) {
    const kn = support.normalStiffness;
    const kt = support.tangentialStiffness;
    if (!(kn >= 0) || !(kt >= 0) || !Number.isFinite(kn) || !Number.isFinite(kt) || !(kn > 0 || kt > 0)) {
      return failure("invalid-elastic-support", `Elastic support ${support.name} needs finite, non-negative stiffnesses with at least one positive.`);
    }
    const surfaceSet = surfaceSets.get(support.surfaceSet);
    if (!surfaceSet?.facets.length) {
      return failure("missing-elastic-support-surface", `Elastic support ${support.name} references an empty or missing surface set ${support.surfaceSet}.`);
    }
    let supportArea = 0;
    for (const facetId of surfaceSet.facets) {
      const facet = facets.get(facetId);
      if (!facet) return failure("missing-surface-facet", `Elastic support ${support.name} references missing surface facet ${facetId}.`);
      const nodes = facet.nodes;
      const geometry = flatFacetGeometry(coordinates, nodes[0]!, nodes[1]!, nodes[2]!);
      if (!(geometry.area > 0)) continue;
      const [scalar, divisor] = nodes.length === 6 ? [TRI6_FACE_MATRIX, TRI6_FACE_DIVISOR] : [TRI3_FACE_MATRIX, TRI3_FACE_DIVISOR];
      const nodeCount = nodes.length === 6 ? 6 : 3;
      const n = geometry.normal;
      // Directional 3x3 spring tensor kn n n^T + kt (I - n n^T).
      const tensor = new Float64Array(9);
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) {
          tensor[i * 3 + j] = (kn - kt) * n[i]! * n[j]! + (i === j ? kt : 0);
        }
      }
      const scale = geometry.area / divisor;
      for (let a = 0; a < nodeCount; a += 1) {
        const rowNode = nodes[a]!;
        for (let b = 0; b < nodeCount; b += 1) {
          const weight = scalar[a * nodeCount + b]! * scale;
          if (weight === 0) continue;
          const colNode = nodes[b]!;
          for (let i = 0; i < 3; i += 1) {
            for (let j = 0; j < 3; j += 1) {
              const value = weight * tensor[i * 3 + j]!;
              if (value !== 0) addSparseEntry(builder, rowNode * 3 + i, colNode * 3 + j, value);
            }
          }
        }
      }
      supportArea += geometry.area;
      facetCount += 1;
    }
    if (!(supportArea > 0)) {
      return failure("degenerate-elastic-support-surface", `Elastic support ${support.name} has no facet with positive area.`);
    }
    totalArea += supportArea;
  }
  return {
    ok: true,
    assembly: {
      matrix: toCsrMatrix(builder),
      diagnostics: { supportCount: supports.length, facetCount, area: totalArea, formulation: "consistent-face-winkler-foundation" }
    }
  };
}

/** Foundation force on the body, -K_found u, at every DOF. */
export function elasticSupportForce(matrix: CsrMatrix | undefined, displacement: Float64Array): Float64Array | undefined {
  if (!matrix) return undefined;
  const force = csrMatVec(matrix, displacement);
  for (let index = 0; index < force.length; index += 1) force[index] = -force[index]!;
  return force;
}

function flatFacetGeometry(coordinates: Float64Array, a: number, b: number, c: number): { area: number; normal: [number, number, number] } {
  const ux = coordinates[b * 3]! - coordinates[a * 3]!;
  const uy = coordinates[b * 3 + 1]! - coordinates[a * 3 + 1]!;
  const uz = coordinates[b * 3 + 2]! - coordinates[a * 3 + 2]!;
  const vx = coordinates[c * 3]! - coordinates[a * 3]!;
  const vy = coordinates[c * 3 + 1]! - coordinates[a * 3 + 1]!;
  const vz = coordinates[c * 3 + 2]! - coordinates[a * 3 + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return length > 0 && Number.isFinite(length)
    ? { area: length / 2, normal: [nx / length, ny / length, nz / length] }
    : { area: 0, normal: [0, 0, 0] };
}

function failure(code: string, message: string): { ok: false; error: CpuSolverError } {
  return { ok: false, error: { code, message } };
}
