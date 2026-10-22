// Dimensionless tetrahedral element-quality metrics (plan 036 R2.1). Display
// only: nothing here gates meshing or solving.
//
// Definitions follow the Verdict geometric quality library — C. J. Stimpson,
// C. D. Ernst, P. Knupp, P. P. Pébay, D. Thompson, "The Verdict Geometric
// Quality Library", Sandia report SAND2007-1751 — and P. M. Knupp, "Algebraic
// mesh quality metrics", SIAM J. Sci. Comput. 23(1), 2001:
//
// - Scaled Jacobian: the minimum over the four corners of
//   det[e_a, e_b, e_c] / (|e_a| |e_b| |e_c|) for the three edges leaving the
//   corner, times √2 so the regular tetrahedron scores 1. All corner
//   determinants equal 6V, so this is 6V·√2 / max(corner edge-length product).
//   Positive for valid, ≈ 0 for slivers, negative for inverted elements.
//   (Older Verdict tables omit the √2 and quote √2/2 for the regular tet.)
// - Aspect ratio: Verdict's radius ratio R / (3r), circumradius over three
//   times the inradius, so the regular tetrahedron scores 1 and it grows
//   without bound as the element degenerates. Orientation independent.
// - Dihedral angles: the six interior angles between face pairs; the regular
//   tetrahedron has acos(1/3) ≈ 70.53° everywhere.
// - Tet10: det J of the isoparametric map at each point of the solver's
//   4-point Gauss rule (TET10_GAUSS_POINTS, shared with @openfea/solver-cpu).
//   Shape metrics above use the four corner nodes, as Verdict does.
//
// All metrics are ratios of lengths, so they are identical at mm and m scale.
import { TET10_GAUSS_POINTS, tet10JacobianDeterminant } from "./mesh";

/**
 * Warning thresholds shown in the Mesh panel and report. Elements past these
 * are counted, never rejected; the meshing quality floor (minSICN) is separate.
 */
export const MESH_QUALITY_THRESHOLDS = Object.freeze({
  /** Below this scaled Jacobian an element is a sliver/needle that degrades stress accuracy. */
  scaledJacobianWarnBelow: 0.2,
  /** Above this radius ratio an element is outside Verdict's acceptable range [1, 3]. */
  aspectRatioWarnAbove: 3,
  /** Below this dihedral angle (degrees) two faces nearly fold onto each other (sliver). */
  minDihedralWarnBelowDeg: 10,
  /** Above this dihedral angle (degrees) two faces are nearly coplanar (flat/cap element). */
  maxDihedralWarnAboveDeg: 165,
  /**
   * Below this ratio of min det J to the largest |det J| over the Gauss points,
   * the curved Tet10 map is strongly non-uniform and its stiffness integration
   * is unreliable even though det J stays positive.
   */
  tet10DetJRatioWarnBelow: 0.1
});

export const MESH_QUALITY_POLICY = Object.freeze({
  /**
   * |6V| or |det J| at or below this times L³ (L = largest node-to-node
   * distance) counts as degenerate/non-positive. Mirrors solver-cpu's
   * ELEMENT_GEOMETRY_POLICY.relativeVolumeTolerance (pinned by a solver test),
   * so "non-positive det J" here means exactly what the solver rejects.
   */
  relativeVolumeTolerance: 1e-12,
  /** Fixed histogram size, so summary memory does not grow with the mesh. */
  histogramBinCount: 20,
  /** How many worst elements the summary keeps for viewer highlighting. */
  worstElementCount: 20,
  /** Percentile reported alongside worst and median, measured from the bad side. */
  tailPercentile: 0.05
});

const SQRT2 = Math.SQRT2;
const RADIANS_TO_DEGREES = 180 / Math.PI;

/** Corner -> its three outgoing edges as (from, to) pairs, Verdict L0..L5 grouping. */
const CORNER_EDGES = [
  [[0, 1], [0, 2], [0, 3]],
  [[1, 0], [1, 2], [1, 3]],
  [[2, 0], [2, 1], [2, 3]],
  [[3, 0], [3, 1], [3, 2]]
] as const;
/** Face opposite each vertex. */
const OPPOSITE_FACES = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]] as const;

