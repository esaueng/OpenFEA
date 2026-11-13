// Local mesh sizing per B-rep face (plan 036 R2.2).
//
// Pure helpers shared by the gmsh session (wasmMesher.ts applies the fields)
// and the browser app (pre-mesh DOF preflight). Nothing here imports gmsh, so
// the app can use the estimate on the main thread without pulling the WASM
// mesher into the initial bundle.
//
// Units: every length in this module is in ONE consistent model length unit
// (mm for STEP, because OpenCASCADE imports STEP in mm; mm or m for .geo
// scripts). Areas are in that unit squared and volumes cubed. The formulas
// are dimensionally homogeneous, so scaling every input by k scales sizes by
// k and leaves element counts unchanged (asserted by the mm-vs-m tests).

/**
 * Size growth away from a refined face, as size increase per unit distance
 * (dimensionless). The threshold field reaches the global size at
 * DistMax = (globalSize - localSize) / LOCAL_MESH_SIZE_GROWTH_RATE. 0.5 is the
 * gradation the plate-with-hole benchmark has used since plan 013.
 */
export const LOCAL_MESH_SIZE_GROWTH_RATE = 0.5;
/** Upper bound on persisted local size rules per study (schema and UI share it). */
export const MAX_LOCAL_MESH_SIZE_RULES = 64;
/** Distance-field sampling per parametric direction: at least this many points. */
const MIN_DISTANCE_SAMPLING = 20;
/** ...and at most this many (Sampling^2 points per surface feed gmsh's kd-tree). */
const MAX_DISTANCE_SAMPLING = 120;
/** Target sampling points per local element length along a surface. */
const DISTANCE_SAMPLES_PER_LOCAL_SIZE = 2;

/**
 * Geometric description of one face to refine, in model units. Centroid and
 * area come from the STEP display tessellation (occt-import-js), which reads
 * the same B-rep topology gmsh imports, so they identify the gmsh surface.
 */
