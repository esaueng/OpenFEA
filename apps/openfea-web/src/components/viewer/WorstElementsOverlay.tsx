/* Highlight of the mesh summary's worst elements (plan 036 R2.1). Rendered
   through CadViewer's meshPreviewOverlay hook, in solver space. */
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { WorstElementOverlayGeometry } from "../../meshQualityOverlay";

const HIGHLIGHT_COLOR = "#ff5a4f";

export default function WorstElementsOverlay({ geometry }: { geometry: WorstElementOverlayGeometry }) {
  const built = useMemo(() => {
    const triangles = new THREE.BufferGeometry();
    triangles.setAttribute("position", new THREE.BufferAttribute(geometry.triangles, 3));
    triangles.computeVertexNormals();
    const edges = new THREE.BufferGeometry();
    edges.setAttribute("position", new THREE.BufferAttribute(geometry.edges, 3));
    const centroids = new THREE.BufferGeometry();
    centroids.setAttribute("position", new THREE.BufferAttribute(geometry.centroids, 3));
    return { triangles, edges, centroids };
  }, [geometry]);
  useEffect(() => () => {
    built.triangles.dispose();
    built.edges.dispose();
    built.centroids.dispose();
  }, [built]);
  // Drawn over the translucent mesh preview so interior elements stay visible.
  return (
    <group userData={{ openfeaSectionClippable: true, openfeaWorstElements: true }}>
      <mesh geometry={built.triangles} renderOrder={7}>
        <meshBasicMaterial color={HIGHLIGHT_COLOR} transparent opacity={0.75} depthTest={false} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <lineSegments geometry={built.edges} renderOrder={8}>
        <lineBasicMaterial color={HIGHLIGHT_COLOR} depthTest={false} toneMapped={false} />
      </lineSegments>
      <points geometry={built.centroids} renderOrder={9}>
        <pointsMaterial color={HIGHLIGHT_COLOR} size={9} sizeAttenuation={false} depthTest={false} toneMapped={false} />
      </points>
    </group>
  );
}