export type TetShapeQuality = {
  scaledJacobian: number;
  /** +Infinity for a degenerate (zero-volume) element. */
  aspectRatio: number;
  minDihedralDeg: number;
  maxDihedralDeg: number;
  degenerate: boolean;
};

export type Tet10JacobianQuality = {
  minDetJ: number;
  maxDetJ: number;
  /** min det J / max |det J| over the Gauss points: 1 for an affine valid element, ≤ 0 when any point is non-positive. */
  detJRatio: number;
  /** Some Gauss point has det J at or below the solver's degeneracy tolerance. */
  nonPositive: boolean;
};

/** Shape metrics from the first four (corner) nodes of a Tet4 or Tet10 element. */
export function tetShapeQuality(coordinates: ArrayLike<number>, nodeIds: ArrayLike<number>): TetShapeQuality {
  const p = cornerPoints(coordinates, nodeIds);
  const a = sub(p[1], p[0]);
  const b = sub(p[2], p[0]);
  const c = sub(p[3], p[0]);
  const sixVolume = dot(a, cross(b, c));
  const length = characteristicLength(p);
  const degenerate = Math.abs(sixVolume) <= MESH_QUALITY_POLICY.relativeVolumeTolerance * length * length * length;

  let maxCornerProduct = 0;
  for (const corner of CORNER_EDGES) {
    let product = 1;
    for (const [from, to] of corner) product *= norm(sub(p[to], p[from]));
    if (product > maxCornerProduct) maxCornerProduct = product;
  }
  const scaledJacobian = degenerate || maxCornerProduct <= 0 ? 0 : (sixVolume * SQRT2) / maxCornerProduct;

  // Outward unit normals; orientation fixed geometrically so inverted elements
  // report the same angles as their mirror image.
  const normals = OPPOSITE_FACES.map(([i, j, k], opposite) => {
    const n = cross(sub(p[j], p[i]), sub(p[k], p[i]));
    const sign = dot(n, sub(p[opposite], p[i])) > 0 ? -1 : 1;
    return scale(n, sign);
  });
  let minDihedral = Number.POSITIVE_INFINITY;
  let maxDihedral = Number.NEGATIVE_INFINITY;
  for (let f = 0; f < 4; f += 1) {
    for (let g = f + 1; g < 4; g += 1) {
      // atan2 stays accurate near 0 and π where acos of a dot product does not.
      const between = Math.atan2(norm(cross(normals[f], normals[g])), dot(normals[f], normals[g]));
      const dihedral = (Math.PI - between) * RADIANS_TO_DEGREES;
      if (dihedral < minDihedral) minDihedral = dihedral;
      if (dihedral > maxDihedral) maxDihedral = dihedral;
    }
  }

  let aspectRatio = Number.POSITIVE_INFINITY;
  if (!degenerate) {
    const volume = Math.abs(sixVolume) / 6;
    const area = OPPOSITE_FACES.reduce((sum, [i, j, k]) => sum + norm(cross(sub(p[j], p[i]), sub(p[k], p[i]))) / 2, 0);
    const inradius = (3 * volume) / area;
    // |a|²(b×c) + |b|²(c×a) + |c|²(a×b) = 12 V R · (unit direction)
    const circumVector = add(add(scale(cross(b, c), dot(a, a)), scale(cross(c, a), dot(b, b))), scale(cross(a, b), dot(c, c)));
    const circumradius = norm(circumVector) / (12 * volume);
    aspectRatio = circumradius / (3 * inradius);
  }
  return { scaledJacobian, aspectRatio, minDihedralDeg: minDihedral, maxDihedralDeg: maxDihedral, degenerate };
}

