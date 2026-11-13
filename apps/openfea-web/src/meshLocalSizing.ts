// Local mesh sizing per STEP B-rep face (plan 036 R2.2): persisted rules,
// their resolution against the STEP face registry, the gmsh targets the mesh
// worker applies, and the pre-mesh DOF preflight.
//
// Lightweight on purpose: MeshPanel imports it into the main bundle, so the
// face registry (stepFaces, occt-import-js) is only referenced as a type and
// the estimator comes from the dependency-free mesh-intake subpath.
import type { DisplayFace, MeshLocalSize, Study } from "@openfea/schema";
import {
  estimateMeshSize,
  localSizingPreflight,
  MAX_LOCAL_MESH_SIZE_RULES,
  type LocalSizeTarget,
  type LocalSizingPreflight,
  type LocalSizingReport,
  type MeshSizeEstimate
} from "@openfea/mesh-intake/localSizing";
import type { StepFaceRecord, StepFaceRegistry } from "./stepFaces";

/** Same floor the STEP mesher enforces for its global size (MIN_BROWSER_MESH_SIZE_MM). */
export const MIN_LOCAL_MESH_SIZE_MM = 0.5;
export const MAX_LOCAL_MESH_SIZES = MAX_LOCAL_MESH_SIZE_RULES;
/** Fingerprint-geometry agreement when a face id now names a slightly different tessellation. */
const FINGERPRINT_AREA_RELATIVE_TOLERANCE = 0.05;
const FINGERPRINT_CENTROID_RELATIVE_TOLERANCE = 0.01;
const FINGERPRINT_PREFIX = "stepface:";

/**
 * Element order the STEP mesh request will ask for. Mirrors
 * requestedElementOrder in @openfea/mesh-intake/elevateArtifact (parity is
 * tested) without pulling @openfea/core into the main bundle.
 */
export function studyRequestedElementOrder(solverSettings: Record<string, unknown> | undefined): 1 | 2 {
  const value = solverSettings?.elementOrder ?? solverSettings?.meshOrder;
  if (value === 1 || value === "1") return 1;
  return 2;
}

/** A display face the mesher can size: a real STEP registry face, not a placeholder. */
export function isLocalSizableFace(face: Pick<DisplayFace, "id"> | null | undefined): face is DisplayFace {
  return Boolean(face?.id.startsWith("step-face-"));
}

export function isValidLocalMeshSizeMm(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_LOCAL_MESH_SIZE_MM;
}

/** Persistable rule for one picked face; `registry` supplies the B-rep fingerprint when it is loaded. */
export function meshLocalSizeForFace(face: Pick<DisplayFace, "id"> & Partial<Pick<DisplayFace, "label">>, sizeMm: number, registry: Pick<StepFaceRegistry, "faces"> | null, id?: string): MeshLocalSize {
  const record = registry?.faces.find((candidate) => candidate.faceId === face.id);
  return {
    id: id ?? `local-size-${randomId()}`,
    faceId: face.id,
    fingerprint: record?.fingerprint ?? "",
    ...(face.label ? { label: face.label } : {}),
    sizeMm
  };
}

/** Add rules for faces, replacing the size of a face that already has one. */
export function upsertMeshLocalSizes(
  rules: readonly MeshLocalSize[],
  faces: ReadonlyArray<Pick<DisplayFace, "id" | "label">>,
  sizeMm: number,
  registry: Pick<StepFaceRegistry, "faces"> | null
): MeshLocalSize[] {
  const next = [...rules];
  for (const face of faces) {
    const index = next.findIndex((rule) => rule.faceId === face.id);
    if (index >= 0) next[index] = { ...next[index]!, sizeMm };
    else if (next.length < MAX_LOCAL_MESH_SIZES) next.push(meshLocalSizeForFace(face, sizeMm, registry));
  }
  return next;
}

/**
 * Mesh settings with the mesh discarded but the user's setup kept: the
 * preset and the local sizing rules survive every "regenerate the mesh"
 * reset (geometry migration, imported-mesh discard, setup edits).
 */
export function meshSettingsWithoutMesh(meshSettings: Study["meshSettings"]): Study["meshSettings"] {
  return {
    preset: meshSettings.preset,
    status: "not_started",
    ...(meshSettings.localSizing?.length ? { localSizing: meshSettings.localSizing } : {})
  };
}

