type Vec3 = [number, number, number];

export type Triangle = {
  nodes: number[];
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
};

type Bounds = { min: Vec3; max: Vec3 };
type SpatialIndex = Bounds & ({ indices: number[] } | { children: [SpatialIndex, SpatialIndex] });

/** Balanced bounds tree: every facet is enclosed even when its centroid is far away. */
export function triangleSpatialIndex(triangles: Triangle[]): SpatialIndex | undefined {
  const bounds = triangles.map(({ a, b, c }): Bounds => ({
    min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
    max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])]
  }));
  function build(indices: number[]): SpatialIndex {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const index of indices) for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], bounds[index].min[axis]);
      max[axis] = Math.max(max[axis], bounds[index].max[axis]);
    }
    if (indices.length <= 8) return { min, max, indices };
    let splitAxis = 0;
    for (let axis = 1; axis < 3; axis += 1) if (max[axis] - min[axis] > max[splitAxis] - min[splitAxis]) splitAxis = axis;
    const center = (index: number): number => bounds[index].min[splitAxis] / 2 + bounds[index].max[splitAxis] / 2;
    indices.sort((left, right) => center(left) - center(right) || left - right);
    const middle = Math.floor(indices.length / 2);
    return { min, max, children: [build(indices.slice(0, middle)), build(indices.slice(middle))] };
  }
  return triangles.length ? build(triangles.map((_, index) => index)) : undefined;
}

/** Exact nearest-facet selection; bounds prune only facets that cannot improve it. */
export function nearestProjection(point: Vec3, triangles: Triangle[], spatial: SpatialIndex | undefined, tolerance: number): { triangle: Triangle; barycentric: Vec3 } | undefined {
  let best: { triangle: Triangle; barycentric: Vec3; distance: number; index: number } | undefined;
  function visit(node: SpatialIndex, lowerBound: number): void {
    if (lowerBound > Math.min(tolerance, best?.distance ?? Infinity)) return;
    if ("indices" in node) {
      for (const index of node.indices) {
        const triangle = triangles[index];
        const { a, b, c } = triangle;
        const barycentric = closestPointBarycentric(point, a, b, c);
        const surfacePoint = add(add(scale(a, barycentric[0]), scale(b, barycentric[1])), scale(c, barycentric[2]));
        const distance = norm(subtract(point, surfacePoint));
        if (distance <= tolerance && (!best || distance < best.distance || (distance === best.distance && index < best.index))) {
          best = { triangle, barycentric, distance, index };
        }
      }
      return;
    }
    const [left, right] = node.children;
    const leftDistance = boundsDistance(point, left), rightDistance = boundsDistance(point, right);
    if (leftDistance <= rightDistance) {
      visit(left, leftDistance);
      visit(right, rightDistance);
    } else {
      visit(right, rightDistance);
      visit(left, leftDistance);
    }
  }
  if (spatial) visit(spatial, boundsDistance(point, spatial));
  return best;
}

function boundsDistance(point: Vec3, bounds: Bounds): number {
  // This padding only makes pruning conservative under floating-point rounding.
  // Acceptance still uses the original distance and caller's exact tolerance.
  const gaps: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const padding = 16 * Number.EPSILON * Math.max(1, Math.abs(point[axis]), Math.abs(bounds.min[axis]), Math.abs(bounds.max[axis]));
    gaps[axis] = Math.max(0, bounds.min[axis] - point[axis] - padding, point[axis] - bounds.max[axis] - padding);
  }
  return norm(gaps);
}

/** Closest point barycentrics from Real-Time Collision Detection, Ericson. */
function closestPointBarycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = subtract(b, a), ac = subtract(c, a), ap = subtract(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = subtract(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = subtract(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return [1 - v - w, v, w];
}

function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, value: number): Vec3 { return [a[0] * value, a[1] * value, a[2] * value]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
