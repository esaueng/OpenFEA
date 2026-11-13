import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * The active section plane in world space (three.js clipping-plane convention:
 * points with a negative signed distance are cut away), or null when the
 * section view is off. CadViewer provides it; markers and the cap read it.
 */
export const SectionPlaneContext = createContext<THREE.Plane | null>(null);

/** Scratch for SectionCulled; frame callbacks run synchronously, one at a time. */
const anchorScratch = new THREE.Vector3();

/** World-units slack so anchors lying on the cut face itself stay visible. */
const SECTION_ANCHOR_TOLERANCE = 1e-4;

export function isPointCutAwayBySection(plane: THREE.Plane | null, worldPoint: THREE.Vector3): boolean {
  return Boolean(plane && plane.distanceToPoint(worldPoint) < -SECTION_ANCHOR_TOLERANCE);
}

/**
 * Renders its children only while `anchor` (in the parent's local space) is on
 * the kept side of the section plane. Callouts, probes and boundary-condition
 * labels draw without depth testing, so without this a label whose geometry
 * was cut away kept floating over empty space. The anchor's world position is
 * read every frame, so it follows deformation, playback and model rotation.
 */
export function SectionCulled({ anchor, children }: { anchor: readonly [number, number, number]; children: ReactNode }) {
  const plane = useContext(SectionPlaneContext);
  const anchorRef = useRef<THREE.Object3D>(null);
  const [cutAway, setCutAway] = useState(false);
  const invalidate = useThree((state) => state.invalidate);
  useFrame(() => {
    const object = anchorRef.current;
    const next = object ? isPointCutAwayBySection(plane, object.getWorldPosition(anchorScratch)) : false;
    if (next !== cutAway) {
      setCutAway(next);
      invalidate();
    }
  });
  return (
    <>
      <object3D ref={anchorRef} position={anchor as [number, number, number]} />
      {cutAway ? null : children}
    </>
  );
}

// --- Section cap -------------------------------------------------------------
//
// Stencil capping (the three.js "clipping stencil" technique): every closed,
// section-clippable mesh is drawn a second time into the stencil buffer only,
// clipped by the section plane — back faces increment, front faces decrement.
// Pixels where the cut passes through solid material end with a non-zero
// count, and a plane mesh lying on the section plane is drawn only there.
// Winding counts (not parity) keep overlapping solids, such as a rib merged
// into a bracket body, capped. Open surfaces would corrupt the count, so a mesh
// is capped only when every edge of its welded triangle mesh is shared by an
// even number of triangles; anything else is clipped but left uncapped, as
// before. Requires a renderer created with `stencil: true`.

const SECTION_CAP_RENDER_ORDER = 9;
const noRaycast = () => {};

// Keyed by geometry only: result playback rewrites positions every frame but
// never the topology, and re-welding per frame would stall playback.
const closedGeometryCache = new WeakMap<THREE.BufferGeometry, boolean>();

/** True when every edge of the (position-welded) triangle mesh is shared by an even number of triangles. */
export function isClosedTriangleMesh(geometry: THREE.BufferGeometry): boolean {
  const cached = closedGeometryCache.get(geometry);
  if (cached !== undefined) return cached;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  if (!position) return false; // not filled yet; decide once it is
  const index = geometry.getIndex();
  const corners = index ? index.count : position.count;
  let closed = corners > 0 && corners % 3 === 0;
  if (closed) {
    // Weld by quantized position: split normals/UV seams duplicate vertices.
    geometry.computeBoundingBox();
    const quantum = (geometry.boundingBox!.getSize(new THREE.Vector3()).length() || 1) * 1e-6;
    const ids = new Map<string, number>();
    const memo = new Int32Array(position.count).fill(-1);
    const idOf = (corner: number) => {
      const vertex = index ? index.getX(corner) : corner;
      if (memo[vertex]! >= 0) return memo[vertex]!;
      const key = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)].map((value) => Math.round(value / quantum)).join();
      let id = ids.get(key);
      if (id === undefined) ids.set(key, id = ids.size);
      return memo[vertex] = id;
    };
    // Edge key a*2^26+b is exact in a double for up to 2^26 welded vertices.
    const edges = new Map<number, number>();
    for (let corner = 0; corner < corners; corner += 3) {
      const triangle = [idOf(corner), idOf(corner + 1), idOf(corner + 2)];
      for (let side = 0; side < 3; side += 1) {
        const a = triangle[side]!;
        const b = triangle[(side + 1) % 3]!;
        if (a === b) continue;
        const key = Math.min(a, b) * 67108864 + Math.max(a, b);
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    closed = edges.size > 0 && [...edges.values()].every((count) => count % 2 === 0);
  }
  closedGeometryCache.set(geometry, closed);
  return closed;
}

