import { describe, expect, test } from "vitest";
import { nearestProjection, triangleSpatialIndex, type Triangle } from "../src/connection-projection";

type Vec3 = [number, number, number];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const combine = (a: Vec3, b: Vec3, factor: number): Vec3 => [a[0] + b[0] * factor, a[1] + b[1] * factor, a[2] + b[2] * factor];
const distance = (a: Vec3, b: Vec3): number => Math.hypot(...subtract(a, b));

function triangle(a: Vec3, b: Vec3, c: Vec3): Triangle {
  return { nodes: [0, 1, 2], a, b, c, normal: [0, 0, 1] };
}

// Independent exhaustive oracle: project onto the plane and, if outside the
// triangle, minimize over all three segments rather than the production
// closest-point region tests. Always visit every facet in input order.
function exhaustiveProjection(point: Vec3, triangles: Triangle[], tolerance: number) {
  let best: { triangle: Triangle; point: Vec3; distance: number } | undefined;
  for (const entry of triangles) {
    const ab = subtract(entry.b, entry.a), ac = subtract(entry.c, entry.a), ap = subtract(point, entry.a);
    const aa = dot(ab, ab), cc = dot(ac, ac), bc = dot(ab, ac);
    const determinant = aa * cc - bc * bc;
    const v = (dot(ap, ab) * cc - dot(ap, ac) * bc) / determinant;
    const w = (dot(ap, ac) * aa - dot(ap, ab) * bc) / determinant;
    const candidates: Vec3[] = [];
    if (v >= 0 && w >= 0 && v + w <= 1) candidates.push(combine(combine(entry.a, ab, v), ac, w));
    for (const [start, end] of [[entry.a, entry.b], [entry.b, entry.c], [entry.c, entry.a]]) {
      const edge = subtract(end, start);
      const fraction = Math.max(0, Math.min(1, dot(subtract(point, start), edge) / dot(edge, edge)));
      candidates.push(combine(start, edge, fraction));
    }
    for (const projected of candidates) {
      const separation = distance(point, projected);
      if (separation <= tolerance && (!best || separation < best.distance)) best = { triangle: entry, point: projected, distance: separation };
    }
  }
  return best;
}

function checkAgainstOracle(point: Vec3, triangles: Triangle[], tolerance: number, accuracy: number) {
  const expected = exhaustiveProjection(point, triangles, tolerance);
  const actual = nearestProjection(point, triangles, triangleSpatialIndex(triangles), tolerance);
  if (!expected) {
    expect(actual).toBeUndefined();
    return;
  }
  expect(actual?.triangle).toBe(expected.triangle);
  if (!actual) return;
  const [u, v, w] = actual.barycentric;
  const actualPoint: Vec3 = [0, 1, 2].map((axis) => actual.triangle.a[axis] * u + actual.triangle.b[axis] * v + actual.triangle.c[axis] * w) as Vec3;
  expect(distance(actualPoint, expected.point)).toBeLessThan(accuracy);
}

