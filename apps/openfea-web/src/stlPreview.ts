import * as THREE from "three";
import { stlVolumeM3FromBytes } from "@openfea/units";
import { parseAsciiStlPreview, parseBinaryStlPreview } from "./stlPreviewParser";

const NORMALIZED_MODEL_SIZE = 2.4;
export const MAX_PREVIEW_POSITION_COUNT = 1_000_000;

export function normalizedStlGeometryFromBuffer(buffer: ArrayBuffer): THREE.BufferGeometry {
  const volumeM3 = stlVolumeM3FromBytes(new Uint8Array(buffer));
  const input = stlLoaderInputFor(buffer);
  const geometry = typeof input === "string" ? parseAsciiStlPreview(input) : parseBinaryStlPreview(input);
  const position = geometry.getAttribute("position");
  if (position && position.count > MAX_PREVIEW_POSITION_COUNT) {
    geometry.dispose();
    throw new Error(`STL preview exceeds the ${MAX_PREVIEW_POSITION_COUNT.toLocaleString()}-vertex browser limit.`);
  }
  if (volumeM3) {
    geometry.userData.openfeaVolumeM3 = volumeM3;
    geometry.userData.openfeaVolumeSource = "mesh";
    geometry.userData.openfeaVolumeStatus = "available";
  }
  normalizeStlGeometry(geometry);
  geometry.computeVertexNormals();
  return geometry;
}

export function tryNormalizedStlGeometryFromBuffer(buffer: ArrayBuffer): THREE.BufferGeometry | null {
  try {
    return normalizedStlGeometryFromBuffer(buffer);
  } catch {
    return null;
  }
}

export function normalizeStlGeometry(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) {
    throw new Error("STL file did not contain renderable triangles.");
  }

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    throw new Error("STL file did not contain valid bounds.");
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error("STL file did not contain valid geometry extents.");
  }

  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(NORMALIZED_MODEL_SIZE / maxDimension, NORMALIZED_MODEL_SIZE / maxDimension, NORMALIZED_MODEL_SIZE / maxDimension);
  geometry.computeBoundingBox();
}

function stlLoaderInputFor(buffer: ArrayBuffer): ArrayBuffer | string {
  if (isExactBinaryStl(buffer)) return buffer;

  const header = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 512)));
  if (header.replace(/^\uFEFF/, "").trimStart().startsWith("solid")) {
    return new TextDecoder().decode(buffer).replace(/^\uFEFF/, "").trimStart();
  }

  // A buffer not recognized above can take STLLoader's binary path, which
  // trusts the declared face count at offset 80 and
  // sizes its typed arrays from it before any bounds check. A truncated or
  // crafted file can declare far more faces than fit in the buffer and force
  // gigabyte-scale allocations. Reject impossible declarations up front.
  rejectImpossibleBinaryStl(buffer);
  // Three also recognizes ASCII after a non-whitespace encoding prefix at
  // offsets 0..4. Cover that route without reclassifying exact-fit binaries.
  const prefix = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 9));
  for (let offset = 0; offset < 5 && offset + 5 <= prefix.length; offset++) {
    if (prefix[offset] === 115 && prefix[offset + 1] === 111 && prefix[offset + 2] === 108 && prefix[offset + 3] === 105 && prefix[offset + 4] === 100) {
      return new TextDecoder().decode(buffer);
    }
  }
  return buffer;
}

function rejectImpossibleBinaryStl(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 84) return;
  const faces = new DataView(buffer).getUint32(80, true);
  if (84 + faces * 50 > buffer.byteLength) {
    throw new Error("STL file declares more faces than its size allows.");
  }
}

function isExactBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const reader = new DataView(buffer);
  const faces = reader.getUint32(80, true);
  return 84 + faces * 50 === buffer.byteLength;
}
