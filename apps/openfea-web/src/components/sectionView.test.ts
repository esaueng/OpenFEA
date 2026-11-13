import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { sectionPlaneForBounds } from "./CadViewer";
import { isClosedTriangleMesh, isPointCutAwayBySection } from "./sectionView";

const cadViewerSource = readFileSync(resolve(__dirname, "CadViewer.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("section view marker culling", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-2, -1, -0.5), new THREE.Vector3(6, 3, 0.5));

  test("treats anchors on the clipped side as cut away and keeps the cut face and kept side", () => {
    // Same convention as three.js clipping planes: negative distance is discarded.
    const plane = sectionPlaneForBounds({ enabled: true, axis: "x", offset: 0.5, flipped: false }, bounds);
    expect(isPointCutAwayBySection(plane, new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(isPointCutAwayBySection(plane, new THREE.Vector3(2, 0, 0))).toBe(false);
    expect(isPointCutAwayBySection(plane, new THREE.Vector3(5, 0, 0))).toBe(false);

    const flipped = sectionPlaneForBounds({ enabled: true, axis: "x", offset: 0.5, flipped: true }, bounds);
    expect(isPointCutAwayBySection(flipped, new THREE.Vector3(0, 0, 0))).toBe(false);
    expect(isPointCutAwayBySection(flipped, new THREE.Vector3(5, 0, 0))).toBe(true);

    expect(isPointCutAwayBySection(null, new THREE.Vector3(-100, 0, 0))).toBe(false);
  });

  test("peak callout, probes and boundary-condition markers are culled by the section plane", () => {
    // The live review found Peak/P1 labels floating over geometry the section had removed.
    expect(cadViewerSource).toMatch(/<SectionCulled anchor=\{point\}>\n\s*<Html position=\{point\}/);
    expect(cadViewerSource.match(/<SectionCulled key=\{reading\.id\} anchor=\{point\}><UserResultProbeMarker/g)).toHaveLength(2);
    expect(cadViewerSource).toContain("<SectionCulled key={marker.id} anchor={loadMarkerAnchor(marker, face)}>");
    expect(cadViewerSource).toContain("<SectionCulled key={marker.id} anchor={face.center}><SupportGlyph");
    expect(cadViewerSource).toContain("<SectionPlaneContext.Provider value={sectionClipPlane}>");
  });

  test("the Open section label stays on the section plane for every axis", () => {
    // It used to overwrite Y with the bounds top, which put a Y-section label over the cut-away half.
    expect(cadViewerSource).not.toContain("center.y = bounds.max.y");
    expect(cadViewerSource).toContain("const liftAxis = axisIndex === 2 ? 1 : 2;");
  });
});

describe("section cap", () => {
  test("caps only closed meshes, welding split vertices", () => {
    const box = new THREE.BoxGeometry(1, 2, 3); // indexed, but faces do not share vertices
    expect(isClosedTriangleMesh(box)).toBe(true);
    expect(isClosedTriangleMesh(box.toNonIndexed())).toBe(true);
    expect(isClosedTriangleMesh(new THREE.TorusGeometry(1, 0.2, 8, 16))).toBe(true);
    // Open surfaces would corrupt the stencil count, so they stay uncapped.
    expect(isClosedTriangleMesh(new THREE.PlaneGeometry(1, 1, 2, 2))).toBe(false);
    expect(isClosedTriangleMesh(new THREE.CylinderGeometry(1, 1, 2, 12, 1, true))).toBe(false);
  });

  test("the viewer asks for a stencil buffer and renders the cap", () => {
    expect(cadViewerSource).toContain("const VIEWER_GL_OPTIONS = { stencil: true } as const;");
    expect(cadViewerSource).toContain("gl={VIEWER_GL_OPTIONS}");
    expect(cadViewerSource).toMatch(/<SectionCap bounds=\{sectionBounds\}/);
  });
});