describe("connection nearest-facet search", () => {
  test("a nearby distractor cannot hide a large facet whose centroid is distant", () => {
    const target = triangle([0, 0, 0], [100, 0, 0], [0, 100, 0]);
    const distractor = triangle([0, 0, 1], [0.3, 0, 1], [0, 0.3, 1]);
    const point: Vec3 = [0.1, 0.1, 1e-5];
    for (const entries of [[target], [target, distractor], [distractor, target]]) {
      expect(nearestProjection(point, entries, triangleSpatialIndex(entries), 0.01)?.triangle).toBe(target);
      checkAgainstOracle(point, entries, 0.01, 1e-10);
    }
  });

  test("chooses the globally nearest facet even when a local candidate passes tolerance", () => {
    const target = triangle([0, 0, 0], [100, 0, 0], [0, 100, 0]);
    const fartherValid = triangle([0, 0, 0.005], [0.3, 0, 0.005], [0, 0.3, 0.005]);
    const distractors = Array.from({ length: 32 }, (_, index) => triangle([index + 1, 0, 1], [index + 1.2, 0, 1], [index + 1, 0.2, 1]));
    const point: Vec3 = [0.1, 0.1, 1e-5];
    for (const entries of [[target, fartherValid, ...distractors], [fartherValid, ...distractors, target]]) {
      expect(nearestProjection(point, entries, triangleSpatialIndex(entries), 0.01)?.triangle).toBe(target);
      checkAgainstOracle(point, entries, 0.01, 1e-10);
    }
  });

  test("finds elongated facets near their far end, including closest-edge and vertex cases", () => {
    const target = triangle([-100_000, 0, 0], [100_000, 0, 0], [-100_000, 0.1, 0]);
    const distractor = triangle([-100_000, 0, 1], [-99_999, 0, 1], [-100_000, 1, 1]);
    const entries = [distractor, target];
    for (const point of [[-99_999, 0.01, 1e-5], [-100_000.01, -0.01, 1e-5], [-99_999, -0.01, 1e-5]] as Vec3[]) {
      expect(nearestProjection(point, entries, triangleSpatialIndex(entries), 0.1)?.triangle).toBe(target);
      checkAgainstOracle(point, entries, 0.1, 1e-8);
    }
  });

  test("matches an exhaustive geometric oracle across generated nonconforming surfaces and scales", () => {
    let seed = 0x419a2;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    for (const units of [1e-6, 1, 1e6]) {
      const entries = Array.from({ length: 64 }, () => {
        const a: Vec3 = [(random() - 0.5) * 20 * units, (random() - 0.5) * 20 * units, (random() - 0.5) * 20 * units];
        return triangle(a, combine(a, [units, units * 0.1, units * 0.2], 0.5 + random() * 30), combine(a, [-units * 0.1, units, -units * 0.3], 0.5 + random() * 3));
      });
      for (let query = 0; query < 96; query += 1) {
        const point: Vec3 = [(random() - 0.5) * 30 * units, (random() - 0.5) * 30 * units, (random() - 0.5) * 30 * units];
        checkAgainstOracle(point, entries, (query % 3 === 0 ? 0.01 : 10) * units, 1e-7 * units);
      }
    }
  });

  test("preserves the exact search tolerance and input-order ties", () => {
    const first = triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const second = triangle([0, 0, 0.25], [1, 0, 0.25], [0, 1, 0.25]);
    const point: Vec3 = [0.25, 0.25, 0.125];
    const entries = [first, second];
    const spatial = triangleSpatialIndex(entries);
    expect(nearestProjection(point, entries, spatial, 0.125)?.triangle).toBe(first);
    expect(nearestProjection(point, entries, spatial, 0.125 - Number.EPSILON)).toBeUndefined();
    expect(nearestProjection(point, [], triangleSpatialIndex([]), 1)).toBeUndefined();
  });

  test("prunes separated facets instead of scanning the full surface for every node", () => {
    let projections = 0;
    const entries = Array.from({ length: 4096 }, (_, index) => {
      const x = (index % 64) * 10, y = Math.floor(index / 64) * 10;
      const entry = triangle([x, y, 0], [x + 1, y, 0], [x, y + 1, 0]);
      const a = entry.a;
      Object.defineProperty(entry, "a", { get() { projections += 1; return a; } });
      return entry;
    });
    const spatial = triangleSpatialIndex(entries);
    projections = 0;
    for (let query = 0; query < 32; query += 1) {
      const index = query * 127;
      const point: Vec3 = [(index % 64) * 10 + 0.2, Math.floor(index / 64) * 10 + 0.2, 0.01];
      expect(nearestProjection(point, entries, spatial, 0.1)?.triangle).toBe(entries[index]);
    }
    // At most two small leaves per query, versus 131,072 exhaustive projections.
    expect(projections).toBeGreaterThan(0);
    expect(projections).toBeLessThanOrEqual(32 * 16);
  });
});