/** det J of a Tet10 at each point of the solver's Gauss rule. */
export function tet10JacobianQuality(coordinates: ArrayLike<number>, nodeIds: ArrayLike<number>): Tet10JacobianQuality {
  let minDetJ = Number.POSITIVE_INFINITY;
  let maxDetJ = Number.NEGATIVE_INFINITY;
  let maxAbsDetJ = 0;
  for (const point of TET10_GAUSS_POINTS) {
    const detJ = tet10JacobianDeterminant(coordinates, nodeIds, point);
    if (detJ < minDetJ) minDetJ = detJ;
    if (detJ > maxDetJ) maxDetJ = detJ;
    if (Math.abs(detJ) > maxAbsDetJ) maxAbsDetJ = Math.abs(detJ);
  }
  const length = elementLength(coordinates, nodeIds, 10);
  const tolerance = MESH_QUALITY_POLICY.relativeVolumeTolerance * length * length * length;
  const nonPositive = !(minDetJ > tolerance);
  const detJRatio = maxAbsDetJ > tolerance ? minDetJ / maxAbsDetJ : 0;
  return { minDetJ, maxDetJ, detJRatio, nonPositive };
}

export type MeshQualityElementType = "Tet4" | "Tet10";

export type MeshQualityMetricStats = {
  /** Worst value over the elements (min or max depending on the metric's direction). */
  worst: number;
  /** 5th percentile measured from the bad side (nearest rank). */
  p5: number;
  median: number;
  /** Fixed-range histogram; values outside [min, max] are counted in the end bins. */
  histogram: { min: number; max: number; counts: number[] };
};

export type MeshQualityThresholds = { -readonly [Key in keyof typeof MESH_QUALITY_THRESHOLDS]: number };

export type MeshQualityMetricKey = "scaledJacobian" | "aspectRatio" | "minDihedralDeg" | "maxDihedralDeg" | "tet10DetJRatio";

export type MeshQualityMetricsSummary = {
  version: 1;
  elementType: MeshQualityElementType;
  elementCount: number;
  /** Zero-volume elements; excluded from the aspect-ratio statistics (their ratio is unbounded). */
  degenerateCount: number;
  metrics: {
    scaledJacobian: MeshQualityMetricStats;
    aspectRatio?: MeshQualityMetricStats;
    minDihedralDeg: MeshQualityMetricStats;
    maxDihedralDeg: MeshQualityMetricStats;
    /** Tet10 only. */
    tet10DetJRatio?: MeshQualityMetricStats;
  };
  /** Element counts past each warning threshold. */
  flagged: {
    scaledJacobian: number;
    aspectRatio: number;
    minDihedral: number;
    maxDihedral: number;
    tet10NonPositiveDetJ?: number;
    tet10DetJRatio?: number;
    /** Elements past at least one threshold. */
    any: number;
  };
  thresholds: MeshQualityThresholds;
  /** Element indices (mesh order), worst first, by min(scaled Jacobian, Tet10 det J ratio). */
  worstElements: number[];
};

type MetricSpec = { lowerIsWorse: boolean; histogramMin: number; histogramMax: number };

const METRIC_SPECS: Record<MeshQualityMetricKey, MetricSpec> = {
  scaledJacobian: { lowerIsWorse: true, histogramMin: 0, histogramMax: 1 },
  aspectRatio: { lowerIsWorse: false, histogramMin: 1, histogramMax: 6 },
  minDihedralDeg: { lowerIsWorse: true, histogramMin: 0, histogramMax: 90 },
  maxDihedralDeg: { lowerIsWorse: false, histogramMin: 60, histogramMax: 180 },
  tet10DetJRatio: { lowerIsWorse: true, histogramMin: 0, histogramMax: 1 }
};

/** True when the metric's worst values are its smallest. */
export function meshQualityMetricLowerIsWorse(metric: MeshQualityMetricKey): boolean {
  return METRIC_SPECS[metric].lowerIsWorse;
}

/**
 * Per-element metrics over a single-type tetrahedral mesh, reduced to a
 * bounded summary. O(elements) time; transient memory is one Float64Array per
 * metric, and the result holds fixed-size histograms plus a bounded worst list.
 */
