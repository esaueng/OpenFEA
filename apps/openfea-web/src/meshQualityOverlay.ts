// Solver-space geometry for the Mesh view's "Show worst elements" highlight
// (plan 036 R2.1). Pure so it can be tested without WebGL.

type OverlayModel = {
  nodes: { coordinates: ArrayLike<number> };
  elementBlocks: Array<{ type: string; connectivity: ArrayLike<number> }>;
};

export type WorstElementOverlayGeometry = {
  /** Four corner faces per element, three xyz vertices each. */
  triangles: Float32Array;
  /** Six corner edges per element, two xyz vertices each. */
  edges: Float32Array;
  /** One centroid per element, so elements far smaller than a pixel stay visible. */
  centroids: Float32Array;
};

const CORNER_FACES = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]] as const;
const CORNER_EDGES = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]] as const;

/**
 * Corner geometry of the given elements, indexed in mesh order across blocks
 * (the order computeTetMeshQuality reports). Unknown indices are skipped.
 */
export function worstElementOverlayGeometry(model: OverlayModel, elementIndices: readonly number[]): WorstElementOverlayGeometry | null {
  const coordinates = model.nodes.coordinates;
  const corners: number[][] = [];
  for (const target of elementIndices) {
    let offset = target;
    for (const block of model.elementBlocks) {
      const nodesPerElement = block.type === "Tet10" ? 10 : block.type === "Tet4" ? 4 : 0;
      if (!nodesPerElement) continue;
      const count = Math.floor(block.connectivity.length / nodesPerElement);
      if (offset < count) {
        const ids = [0, 1, 2, 3].map((local) => block.connectivity[offset * nodesPerElement + local] ?? -1);
        if (ids.every((id) => Number.isInteger(id) && id >= 0 && id * 3 + 2 < coordinates.length)) corners.push(ids);
        break;
      }
      offset -= count;
    }
  }
  if (!corners.length) return null;
  const triangles = new Float32Array(corners.length * CORNER_FACES.length * 9);
  const edges = new Float32Array(corners.length * CORNER_EDGES.length * 6);
  const centroids = new Float32Array(corners.length * 3);
  let t = 0;
  let e = 0;
  // Indices were range-checked above.
  const at = (node: number, component: number) => coordinates[node * 3 + component]!;
  corners.forEach((ids, element) => {
    const write = (target: Float32Array, offset: number, node: number) => {
      for (let c = 0; c < 3; c += 1) target[offset + c] = at(node, c);
    };
    for (const face of CORNER_FACES) for (const local of face) { write(triangles, t, ids[local]!); t += 3; }
    for (const edge of CORNER_EDGES) for (const local of edge) { write(edges, e, ids[local]!); e += 3; }
    for (let c = 0; c < 3; c += 1) {
      centroids[element * 3 + c] = ids.reduce((sum, node) => sum + at(node, c), 0) / 4;
    }
  });
  return { triangles, edges, centroids };
}