export type ResolvedMeshLocalSize = { rule: MeshLocalSize; record: StepFaceRecord };
export type UnresolvedMeshLocalSize = { rule: MeshLocalSize; reason: "face_not_found" | "face_changed" };

/**
 * Bind persisted rules to the current registry. The face id must still carry
 * the stored fingerprint (or one within tessellation tolerance of it); if the
 * id moved, a unique face with the stored fingerprint takes over. Otherwise
 * the rule is reported, never applied to whatever face now has that id.
 */
export function resolveMeshLocalSizes(
  rules: readonly MeshLocalSize[],
  registry: Pick<StepFaceRegistry, "faces" | "bounds">
): { resolved: ResolvedMeshLocalSize[]; unresolved: UnresolvedMeshLocalSize[] } {
  const resolved: ResolvedMeshLocalSize[] = [];
  const unresolved: UnresolvedMeshLocalSize[] = [];
  const diagonal = Math.hypot(...registry.bounds.max.map((value, axis) => value - registry.bounds.min[axis]!)) || 1;
  for (const rule of rules) {
    const byId = registry.faces.find((face) => face.faceId === rule.faceId);
    if (byId && (!rule.fingerprint || byId.fingerprint === rule.fingerprint || fingerprintMatchesRecord(rule.fingerprint, byId, diagonal))) {
      resolved.push({ rule, record: byId });
      continue;
    }
    const byFingerprint = rule.fingerprint ? registry.faces.filter((face) => face.fingerprint === rule.fingerprint) : [];
    if (byFingerprint.length === 1) {
      resolved.push({ rule, record: byFingerprint[0]! });
      continue;
    }
    unresolved.push({ rule, reason: byId ? "face_changed" : "face_not_found" });
  }
  return { resolved, unresolved };
}

/**
 * Gmsh targets in STEP model space (mm). Bounds come from the face's own
 * display triangles. Rules on bodies excluded from the structural mesh are
 * dropped by the caller's `meshIndices` filter.
 */
export function localSizeTargetsForRegistry(
  resolved: readonly ResolvedMeshLocalSize[],
  registry: Pick<StepFaceRegistry, "meshes">,
  meshIndices?: readonly number[]
): LocalSizeTarget[] {
  const included = meshIndices ? new Set(meshIndices) : null;
  const seen = new Set<string>();
  const targets: LocalSizeTarget[] = [];
  for (const { rule, record } of resolved) {
    if (included && !included.has(record.meshIndex)) continue;
    // One field per face: a duplicate rule on the same face keeps the finer size.
    if (seen.has(record.faceId)) {
      const existing = targets.find((target) => target.faceId === record.faceId)!;
      existing.size = Math.min(existing.size, rule.sizeMm);
      continue;
    }
    seen.add(record.faceId);
    targets.push({
      id: rule.id,
      faceId: record.faceId,
      size: rule.sizeMm,
      area: record.area,
      centroid: [...record.centroid],
      bounds: faceBounds(registry, record)
    });
  }
  return targets;
}