export function computeTetMeshQuality(input: {
  coordinates: ArrayLike<number>;
  connectivity: ArrayLike<number>;
  elementType: MeshQualityElementType;
}): MeshQualityMetricsSummary | null {
  const nodesPerElement = input.elementType === "Tet10" ? 10 : 4;
  const elementCount = Math.floor(input.connectivity.length / nodesPerElement);
  if (elementCount === 0) return null;
  const isTet10 = input.elementType === "Tet10";
  const thresholds = MESH_QUALITY_THRESHOLDS;

  const scaledJacobian = new Float64Array(elementCount);
  const minDihedral = new Float64Array(elementCount);
  const maxDihedral = new Float64Array(elementCount);
  const aspectRatio = new Float64Array(elementCount);
  const detJRatio = isTet10 ? new Float64Array(elementCount) : null;
  let finiteAspectCount = 0;
  let degenerateCount = 0;
  const flagged = { scaledJacobian: 0, aspectRatio: 0, minDihedral: 0, maxDihedral: 0, tet10NonPositiveDetJ: 0, tet10DetJRatio: 0, any: 0 };
  const worst = new BoundedWorstList(MESH_QUALITY_POLICY.worstElementCount);
  const nodeIds = new Array<number>(nodesPerElement);

  for (let element = 0; element < elementCount; element += 1) {
    const offset = element * nodesPerElement;
    for (let local = 0; local < nodesPerElement; local += 1) nodeIds[local] = input.connectivity[offset + local];
    const shape = tetShapeQuality(input.coordinates, nodeIds);
    scaledJacobian[element] = shape.scaledJacobian;
    minDihedral[element] = shape.minDihedralDeg;
    maxDihedral[element] = shape.maxDihedralDeg;
    if (shape.degenerate) degenerateCount += 1;
    else aspectRatio[finiteAspectCount++] = shape.aspectRatio;

    let past = false;
    if (shape.scaledJacobian < thresholds.scaledJacobianWarnBelow) { flagged.scaledJacobian += 1; past = true; }
    if (shape.aspectRatio > thresholds.aspectRatioWarnAbove) { flagged.aspectRatio += 1; past = true; }
    if (shape.minDihedralDeg < thresholds.minDihedralWarnBelowDeg) { flagged.minDihedral += 1; past = true; }
    if (shape.maxDihedralDeg > thresholds.maxDihedralWarnAboveDeg) { flagged.maxDihedral += 1; past = true; }
    let severity = shape.scaledJacobian;
    if (detJRatio) {
      const jacobian = tet10JacobianQuality(input.coordinates, nodeIds);
      detJRatio[element] = jacobian.detJRatio;
      if (jacobian.nonPositive) { flagged.tet10NonPositiveDetJ += 1; past = true; }
      if (jacobian.detJRatio < thresholds.tet10DetJRatioWarnBelow) { flagged.tet10DetJRatio += 1; past = true; }
      severity = Math.min(severity, jacobian.nonPositive ? Math.min(jacobian.detJRatio, 0) : jacobian.detJRatio);
    }
    if (past) flagged.any += 1;
    worst.offer(element, severity);
  }

  const aspectStats = finiteAspectCount ? metricStats(aspectRatio.subarray(0, finiteAspectCount), "aspectRatio") : undefined;
  return {
    version: 1,
    elementType: input.elementType,
    elementCount,
    degenerateCount,
    metrics: {
      scaledJacobian: metricStats(scaledJacobian, "scaledJacobian"),
      ...(aspectStats ? { aspectRatio: aspectStats } : {}),
      minDihedralDeg: metricStats(minDihedral, "minDihedralDeg"),
      maxDihedralDeg: metricStats(maxDihedral, "maxDihedralDeg"),
      ...(detJRatio ? { tet10DetJRatio: metricStats(detJRatio, "tet10DetJRatio") } : {})
    },
    flagged: {
      scaledJacobian: flagged.scaledJacobian,
      aspectRatio: flagged.aspectRatio,
      minDihedral: flagged.minDihedral,
      maxDihedral: flagged.maxDihedral,
      ...(isTet10 ? { tet10NonPositiveDetJ: flagged.tet10NonPositiveDetJ, tet10DetJRatio: flagged.tet10DetJRatio } : {}),
      any: flagged.any
    },
    thresholds: { ...thresholds },
    worstElements: worst.indices()
  };
}

