/*!
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

import * as THREE from "three";

// Attribute and group behavior follows Three.js STLLoader's ASCII parser.
// Its unanchored lazy section regexes retry every opening keyword when a
// terminator is missing. A monotonic scan has the same matches in linear work,
// including the existing behavior for unmatched trailing text and solid names.
function* sections(text: string, opening: string, closing: string): Iterable<string> {
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf(opening, offset);
    if (start < 0) return;
    const end = text.indexOf(closing, start + opening.length);
    if (end < 0) return;
    offset = end + closing.length;
    yield text.slice(start, offset);
  }
}

export function parseAsciiStlPreview(text: string): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const normals: number[] = [];
  const groupNames: string[] = [];
  const normal = new THREE.Vector3();
  const float = /[\s]+([+-]?(?:\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?)/.source;
  const vertexPattern = new RegExp("vertex" + float + float + float, "g");
  const normalPattern = new RegExp("normal" + float + float + float, "g");
  let faceCounter = 0;
  let endVertex = 0;

  for (const solid of sections(text, "solid", "endsolid")) {
    const startVertex = endVertex;
    groupNames.push(/solid\s(.+)/.exec(solid)?.[1] ?? "");
    for (const face of sections(solid, "facet", "endfacet")) {
      let vertexCount = 0;
      let normalCount = 0;
      let match: RegExpExecArray | null;
      while ((match = normalPattern.exec(face)) !== null) {
        normal.set(parseFloat(match[1]!), parseFloat(match[2]!), parseFloat(match[3]!));
        normalCount++;
      }
      while ((match = vertexPattern.exec(face)) !== null) {
        vertices.push(parseFloat(match[1]!), parseFloat(match[2]!), parseFloat(match[3]!));
        normals.push(normal.x, normal.y, normal.z);
        vertexCount++;
        endVertex++;
      }
      if (normalCount !== 1) console.error("THREE.STLLoader: Something isn't right with the normal of face number " + faceCounter);
      if (vertexCount !== 3) console.error("THREE.STLLoader: Something isn't right with the vertices of face number " + faceCounter);
      faceCounter++;
    }
    geometry.userData.groupNames = groupNames;
    geometry.addGroup(startVertex, endVertex - startVertex, groupNames.length - 1);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}


// Three.js STLLoader binary semantics without its URL-loading interface or
// duplicate ASCII parser. The shared caller checks declared sizes first.
export function parseBinaryStlPreview(data: ArrayBuffer): THREE.BufferGeometry {
  const reader = new DataView(data);
  const faces = reader.getUint32(80, true);
  let colors: Float32Array | undefined;
  let defaultR = 0, defaultG = 0, defaultB = 0, alpha = 0;
  for (let index = 0; index < 70; index++) {
    if (reader.getUint32(index, false) === 0x434f4c4f && reader.getUint8(index + 4) === 0x52 && reader.getUint8(index + 5) === 0x3d) {
      colors = new Float32Array(faces * 9);
      defaultR = reader.getUint8(index + 6) / 255;
      defaultG = reader.getUint8(index + 7) / 255;
      defaultB = reader.getUint8(index + 8) / 255;
      alpha = reader.getUint8(index + 9) / 255;
    }
  }
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array(faces * 9);
  const normals = new Float32Array(faces * 9);
  const color = new THREE.Color();
  for (let face = 0; face < faces; face++) {
    const start = 84 + face * 50;
    const normalX = reader.getFloat32(start, true);
    const normalY = reader.getFloat32(start + 4, true);
    const normalZ = reader.getFloat32(start + 8, true);
    if (colors) {
      const packed = reader.getUint16(start + 48, true);
      if ((packed & 0x8000) === 0) color.setRGB((packed & 31) / 31, ((packed >> 5) & 31) / 31, ((packed >> 10) & 31) / 31, THREE.SRGBColorSpace);
      else color.setRGB(defaultR, defaultG, defaultB, THREE.SRGBColorSpace);
    }
    for (let i = 1; i <= 3; i++) {
      const vertex = start + i * 12;
      const component = face * 9 + (i - 1) * 3;
      vertices[component] = reader.getFloat32(vertex, true);
      vertices[component + 1] = reader.getFloat32(vertex + 4, true);
      vertices[component + 2] = reader.getFloat32(vertex + 8, true);
      normals[component] = normalX;
      normals[component + 1] = normalY;
      normals[component + 2] = normalZ;
      if (colors) {
        colors[component] = color.r;
        colors[component + 1] = color.g;
        colors[component + 2] = color.b;
      }
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (colors) {
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    Object.assign(geometry, { hasColors: true, alpha });
  }
  return geometry;
}
