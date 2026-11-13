import type { DisplacementComponent } from "./model-json";

/**
 * Domain-owned policy for support geometry (plan 036 R1.4).
 *
 * A symmetry or roller support constrains the displacement component normal to
 * the selected face. Version 1 has no local coordinate systems, so it accepts a
 * face only when its normal lies within a named angle of one global axis and
 * then constrains that global component. Faces outside the tolerance are
 * rejected with an explicit error; they are never snapped silently. Skew
 * symmetry waits for local coordinate systems (R1.7).
 */
export const SUPPORT_GEOMETRY_POLICY = Object.freeze({
  /**
   * Largest angle, in degrees, between any facet normal of a symmetry/roller
   * face and the global axis it constrains. Angles are dimensionless, so the
   * tolerance is the same for m-N-s-Pa and mm-N-s-MPa models.
   */
  symmetryAxisToleranceDegrees: 1,
  /**
   * Facets whose area is at or below this fraction of the largest facet area
   * in the selection carry no reliable normal and are skipped.
   */
  degenerateFacetRelativeArea: 1e-12
});

const AXES: readonly DisplacementComponent[] = ["x", "y", "z"];

export type GlobalAxisAlignment = {
  /** The global axis closest to the normal. */
  component: DisplacementComponent;
  /** Angle in degrees between the normal (either sense) and that axis. */
  deviationDegrees: number;
};

/** The global axis nearest a nonzero vector, ignoring its sense. */
export function nearestGlobalAxis(normal: readonly [number, number, number] | readonly number[]): GlobalAxisAlignment | undefined {
  const x = Number(normal[0]);
  const y = Number(normal[1]);
  const z = Number(normal[2]);
  const length = Math.hypot(x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) return undefined;
  const magnitudes = [Math.abs(x) / length, Math.abs(y) / length, Math.abs(z) / length];
  let index = 0;
  if (magnitudes[1]! > magnitudes[index]!) index = 1;
  if (magnitudes[2]! > magnitudes[index]!) index = 2;
  const cosine = Math.min(1, magnitudes[index]!);
  return { component: AXES[index]!, deviationDegrees: (Math.acos(cosine) * 180) / Math.PI };
}

export type SymmetryAxisFacet = {
  /** Corner nodes first; Tri6 midside nodes, when present, are ignored. */
  nodes: ArrayLike<number>;
};

export type SymmetryAxisResolution =
  | {
      ok: true;
      component: DisplacementComponent;
      /** Largest facet deviation from the constrained axis, in degrees. */
      maxDeviationDegrees: number;
      facetCount: number;
    }
  | {
      ok: false;
      code: "empty-symmetry-surface" | "mixed-symmetry-axes" | "symmetry-face-not-axis-aligned";
      message: string;
      component?: DisplacementComponent;
      maxDeviationDegrees?: number;
    };

/**
 * Resolves the global component a symmetry/roller support constrains from the
 * solver surface facets it maps to. Every facet must lie within
 * {@link SUPPORT_GEOMETRY_POLICY.symmetryAxisToleranceDegrees} of the same
 * global axis; either sense is accepted, so two opposite parallel faces share
 * one axis. The result is independent of the model's length unit.
 */
export function symmetrySupportAxisForFacets(
  coordinates: ArrayLike<number>,
  facets: Iterable<SymmetryAxisFacet>,
  toleranceDegrees: number = SUPPORT_GEOMETRY_POLICY.symmetryAxisToleranceDegrees
): SymmetryAxisResolution {
  const normals: Array<{ normal: [number, number, number]; area: number }> = [];
  let largestArea = 0;
  for (const facet of facets) {
    if (facet.nodes.length < 3) continue;
    const a = facet.nodes[0]!;
    const b = facet.nodes[1]!;
    const c = facet.nodes[2]!;
    const ux = coordinate(coordinates, b, 0) - coordinate(coordinates, a, 0);
    const uy = coordinate(coordinates, b, 1) - coordinate(coordinates, a, 1);
    const uz = coordinate(coordinates, b, 2) - coordinate(coordinates, a, 2);
    const vx = coordinate(coordinates, c, 0) - coordinate(coordinates, a, 0);
    const vy = coordinate(coordinates, c, 1) - coordinate(coordinates, a, 1);
    const vz = coordinate(coordinates, c, 2) - coordinate(coordinates, a, 2);
    const normal: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const area = Math.hypot(normal[0], normal[1], normal[2]) / 2;
    if (!Number.isFinite(area)) continue;
    normals.push({ normal, area });
    if (area > largestArea) largestArea = area;
  }
  const minimumArea = SUPPORT_GEOMETRY_POLICY.degenerateFacetRelativeArea * largestArea;
  // Area-weighted axis vote, so a sliver facet cannot pick the axis.
  const axisArea = [0, 0, 0];
  let worst: GlobalAxisAlignment | undefined;
  let facetCount = 0;
  const alignments: GlobalAxisAlignment[] = [];
  for (const { normal, area } of normals) {
    if (!(area > minimumArea)) continue;
    const alignment = nearestGlobalAxis(normal);
    if (!alignment) continue;
    facetCount += 1;
    alignments.push(alignment);
    axisArea[AXES.indexOf(alignment.component)]! += area;
    if (!worst || alignment.deviationDegrees > worst.deviationDegrees) worst = alignment;
  }
  if (!worst || facetCount === 0) {
    return {
      ok: false,
      code: "empty-symmetry-surface",
      message: "A symmetry/roller support did not map to any solver surface facets."
    };
  }
  // Curved or tilted faces are reported by angle first: "split per axis" is
  // only useful advice when every facet is individually axis-aligned.
  if (worst.deviationDegrees > toleranceDegrees) {
    return {
      ok: false,
      code: "symmetry-face-not-axis-aligned",
      message: `A symmetry/roller support needs a flat face within ${formatDegrees(toleranceDegrees)}° of a global axis; the selected face is ${formatDegrees(worst.deviationDegrees)}° from the ${worst.component.toUpperCase()} axis. Use a fixed support with chosen components instead.`,
      component: worst.component,
      maxDeviationDegrees: worst.deviationDegrees
    };
  }
  let dominant = 0;
  if (axisArea[1]! > axisArea[dominant]!) dominant = 1;
  if (axisArea[2]! > axisArea[dominant]!) dominant = 2;
  const component = AXES[dominant]!;
  if (alignments.some((alignment) => alignment.component !== component)) {
    return {
      ok: false,
      code: "mixed-symmetry-axes",
      message: "A symmetry/roller support needs faces normal to one global axis, but the selected faces point along more than one axis. Add one support per axis.",
      component
    };
  }
  const maxDeviationDegrees = worst.deviationDegrees;
  return { ok: true, component, maxDeviationDegrees, facetCount };
}

function coordinate(coordinates: ArrayLike<number>, node: number, axis: number): number {
  return Number(coordinates[node * 3 + axis] ?? Number.NaN);
}

function formatDegrees(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}
