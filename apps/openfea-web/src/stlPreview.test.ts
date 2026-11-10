import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { normalizedStlGeometryFromBuffer, tryNormalizedStlGeometryFromBuffer } from "./stlPreview";

function asciiStlBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

const facet = "facet normal 0 0 +1e0\nouter loop\nvertex 0 0 0\nvertex 1e1 0 0\nvertex 0 +10.0 0\nendloop\nendfacet\n";
const solid = `solid solid_facet_name\n${facet}endsolid solid_facet_name`;

describe("STL preview helpers", () => {
  test.each([
    solid + "\nsolid x\n".repeat(4_000),
    `solid part\n${facet}${"facet x\n".repeat(4_000)}endsolid part`,
  ])("renders completed triangles despite repeated unterminated section tails", (text) => {
    const geometry = normalizedStlGeometryFromBuffer(asciiStlBuffer(text));
    expect(geometry.getAttribute("position").count).toBe(3);
    expect(geometry.groups).toEqual([{ start: 0, count: 3, materialIndex: 0 }]);
    geometry.dispose();
  });

  test.each([1, 2, 3, 4])("covers ASCII recognized after a %i-byte non-whitespace prefix", (offset) => {
    const text = "#".repeat(offset) + "solid " + "x".repeat(100) + `\n${facet}endsolid\n` + "solid x\n".repeat(256);
    const bytes = new Uint8Array(asciiStlBuffer(text));
    bytes.fill(0, 80, 84); // Keep the existing impossible-binary declaration guard satisfied.
    const geometry = normalizedStlGeometryFromBuffer(bytes.buffer);
    expect(geometry.getAttribute("position").count).toBe(3);
    geometry.dispose();
  });

  test.each([
    solid,
    `\uFEFF \r\n${solid.replaceAll("\n", "\r\n")}\r\nsolid \r\n${facet}endsolid`,
    `solid first\n${facet}${facet}endsolid different_closing_name\nsolid next\n${facet}endsolid`,
    `solid\n${facet}endsolid`,
    `solid name_facet\n${facet}endsolid name_facet`,
  ])("preserves ASCII attributes, groups, names and normalization", (text) => {
    const expected = new STLLoader().parse(text.replace(/^\uFEFF/, "").trimStart());
    expected.computeBoundingBox();
    const size = expected.boundingBox!.getSize(new THREE.Vector3());
    const center = expected.boundingBox!.getCenter(new THREE.Vector3());
    expected.translate(-center.x, -center.y, -center.z);
    expected.scale(2.4 / Math.max(size.x, size.y, size.z), 2.4 / Math.max(size.x, size.y, size.z), 2.4 / Math.max(size.x, size.y, size.z));
    expected.computeVertexNormals();
    const actual = normalizedStlGeometryFromBuffer(asciiStlBuffer(text));
    expect(Array.from(actual.getAttribute("position").array)).toEqual(Array.from(expected.getAttribute("position").array));
    expect(Array.from(actual.getAttribute("normal").array)).toEqual(Array.from(expected.getAttribute("normal").array));
    expect(actual.groups).toEqual(expected.groups);
    expect(actual.userData.groupNames).toEqual(expected.userData.groupNames);
    actual.dispose();
    expected.dispose();
  });

  test("retains exact binary classification and Magics colors with a solid header", () => {
    const bytes = new Uint8Array(134);
    bytes.set(new TextEncoder().encode("solid ignored COLOR="));
    bytes.set([128, 64, 32, 128], 20);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(108, 10, true);
    view.setFloat32(124, 10, true);
    view.setUint16(132, 0x8000, true);
    const actual = normalizedStlGeometryFromBuffer(bytes.buffer);
    const expected = new STLLoader().parse(bytes.buffer);
    expect(Array.from(actual.getAttribute("color").array)).toEqual(Array.from(expected.getAttribute("color").array));
    expect((actual as THREE.BufferGeometry & { alpha: number }).alpha).toBe((expected as THREE.BufferGeometry & { alpha: number }).alpha);
    expect(actual.groups).toEqual([]);
    expect(actual.getAttribute("position").count).toBe(3);
    actual.dispose();
    expected.dispose();
  });

  test.each([false, true])("matches binary attributes with mixed facet colors (colors=%s)", (hasColors) => {
    for (const padding of [0, 16]) {
      const bytes = new Uint8Array(84 + 50 * 8 + padding);
      const view = new DataView(bytes.buffer);
      if (hasColors) {
        bytes.set(new TextEncoder().encode("COLOR="));
        bytes.set([11, 55, 122, 73], 6);
      }
      view.setUint32(80, 8, true);
      for (let face = 0; face < 8; face++) {
        const start = 84 + face * 50;
        view.setFloat32(start + 8, face % 2 ? -1 : 1, true);
        const values = [face, 0, 0, face + 1, 0, 0, face, 2, 1];
        values.forEach((value, i) => view.setFloat32(start + 12 + i * 4, value, true));
        view.setUint16(start + 48, face % 2 ? 0x8000 : face * 1973, true);
      }
      const expected = new STLLoader().parse(bytes.buffer);
      const actual = normalizedStlGeometryFromBuffer(bytes.buffer);
      expected.computeBoundingBox();
      const size = expected.boundingBox!.getSize(new THREE.Vector3());
      const center = expected.boundingBox!.getCenter(new THREE.Vector3());
      expected.translate(-center.x, -center.y, -center.z);
      const scale = 2.4 / Math.max(size.x, size.y, size.z);
      expected.scale(scale, scale, scale);
      expected.computeVertexNormals();
      for (const name of Object.keys(expected.attributes)) {
        expect(Array.from(actual.getAttribute(name).array)).toEqual(Array.from(expected.getAttribute(name).array));
      }
      expect(actual.groups).toEqual(expected.groups);
      expect((actual as THREE.BufferGeometry & { alpha?: number }).alpha).toBe((expected as THREE.BufferGeometry & { alpha?: number }).alpha);
      expected.dispose();
      actual.dispose();
    }
  });
  test("parses multi-solid ASCII STL files with leading whitespace", () => {
    const stl = asciiStlBuffer(`
solid part_a
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid part_a
solid part_b
  facet normal 0 0 1
    outer loop
      vertex 20 0 0
      vertex 30 0 0
      vertex 20 10 0
    endloop
  endfacet
endsolid part_b
`);

    const geometry = normalizedStlGeometryFromBuffer(stl);

    expect(geometry.getAttribute("position").count).toBe(6);
    expect(geometry.groups).toHaveLength(2);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.getSize(new THREE.Vector3()).x).toBeCloseTo(2.4);
  });

  test("throws on STL input without renderable triangles", () => {
    const stl = asciiStlBuffer(`solid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
endsolid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
`);

    expect(() => normalizedStlGeometryFromBuffer(stl)).toThrow("STL file did not contain renderable triangles.");
  });

  test("tryNormalizedStlGeometryFromBuffer returns null instead of throwing on invalid input", () => {
    const emptySolid = asciiStlBuffer(`solid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
endsolid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
`);
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;

    expect(tryNormalizedStlGeometryFromBuffer(emptySolid)).toBeNull();
    expect(tryNormalizedStlGeometryFromBuffer(garbage)).toBeNull();
  });

  test("tryNormalizedStlGeometryFromBuffer returns parsed geometry for valid STL input", () => {
    const stl = asciiStlBuffer(`
solid part
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid part
`);

    const geometry = tryNormalizedStlGeometryFromBuffer(stl);

    expect(geometry).not.toBeNull();
    expect(geometry?.getAttribute("position").count).toBe(3);
  });

  test("rejects binary STL input whose declared face count exceeds its size", () => {
    // three's binary parser sizes its typed arrays from the declared face
    // count before any bounds check, so an inflated declaration in a small
    // file forces a giant allocation. The preview must reject it up front.
    const stl = new ArrayBuffer(84);
    new DataView(stl).setUint32(80, 100_000_000, true);

    expect(() => normalizedStlGeometryFromBuffer(stl)).toThrow("STL file declares more faces than its size allows.");
    expect(tryNormalizedStlGeometryFromBuffer(stl)).toBeNull();
  });

  test("still accepts binary STL input with extra trailing bytes beyond the declared faces", () => {
    const triangle = new ArrayBuffer(84 + 50);
    const view = new DataView(triangle);
    view.setUint32(80, 1, true);
    // One triangle in the z=0 plane.
    view.setFloat32(84 + 12, 10, true);
    view.setFloat32(84 + 24, 10, true);
    view.setFloat32(84 + 34, 10, true);
    const padded = new Uint8Array(84 + 50 + 16);
    padded.set(new Uint8Array(triangle), 0);

    const geometry = tryNormalizedStlGeometryFromBuffer(padded.buffer);

    expect(geometry).not.toBeNull();
    expect(geometry?.getAttribute("position").count).toBe(3);
  });
});