/** Consumes `values` (reorders it in place). */
function metricStats(values: Float64Array, metric: MeshQualityMetricKey): MeshQualityMetricStats {
  const spec = METRIC_SPECS[metric];
  const bins = MESH_QUALITY_POLICY.histogramBinCount;
  const counts = new Array<number>(bins).fill(0);
  const width = (spec.histogramMax - spec.histogramMin) / bins;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value < min) min = value;
    if (value > max) max = value;
    const bin = Math.floor((value - spec.histogramMin) / width);
    counts[bin < 0 ? 0 : bin >= bins ? bins - 1 : bin] += 1;
  }
  const last = values.length - 1;
  const tailRank = Math.floor(MESH_QUALITY_POLICY.tailPercentile * last);
  const p5 = select(values, spec.lowerIsWorse ? tailRank : last - tailRank);
  const median = select(values, Math.floor(0.5 * last));
  return {
    worst: spec.lowerIsWorse ? min : max,
    p5,
    median,
    histogram: { min: spec.histogramMin, max: spec.histogramMax, counts }
  };
}

/** k-th smallest value (0-based), expected O(n) Hoare quickselect; reorders `values`. */
function select(values: Float64Array, k: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = medianOfThree(values[left], values[(left + right) >>> 1], values[right]);
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i += 1;
      while (values[j] > pivot) j -= 1;
      if (i <= j) {
        const swap = values[i];
        values[i] = values[j];
        values[j] = swap;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
  return values[k];
}

function medianOfThree(a: number, b: number, c: number): number {
  return a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
}

/** Keeps the `capacity` lowest-severity elements, worst first. Ties keep mesh order. */
class BoundedWorstList {
  private readonly entries: Array<{ element: number; severity: number }> = [];
  constructor(private readonly capacity: number) {}

  offer(element: number, severity: number): void {
    const entries = this.entries;
    if (entries.length === this.capacity && !(severity < entries[entries.length - 1].severity)) return;
    let position = entries.length;
    while (position > 0 && severity < entries[position - 1].severity) position -= 1;
    entries.splice(position, 0, { element, severity });
    if (entries.length > this.capacity) entries.pop();
  }

  indices(): number[] {
    return this.entries.map((entry) => entry.element);
  }
}

type Vec3 = [number, number, number];

function cornerPoints(coordinates: ArrayLike<number>, nodeIds: ArrayLike<number>): [Vec3, Vec3, Vec3, Vec3] {
  const point = (local: number): Vec3 => {
    const node = nodeIds[local];
    return [coordinates[node * 3] ?? 0, coordinates[node * 3 + 1] ?? 0, coordinates[node * 3 + 2] ?? 0];
  };
  return [point(0), point(1), point(2), point(3)];
}

function characteristicLength(points: Vec3[]): number {
  let maximumSquared = 0;
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const d = sub(points[a], points[b]);
      const squared = dot(d, d);
      if (squared > maximumSquared) maximumSquared = squared;
    }
  }
  return Math.sqrt(maximumSquared);
}

function elementLength(coordinates: ArrayLike<number>, nodeIds: ArrayLike<number>, count: number): number {
  const points: Vec3[] = [];
  for (let local = 0; local < count; local += 1) {
    const node = nodeIds[local];
    points.push([coordinates[node * 3] ?? 0, coordinates[node * 3 + 1] ?? 0, coordinates[node * 3 + 2] ?? 0]);
  }
  return characteristicLength(points);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