/** Whether the section plane clips this object: the nearest flagged ancestor decides. */
export function hasSectionClippableAncestor(object: THREE.Object3D): boolean {
  // Cap helpers carry openfeaSectionExclude, so the cap traversal skips them too.
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current.userData.openfeaSectionExclude === true) return false;
    if (current.userData.openfeaSectionClippable === true) return true;
  }
  return false;
}

function createStencilMaterial(side: THREE.Side, operation: THREE.StencilOp): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    side,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: operation,
    stencilZFail: operation,
    stencilZPass: operation
  });
}

type CapHelpers = { back: THREE.Mesh; front: THREE.Mesh };

export function SectionCap({ bounds, color }: { bounds: THREE.Box3 | null; color: string }) {
  const plane = useContext(SectionPlaneContext);
  const { scene, invalidate } = useThree();
  const helpersRef = useRef(new Map<THREE.Mesh, CapHelpers>());
  const stencilMaterials = useMemo(() => ({
    back: createStencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp),
    front: createStencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp)
  }), []);

  useEffect(() => {
    stencilMaterials.back.clippingPlanes = plane ? [plane] : null;
    stencilMaterials.front.clippingPlanes = plane ? [plane] : null;
    stencilMaterials.back.needsUpdate = true;
    stencilMaterials.front.needsUpdate = true;
    if (!plane) removeCapHelpers(helpersRef.current);
    invalidate();
  }, [invalidate, plane, stencilMaterials]);

  useEffect(() => {
    const helpers = helpersRef.current;
    return () => {
      removeCapHelpers(helpers);
      stencilMaterials.back.dispose();
      stencilMaterials.front.dispose();
    };
  }, [stencilMaterials]);

  useFrame(() => {
    if (plane) syncCapHelpers(scene, helpersRef.current, stencilMaterials);
  });

  const placement = useMemo(() => {
    if (!plane || !bounds || bounds.isEmpty()) return null;
    const center = plane.projectPoint(bounds.getCenter(new THREE.Vector3()), new THREE.Vector3());
    const size = Math.max(bounds.getSize(new THREE.Vector3()).length() * 2, 1e-3);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal.clone().normalize());
    return { center: center.toArray() as [number, number, number], quaternion, size };
  }, [bounds, plane]);
  if (!placement) return null;

  return (
    <mesh
      position={placement.center}
      quaternion={placement.quaternion}
      renderOrder={SECTION_CAP_RENDER_ORDER}
      raycast={noRaycast}
      userData={{ openfeaSectionExclude: true }}
    >
      <planeGeometry args={[placement.size, placement.size]} />
      <meshStandardMaterial
        color={color}
        side={THREE.DoubleSide}
        stencilWrite
        // stencilRef defaults to 0: draw where the count is non-zero, then reset it to 0.
        stencilFunc={THREE.NotEqualStencilFunc}
        stencilFail={THREE.ReplaceStencilOp}
        stencilZFail={THREE.ReplaceStencilOp}
        stencilZPass={THREE.ReplaceStencilOp}
      />
    </mesh>
  );
}

function syncCapHelpers(scene: THREE.Scene, helpers: Map<THREE.Mesh, CapHelpers>, materials: { back: THREE.Material; front: THREE.Material }) {
  const seen = new Set<THREE.Mesh>();
  scene.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh || !hasSectionClippableAncestor(object)) return;
    const mesh = object as THREE.Mesh;
    if (!isClosedTriangleMesh(mesh.geometry)) return;
    seen.add(mesh);
    let pair = helpers.get(mesh);
    if (!pair) {
      pair = { back: capHelper(mesh.geometry, materials.back), front: capHelper(mesh.geometry, materials.front) };
      mesh.add(pair.back, pair.front);
      helpers.set(mesh, pair);
    }
    if (pair.back.geometry !== mesh.geometry) {
      pair.back.geometry = mesh.geometry;
      pair.front.geometry = mesh.geometry;
    }
  });
  for (const [mesh, pair] of helpers) {
    if (seen.has(mesh)) continue;
    mesh.remove(pair.back, pair.front);
    helpers.delete(mesh);
  }
}

function capHelper(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const helper = new THREE.Mesh(geometry, material);
  helper.renderOrder = SECTION_CAP_RENDER_ORDER - 1;
  helper.raycast = noRaycast;
  // Excluded from applySectionClipping (its material already carries the plane)
  // and from the cap's own traversal.
  helper.userData = { openfeaSectionExclude: true };
  return helper;
}

function removeCapHelpers(helpers: Map<THREE.Mesh, CapHelpers>) {
  for (const [mesh, pair] of helpers) mesh.remove(pair.back, pair.front);
  helpers.clear();
}