export type LocalSizeTarget = {
  /** Persisted rule id (diagnostics only). */
  id: string;
  /** App B-rep face id (`step-face-<k>`), diagnostics only. */
  faceId: string;
  /** Requested element size on the face, in model units. */
  size: number;
  /** Face area in model units squared. */
  area: number;
  /** Area-weighted centroid in model units. */
  centroid: [number, number, number];
  /** Axis-aligned bounds of the face tessellation in model units. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
};

/** One gmsh (OpenCASCADE) surface as the matcher sees it. */
export type LocalSizeSurfaceDescriptor = {
  tag: number;
  area: number;
  centroid: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
};

export type LocalSizeSurfaceMatch = {
  targetId: string;
  faceId: string;
  size: number;
  surfaceTags: number[];
  /** "exact": one gmsh surface; "union": a face split into several gmsh surfaces (e.g. by a conformal fragment). */
  mode: "exact" | "union";
};

export type LocalSizeUnmatched = {
  targetId: string;
  faceId: string;
  reason: "no_matching_surface" | "not_finer_than_global" | "invalid_size";
};

export type LocalSizingReport = {
  /** Global (maximum) element size the threshold fields grow to, in model units. */
  globalSize: number;
  growthRate: number;
  applied: LocalSizeSurfaceMatch[];
  unmatched: LocalSizeUnmatched[];
};

/** Relative area mismatch accepted between the display tessellation and the exact B-rep face (chordal error on coarse curved faces). */
const MATCH_AREA_RELATIVE_TOLERANCE = 0.05;
/** Centroid mismatch accepted, as a fraction of the model bounding-box diagonal. */
const MATCH_CENTROID_RELATIVE_TOLERANCE = 0.01;
/** Bounds inflation for split-face (union) candidates, as a fraction of the diagonal. */
const MATCH_BOUNDS_RELATIVE_TOLERANCE = 0.01;

/**
 * Match each target face to the gmsh surface(s) that carry it. A target
 * first matches one surface whose area and centroid agree; failing that, the
 * set of surfaces inside the target's bounds whose summed area and combined
 * centroid agree (a face split by a conformal fragment). Anything else is
 * reported unmatched instead of being guessed.
 */
export function matchLocalSizeSurfaces(
  surfaces: readonly LocalSizeSurfaceDescriptor[],
  targets: readonly LocalSizeTarget[],
  modelDiagonal: number
): { matches: LocalSizeSurfaceMatch[]; unmatched: LocalSizeUnmatched[] } {
  const diagonal = Number.isFinite(modelDiagonal) && modelDiagonal > 0 ? modelDiagonal : 1;
  const centroidTolerance = MATCH_CENTROID_RELATIVE_TOLERANCE * diagonal;
  const boundsTolerance = MATCH_BOUNDS_RELATIVE_TOLERANCE * diagonal;
  const matches: LocalSizeSurfaceMatch[] = [];
  const unmatched: LocalSizeUnmatched[] = [];
  for (const target of targets) {
    if (!(Number.isFinite(target.size) && target.size > 0)) {
      unmatched.push({ targetId: target.id, faceId: target.faceId, reason: "invalid_size" });
      continue;
    }
    let best: { tag: number; score: number } | undefined;
    for (const surface of surfaces) {
      const areaError = relativeDifference(surface.area, target.area);
      const centroidError = distance3(surface.centroid, target.centroid);
      if (areaError > MATCH_AREA_RELATIVE_TOLERANCE || centroidError > centroidTolerance) continue;
      const score = areaError / MATCH_AREA_RELATIVE_TOLERANCE + centroidError / centroidTolerance;
      if (!best || score < best.score) best = { tag: surface.tag, score };
    }
    if (best) {
      matches.push({ targetId: target.id, faceId: target.faceId, size: target.size, surfaceTags: [best.tag], mode: "exact" });
      continue;
    }
    const inside = surfaces.filter((surface) => boundsContain(target.bounds, surface.bounds, boundsTolerance));
    const area = inside.reduce((sum, surface) => sum + surface.area, 0);
    if (inside.length > 1 && relativeDifference(area, target.area) <= MATCH_AREA_RELATIVE_TOLERANCE) {
      const centroid: [number, number, number] = [0, 0, 0];
      for (const surface of inside) {
        for (let axis = 0; axis < 3; axis += 1) centroid[axis]! += surface.centroid[axis]! * surface.area / area;
      }
      if (distance3(centroid, target.centroid) <= centroidTolerance) {
        matches.push({ targetId: target.id, faceId: target.faceId, size: target.size, surfaceTags: inside.map((surface) => surface.tag), mode: "union" });
        continue;
      }
    }
    unmatched.push({ targetId: target.id, faceId: target.faceId, reason: "no_matching_surface" });
  }
  return { matches, unmatched };
}

/** Distance from the refined face at which the threshold field reaches the global size. */
export function localSizeThresholdDistance(localSize: number, globalSize: number, growthRate = LOCAL_MESH_SIZE_GROWTH_RATE): number {
  if (!(localSize > 0) || !(globalSize > localSize) || !(growthRate > 0)) return 0;
  return (globalSize - localSize) / growthRate;
}

/**
 * Gmsh Distance-field sampling (points per parametric direction) so that the
 * sampled points are about half a local element apart on a face whose
 * bounding-box diagonal is `faceDiagonal`. Coarser sampling makes the
 * distance, and therefore the refined band, ragged.
 */
export function localSizeDistanceSampling(faceDiagonal: number, localSize: number): number {
  if (!(faceDiagonal > 0) || !(localSize > 0)) return MIN_DISTANCE_SAMPLING;
  const wanted = Math.ceil((faceDiagonal / localSize) * DISTANCE_SAMPLES_PER_LOCAL_SIZE);
  return Math.min(MAX_DISTANCE_SAMPLING, Math.max(MIN_DISTANCE_SAMPLING, wanted));
}

// ---------------------------------------------------------------------------
// Pre-mesh element / DOF estimate (APPROXIMATION).
//
// Fitted to gmsh-wasm 0.4.0 Delaunay meshes (CharacteristicLengthMax = h,
// CharacteristicLengthMin = 0.45 h) of the 120 x 60 x 6 mm plate with a
// 15 mm hole at h = 2..6 mm, uniform and with hole-face refinement:
//
//   tets  ≈ K_TET · ∫ dV / size_eff³
//   size_eff = min(size, t_wall),  t_wall = 2 V / A  (a thin wall still gets
//              about one element through its thickness)
//   Tet4 nodes  ≈ K_NODE_VOLUME · tets + K_NODE_SURFACE · ∫ dA / size_eff²
//   Tet10 nodes ≈ 2 · Tet4 nodes + tets + K_EDGE_SURFACE · ∫ dA / size_eff²
//                 (one extra node per edge; E ≈ V + T + F_boundary / 2)
//
// The refined band around a face is integrated over distance d from the
// face with the same linear threshold law gmsh applies. Its cross-section is
// the face area, grown or shrunk with d for recognised cylindrical faces
// (hole walls grow outward, bosses shrink), and the band volume is capped at
// the body volume; the band's extra elements are scaled by K_BAND. Overlapping
// bands of neighbouring faces are summed, so the estimate errs high there,
// and it also errs high when the global size exceeds the wall thickness
// (gmsh then stretches elements in-plane). Measured on the plate: within
// ±30% for global sizes up to the wall thickness, high otherwise. This is a
// planning number for the preflight, not a mesh statistic.
// ---------------------------------------------------------------------------

const K_TET = 5.6;
const K_NODE_VOLUME = 0.18;
const K_NODE_SURFACE = 0.5;
/** Half of the ~2.31 boundary triangles per h² (equilateral triangles of edge h). */
const K_EDGE_SURFACE = 1.15;
/**
 * Graded bands carry more elements than the same size integral in a uniform
 * mesh (gmsh's Delaunay refinement undershoots target sizes where they
 * change). Fitted on the plate hole wall: 1.08-1.79x, median 1.37, for local
 * sizes 0.5-2 mm under global sizes 4-8 mm.
 */
const K_BAND = 1.35;
const INTEGRATION_STEPS = 96;

export type LocalSizeEstimateFace = {
  area: number;
  size: number;
  /** Cylindrical faces: hole walls (interior) refine a band that widens with distance; bosses (exterior) one that narrows. */
  cylinder?: { radius: number; interior: boolean };
};

export type MeshSizeEstimateInput = {
  /** Solid volume in model units cubed. */
  volume: number;
  /** Total boundary area in model units squared. */
  surfaceArea: number;
  /** Global element size in model units. */
  globalSize: number;
  faces?: readonly LocalSizeEstimateFace[];
  growthRate?: number;
};

export type MeshSizeEstimate = {
  elements: number;
  tet4Nodes: number;
  tet10Nodes: number;
  /** Displacement DOF (3 per node). */
  tet4Dofs: number;
  tet10Dofs: number;
  /** The same estimate without any local refinement. */
  uniformElements: number;
  uniformTet4Dofs: number;
  uniformTet10Dofs: number;
};

export function estimateMeshSize(input: MeshSizeEstimateInput): MeshSizeEstimate {
  const volume = positiveOr(input.volume, 0);
  const surfaceArea = positiveOr(input.surfaceArea, 0);
  const globalSize = positiveOr(input.globalSize, 0);
  const growthRate = positiveOr(input.growthRate ?? LOCAL_MESH_SIZE_GROWTH_RATE, LOCAL_MESH_SIZE_GROWTH_RATE);
  if (!(volume > 0) || !(globalSize > 0)) {
    return { elements: 0, tet4Nodes: 0, tet10Nodes: 0, tet4Dofs: 0, tet10Dofs: 0, uniformElements: 0, uniformTet4Dofs: 0, uniformTet10Dofs: 0 };
  }
  const wallThickness = surfaceArea > 0 ? (2 * volume) / surfaceArea : Number.POSITIVE_INFINITY;
  const effective = (size: number) => Math.min(size, wallThickness);
  const baseSize = effective(globalSize);

  const uniformTetIntegral = volume / baseSize ** 3;
  const uniformSurfaceIntegral = surfaceArea / baseSize ** 2;

  let extraTetIntegral = 0;
  let extraSurfaceIntegral = 0;
  for (const face of input.faces ?? []) {
    if (!(face.area > 0) || !(face.size > 0) || !(face.size < globalSize)) continue;
    const distanceMax = localSizeThresholdDistance(face.size, globalSize, growthRate);
    const step = distanceMax / INTEGRATION_STEPS;
    let bandVolume = 0;
    for (let index = 0; index < INTEGRATION_STEPS && bandVolume < volume; index += 1) {
      const distance = (index + 0.5) * step;
      const size = face.size + (globalSize - face.size) * (distance / distanceMax);
      const crossSection = face.area * bandWidthFactor(face, distance);
      const slice = Math.min(crossSection * step, volume - bandVolume);
      bandVolume += slice;
      extraTetIntegral += K_BAND * slice * Math.max(0, 1 / effective(size) ** 3 - 1 / baseSize ** 3);
    }
    extraSurfaceIntegral += face.area * Math.max(0, 1 / effective(face.size) ** 2 - 1 / baseSize ** 2);
  }

  const counts = (tetIntegral: number, surfaceIntegral: number) => {
    const elements = K_TET * tetIntegral;
    const tet4Nodes = K_NODE_VOLUME * elements + K_NODE_SURFACE * surfaceIntegral;
    const tet10Nodes = 2 * tet4Nodes + elements + K_EDGE_SURFACE * surfaceIntegral;
    return { elements: Math.round(elements), tet4Nodes: Math.round(tet4Nodes), tet10Nodes: Math.round(tet10Nodes) };
  };
  const uniform = counts(uniformTetIntegral, uniformSurfaceIntegral);
  const refined = counts(uniformTetIntegral + extraTetIntegral, uniformSurfaceIntegral + extraSurfaceIntegral);
  return {
    ...refined,
    tet4Dofs: 3 * refined.tet4Nodes,
    tet10Dofs: 3 * refined.tet10Nodes,
    uniformElements: uniform.elements,
    uniformTet4Dofs: 3 * uniform.tet4Nodes,
    uniformTet10Dofs: 3 * uniform.tet10Nodes
  };
}

export type LocalSizingPreflight = {
  status: "ok" | "warn" | "block";
  /** Estimated DOF for the requested element order (Tet10 when 2). */
  estimatedDofs: number;
  estimatedLinearDofs: number;
  estimatedElements: number;
  maxDofs: number;
  message?: string;
};

/**
 * Pre-mesh DOF gate for local refinement, using the browser solver ceiling
 * the mesher and the solve pipeline already enforce:
 * - block when even the linear (Tet4) estimate exceeds the ceiling — the
 *   mesher's Tet10 → Tet4 fallback could not make the mesh solvable;
 * - warn when only the requested Tet10 estimate exceeds it — the mesher is
 *   expected to keep a linear mesh instead.
 */
export function localSizingPreflight(estimate: MeshSizeEstimate, options: { elementOrder: 1 | 2; maxDofs: number }): LocalSizingPreflight {
  const estimatedDofs = options.elementOrder === 2 ? estimate.tet10Dofs : estimate.tet4Dofs;
  const base = {
    estimatedDofs,
    estimatedLinearDofs: estimate.tet4Dofs,
    estimatedElements: estimate.elements,
    maxDofs: options.maxDofs
  };
  if (estimate.tet4Dofs > options.maxDofs) {
    return {
      ...base,
      status: "block",
      message: `Local sizing would create about ${formatCount(estimate.tet4Dofs)} DOF even with linear Tet4 elements, above the ${formatCount(options.maxDofs)} DOF browser solver limit. Increase the local size, remove a face, or choose a coarser preset.`
    };
  }
  if (estimatedDofs > options.maxDofs) {
    return {
      ...base,
      status: "warn",
      message: `Local sizing is estimated at about ${formatCount(estimatedDofs)} quadratic (Tet10) DOF, above the ${formatCount(options.maxDofs)} DOF browser solver limit; the mesher will likely keep linear Tet4 elements instead.`
    };
  }
  return { ...base, status: "ok" };
}

/** Length unit factor from millimetres to a model's length unit. */
export function millimetresToModelLength(valueMm: number, modelUnits: "mm" | "m"): number {
  return modelUnits === "m" ? valueMm / 1000 : valueMm;
}

function bandWidthFactor(face: LocalSizeEstimateFace, distance: number): number {
  const radius = face.cylinder?.radius;
  if (!face.cylinder || !(radius && radius > 0)) return 1;
  return face.cylinder.interior ? (radius + distance) / radius : Math.max(0, radius - distance) / radius;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function relativeDifference(left: number, right: number): number {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale > 0 ? Math.abs(left - right) / scale : 0;
}

function distance3(left: readonly number[], right: readonly number[]): number {
  return Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!);
}

function boundsContain(
  outer: LocalSizeTarget["bounds"],
  inner: LocalSizeSurfaceDescriptor["bounds"],
  tolerance: number
): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (inner.min[axis]! < outer.min[axis]! - tolerance || inner.max[axis]! > outer.max[axis]! + tolerance) return false;
  }
  return true;
}