/** Closed-shell volume (divergence theorem) and boundary area of the tessellated bodies, in mm³ and mm². */
export function registryVolumeAndArea(registry: Pick<StepFaceRegistry, "meshes">, meshIndices?: readonly number[]): { volume: number; area: number } {
  const included = meshIndices ? new Set(meshIndices) : null;
  let volume = 0;
  let area = 0;
  registry.meshes.forEach((mesh, meshIndex) => {
    if (included && !included.has(meshIndex)) return;
    const p = mesh.positions;
    const ix = mesh.indices;
    let signed = 0;
    for (let index = 0; index + 2 < ix.length; index += 3) {
      const a = ix[index]! * 3;
      const b = ix[index + 1]! * 3;
      const c = ix[index + 2]! * 3;
      const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
      const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
      const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
      signed += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    volume += Math.abs(signed) / 6;
  });
  return { volume, area };
}

export type MeshLocalSizingPlan = {
  targets: LocalSizeTarget[];
  unresolved: UnresolvedMeshLocalSize[];
  estimate: MeshSizeEstimate;
  preflight: LocalSizingPreflight;
};

/**
 * Resolve the study's rules and run the DOF preflight before any meshing.
 * Returns null when the study has no local sizing. Lengths are STEP model
 * millimetres throughout (the registry, the preset size and the rules).
 */
export function planMeshLocalSizing(input: {
  rules: readonly MeshLocalSize[] | undefined;
  registry: Pick<StepFaceRegistry, "faces" | "meshes" | "bounds">;
  globalSizeMm: number;
  elementOrder: 1 | 2;
  maxDofs: number;
  meshIndices?: readonly number[];
}): MeshLocalSizingPlan | null {
  if (!input.rules?.length) return null;
  const { resolved, unresolved } = resolveMeshLocalSizes(input.rules, input.registry);
  const targets = localSizeTargetsForRegistry(resolved, input.registry, input.meshIndices);
  const { volume, area } = registryVolumeAndArea(input.registry, input.meshIndices);
  const recordsByFace = new Map(resolved.map(({ record }) => [record.faceId, record]));
  const estimate = estimateMeshSize({
    volume,
    surfaceArea: area,
    globalSize: input.globalSizeMm,
    faces: targets.map((target) => {
      const cylinder = recordsByFace.get(target.faceId)?.cylinder;
      return { area: target.area, size: target.size, ...(cylinder ? { cylinder: { radius: cylinder.radius, interior: cylinder.interior } } : {}) };
    })
  });
  return { targets, unresolved, estimate, preflight: localSizingPreflight(estimate, { elementOrder: input.elementOrder, maxDofs: input.maxDofs }) };
}

/** Thrown before meshing when local refinement cannot fit the browser solver. */
export class MeshLocalSizingPreflightError extends Error {
  override name = "MeshLocalSizingPreflightError";
}

/** Summary warnings for rules the mesher could not use. */
export function meshLocalSizingWarnings(
  rules: readonly MeshLocalSize[],
  unresolved: readonly UnresolvedMeshLocalSize[],
  report: LocalSizingReport | undefined
): string[] {
  const warnings: string[] = [];
  const name = (targetId: string, faceId: string) => rules.find((rule) => rule.id === targetId)?.label ?? faceId;
  for (const entry of unresolved) {
    warnings.push(entry.reason === "face_changed"
      ? `Local size on ${entry.rule.label ?? entry.rule.faceId} was not applied: the face no longer matches the one it was set on. Pick the face again.`
      : `Local size on ${entry.rule.label ?? entry.rule.faceId} was not applied: the face is not in this model. Pick the face again.`);
  }
  for (const entry of report?.unmatched ?? []) {
    warnings.push(entry.reason === "not_finer_than_global"
      ? `Local size on ${name(entry.targetId, entry.faceId)} was not applied: it is not finer than the preset element size.`
      : `Local size on ${name(entry.targetId, entry.faceId)} was not applied: the mesher could not identify that face after import.`);
  }
  return warnings;
}

function fingerprintMatchesRecord(fingerprint: string, record: StepFaceRecord, diagonal: number): boolean {
  const parsed = parseFingerprint(fingerprint);
  if (!parsed) return false;
  const areaScale = Math.max(parsed.area, record.area);
  const areaOk = areaScale > 0 && Math.abs(parsed.area - record.area) / areaScale <= FINGERPRINT_AREA_RELATIVE_TOLERANCE;
  const centroidOk = Math.hypot(...parsed.centroid.map((value, axis) => value - record.centroid[axis]!)) <= FINGERPRINT_CENTROID_RELATIVE_TOLERANCE * diagonal;
  return areaOk && centroidOk;
}

function parseFingerprint(fingerprint: string): { area: number; centroid: [number, number, number] } | null {
  if (!fingerprint.startsWith(FINGERPRINT_PREFIX)) return null;
  const fields = Object.fromEntries(fingerprint.slice(FINGERPRINT_PREFIX.length).split("|").map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const area = Number(fields.a);
  const centroid = String(fields.c ?? "").split(",").map(Number);
  if (!Number.isFinite(area) || centroid.length !== 3 || !centroid.every(Number.isFinite)) return null;
  return { area, centroid: centroid as [number, number, number] };
}

function faceBounds(registry: Pick<StepFaceRegistry, "meshes">, record: StepFaceRecord): LocalSizeTarget["bounds"] {
  const mesh = registry.meshes[record.meshIndex];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  if (mesh) {
    for (let triangle = record.triangleRange[0]; triangle <= record.triangleRange[1]; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = mesh.indices[triangle * 3 + corner];
        if (vertex === undefined) continue;
        for (let axis = 0; axis < 3; axis += 1) {
          const value = mesh.positions[vertex * 3 + axis]!;
          if (value < min[axis]!) min[axis] = value;
          if (value > max[axis]!) max[axis] = value;
        }
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [...record.centroid], max: [...record.centroid] };
  return { min, max };
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
