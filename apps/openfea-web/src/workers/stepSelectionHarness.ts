// Real-browser regression harness for STEP face selection across the two
// production display paths introduced by PR #79:
// - detailed viewport tessellation, with edge overlays and picking;
// - balanced result-playback tessellation, without the expensive edge overlay.
//
// The harness generates exact analytic cylinders at multiple model scales,
// raycasts their cylindrical wall and top face in a browser, assigns those
// persistent face references to a support/load, and proves that both LODs map
// the hits back to the same B-rep identities and fingerprints.
//
// Multi-pick (plan 036 R1.2): at each LOD the two raycast hits are fed through
// the viewer's own pick seam as Ctrl-click and Cmd-click (resolveStepPickFaceId,
// pickIntentForModifiers, applyFacePick), saved as a named selection, reused by
// a support and a load, and toggled off again. Both LODs must produce the same
// two B-rep identities and the same persisted named selection.
import * as THREE from "three";
import type { Study } from "@openfea/schema";
import { buildParametricPartStep } from "@openfea/step";
import {
  buildStepFaceRegistry,
  resolvePickedStepFace,
  stepFaceIdForMeshTriangle,
  stepFaceRecordForId,
  stepSupportFaceIdForPickedFace,
  type StepFaceRecord,
  type StepFaceRegistry
} from "../stepFaces";
import { applyFacePick, EMPTY_WORKING_SELECTION, pickIntentForModifiers, resolveStepPickFaceId, workingSelectionFaceIds, type StepPickApi } from "../components/viewer/selection";
import { createNamedFaceSelection, faceSelectionLookup, namedSelectionFacesFor, parseFaceSetFingerprint } from "../namedSelections";
import { assignedFaceTintsForStudy } from "../assignedFaceTints";
import { getOcctImporter, stepPreviewFromBase64 } from "../stepPreview";
import {
  readStepFileForDisplay,
  type StepDisplayLod
} from "../stepDisplayTessellation";

const CYLINDER_DIAMETERS_MM = [1, 25, 500] as const;
const FIXTURE_CREATED_AT = new Date("2026-07-29T00:00:00Z");
const SUPPORT_SELECTION_ID = "selection-cylinder-wall";
const LOAD_SELECTION_ID = "selection-cylinder-top";

type PickedFace = {
  faceId: string;
  fingerprint: string;
};

type MultiPickProof = {
  /** Faces in the working selection after Ctrl-click wall, Cmd-click top. */
  faceIds: string[];
  /** The saved named selection: face IDs and per-face fingerprints in order. */
  namedSelection: { id: string; faceIds: string[]; faceFingerprints: string[]; fingerprint: string };
  /** Faces tinted once a support and a load reuse the named selection. */
  tintedFaceIds: string[];
  /** Faces left after Ctrl-clicking the wall again. */
  afterToggleOff: string[];
};

type LodProof = {
  triangleCount: number;
  edgeSegmentCount: number;
  wall: PickedFace;
  top: PickedFace;
  multiPick: MultiPickProof;
};

export type StepSelectionScaleProof = {
  diameterMm: number;
  supportFaceId: string;
  loadFaceId: string;
  detailed: LodProof;
  balanced: LodProof;
};

export type StepSelectionProofResult = {
  ok: boolean;
  scales: StepSelectionScaleProof[];
  failures: string[];
};

export async function runStepSelectionProof(): Promise<StepSelectionProofResult> {
  const importer = await getOcctImporter();
  const scales: StepSelectionScaleProof[] = [];
  const failures: string[] = [];

  for (const diameterMm of CYLINDER_DIAMETERS_MM) {
    try {
      const { stepText } = buildParametricPartStep(
        "cylinder",
        { diameter: diameterMm, height: diameterMm },
        { createdAt: FIXTURE_CREATED_AT }
      );
      requireCondition(stepText.includes("CYLINDRICAL_SURFACE"), `${diameterMm} mm fixture lost its exact cylindrical surface`);
      requireCondition(stepText.includes("CIRCLE"), `${diameterMm} mm fixture lost its exact circular edges`);

      const contentBase64 = btoa(stepText);
      const detailed = await inspectLod(importer, contentBase64, stepText, "detailed");
      const wall = requireFace(
        detailed.registry.faces.find((face) => face.surfaceType === "cylindrical" && !face.cylinder?.interior),
        `${diameterMm} mm detailed cylindrical wall`
      );
      const top = requireFace(
        [...detailed.registry.faces]
          .filter((face) => face.surfaceType === "planar")
          .sort((left, right) => right.centroid[2] - left.centroid[2])[0],
        `${diameterMm} mm detailed top face`
      );
      const study = assignedCylinderStudy(wall, top);
      const supportSelection = requireSelection(study, study.constraints[0]?.selectionRef, "fixed support");
      const loadSelection = requireSelection(study, study.loads[0]?.selectionRef, "force load");

      const balanced = await inspectLod(importer, contentBase64, stepText, "balanced");
      const proof: StepSelectionScaleProof = {
        diameterMm,
        supportFaceId: requireGeometryFaceId(supportSelection, "fixed support"),
        loadFaceId: requireGeometryFaceId(loadSelection, "force load"),
        detailed: pickedLodProof(detailed, wall, top, study),
        balanced: pickedLodProof(balanced, wall, top, study)
      };

      requireCondition(detailed.registry.faces.length === 3, `${diameterMm} mm detailed registry did not contain exactly three cylinder faces`);
      requireCondition(balanced.registry.faces.length === 3, `${diameterMm} mm balanced registry did not contain exactly three cylinder faces`);
      requireCondition(proof.detailed.edgeSegmentCount > 0, `${diameterMm} mm detailed viewport path did not include its edge overlay`);
      requireCondition(proof.balanced.edgeSegmentCount === 0, `${diameterMm} mm lightweight playback path retained an edge overlay`);
      requireCondition(
        proof.detailed.triangleCount > proof.balanced.triangleCount,
        `${diameterMm} mm balanced playback mesh was not lighter than the detailed viewport mesh`
      );
      requireMappedAssignment(proof.detailed.wall, supportSelection, "detailed cylindrical-wall support");
      requireMappedAssignment(proof.detailed.top, loadSelection, "detailed top-face load");
      requireMappedAssignment(proof.balanced.wall, supportSelection, "balanced cylindrical-wall support");
      requireMappedAssignment(proof.balanced.top, loadSelection, "balanced top-face load");
      for (const [lod, multiPick] of [["detailed", proof.detailed.multiPick], ["balanced", proof.balanced.multiPick]] as const) {
        requireMultiPick(multiPick, wall, top, `${diameterMm} mm ${lod}`);
      }
      requireCondition(
        JSON.stringify(proof.detailed.multiPick) === JSON.stringify(proof.balanced.multiPick),
        `${diameterMm} mm multi-pick named selection differed between display LODs`
      );
      scales.push(proof);
    } catch (error) {
      failures.push(`${diameterMm} mm: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: failures.length === 0 && scales.length === CYLINDER_DIAMETERS_MM.length,
    scales,
    failures
  };
}

const STEP_PICK_API: StepPickApi = { stepFaceIdForMeshTriangle, resolvePickedStepFace, stepSupportFaceIdForPickedFace };

type InspectedLod = {
  registry: StepFaceRegistry;
  triangleCount: number;
  edgeSegmentCount: number;
  wallPick: PickedFace;
  topPick: PickedFace;
};

async function inspectLod(
  importer: Awaited<ReturnType<typeof getOcctImporter>>,
  contentBase64: string,
  stepText: string,
  lod: StepDisplayLod
): Promise<InspectedLod> {
  const imported = readStepFileForDisplay(importer, new TextEncoder().encode(stepText), lod);
  requireCondition(imported.success, `${lod} OCCT import failed${imported.errorCode ? ` (${imported.errorCode})` : ""}`);
  const registry = buildStepFaceRegistry(imported.meshes ?? []);
  const preview = await stepPreviewFromBase64(contentBase64, "#63a9e5", {
    includeEdges: lod === "detailed",
    shareMaterials: lod === "balanced",
    lod
  });

  try {
    return {
      registry,
      triangleCount: previewTriangleCount(preview.object),
      edgeSegmentCount: previewEdgeSegmentCount(preview.object),
      wallPick: raycastFace(preview.object, registry, new THREE.Vector3(4, 0.17, 0.13), new THREE.Vector3(-1, 0, 0)),
      topPick: raycastFace(preview.object, registry, new THREE.Vector3(0.23, 0.17, 4), new THREE.Vector3(0, 0, -1))
    };
  } finally {
    disposeObjectTree(preview.object);
  }
}

function pickedLodProof(
  inspected: InspectedLod,
  expectedWall: StepFaceRecord,
  expectedTop: StepFaceRecord,
  study: Study
): LodProof {
  requireCondition(inspected.wallPick.faceId === expectedWall.faceId, `wall raycast resolved ${inspected.wallPick.faceId}, expected ${expectedWall.faceId}`);
  requireCondition(inspected.topPick.faceId === expectedTop.faceId, `top raycast resolved ${inspected.topPick.faceId}, expected ${expectedTop.faceId}`);
  return {
    triangleCount: inspected.triangleCount,
    edgeSegmentCount: inspected.edgeSegmentCount,
    wall: inspected.wallPick,
    top: inspected.topPick,
    multiPick: multiPickProof(inspected, study)
  };
}

/**
 * Ctrl-click the wall, Cmd-click the top, save the two as a named selection,
 * reuse it in a support and a load, then Ctrl-click the wall off again — all
 * through the viewer's pick seam, on this LOD's own raycast hits and registry.
 */
function multiPickProof(inspected: InspectedLod, study: Study): MultiPickProof {
  const lookup = faceSelectionLookup(study);
  const wallClick = applyFacePick(EMPTY_WORKING_SELECTION, inspected.wallPick.faceId, pickIntentForModifiers({ ctrlKey: true }), lookup);
  requireCondition(wallClick.outcome === "primary", `Ctrl-click on the wall gave ${wallClick.outcome}, expected primary`);
  const topClick = applyFacePick(wallClick.selection, inspected.topPick.faceId, pickIntentForModifiers({ metaKey: true }), lookup);
  requireCondition(topClick.outcome === "added", `Cmd-click on the top gave ${topClick.outcome}, expected added`);
  const faceIds = workingSelectionFaceIds(topClick.selection, lookup);
  const faces = namedSelectionFacesFor(study, faceIds, inspected.registry.displayFaces, (faceId) => stepFaceRecordForId(inspected.registry, faceId)?.fingerprint);
  const created = createNamedFaceSelection(study, "Wall and top", faces, "multi-pick-proof");
  if (!created.ok) throw new Error(`named selection was refused: ${created.error}`);
  const reused = {
    ...study,
    namedSelections: created.namedSelections,
    constraints: [{ ...study.constraints[0]!, selectionRef: created.selection.id }],
    loads: [{ ...study.loads[0]!, selectionRef: created.selection.id }]
  } as Study;
  const afterToggle = applyFacePick(topClick.selection, inspected.wallPick.faceId, pickIntentForModifiers({ ctrlKey: true }), lookup);
  requireCondition(afterToggle.outcome === "removed", `Ctrl-click on the selected wall gave ${afterToggle.outcome}, expected removed`);
  return {
    faceIds,
    namedSelection: {
      id: created.selection.id,
      faceIds: created.selection.geometryRefs.map((ref) => ref.entityId),
      faceFingerprints: parseFaceSetFingerprint(created.selection.fingerprint) ?? [],
      fingerprint: created.selection.fingerprint
    },
    tintedFaceIds: assignedFaceTintsForStudy(reused).map((tint) => tint.faceId).sort(),
    afterToggleOff: workingSelectionFaceIds(afterToggle.selection, lookup)
  };
}

function requireMultiPick(proof: MultiPickProof, wall: StepFaceRecord, top: StepFaceRecord, role: string): void {
  const expected = [wall.faceId, top.faceId];
  requireCondition(JSON.stringify(proof.faceIds) === JSON.stringify(expected), `${role} multi-pick selected ${proof.faceIds.join(", ")}, expected ${expected.join(", ")}`);
  requireCondition(JSON.stringify(proof.namedSelection.faceIds) === JSON.stringify(expected), `${role} named selection kept ${proof.namedSelection.faceIds.join(", ")}`);
  requireCondition(
    JSON.stringify(proof.namedSelection.faceFingerprints) === JSON.stringify([wall.fingerprint, top.fingerprint]),
    `${role} named selection changed a face fingerprint`
  );
  requireCondition(JSON.stringify(proof.tintedFaceIds) === JSON.stringify([...expected].sort()), `${role} reuse did not tint both faces`);
  requireCondition(JSON.stringify(proof.afterToggleOff) === JSON.stringify([top.faceId]), `${role} Ctrl-click did not remove the wall`);
}

/** Raycast like a viewer click and resolve the hit through the viewer's STEP pick seam. */
function raycastFace(
  object: THREE.Group,
  registry: StepFaceRegistry,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): PickedFace {
  object.updateMatrixWorld(true);
  const intersections = new THREE.Raycaster(origin, direction.normalize()).intersectObject(object, true);
  for (const intersection of intersections) {
    if (!(intersection.object instanceof THREE.Mesh) || typeof intersection.faceIndex !== "number") continue;
    const faceId = resolveStepPickFaceId(STEP_PICK_API, registry, { object: intersection.object, faceIndex: intersection.faceIndex }, { preferHoleWall: false, allowExactFallback: false });
    const record = faceId ? registry.faces.find((face) => face.faceId === faceId) : undefined;
    if (record) return { faceId: record.faceId, fingerprint: record.fingerprint };
  }
  throw new Error(`raycast from ${origin.toArray().join(",")} did not resolve a STEP face`);
}

function assignedCylinderStudy(wall: StepFaceRecord, top: StepFaceRecord): Study {
  return {
    id: "study-step-selection-proof",
    projectId: "project-step-selection-proof",
    name: "Cylinder selection proof",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Cylinder" }],
    materialAssignments: [{
      id: "material-cylinder",
      materialId: "mat-aluminum-6061",
      selectionRef: "selection-cylinder-body",
      parameters: {},
      status: "complete"
    }],
    namedSelections: [
      {
        id: "selection-cylinder-body",
        name: "Cylinder",
        entityType: "body",
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Cylinder" }],
        fingerprint: "body-uploaded-cylinder"
      },
      faceSelection(SUPPORT_SELECTION_ID, "Cylinder wall", wall),
      faceSelection(LOAD_SELECTION_ID, "Cylinder top", top)
    ],
    contacts: [],
    constraints: [{
      id: "constraint-cylinder-wall",
      type: "fixed",
      selectionRef: SUPPORT_SELECTION_ID,
      parameters: {},
      status: "complete"
    }],
    loads: [{
      id: "load-cylinder-top",
      type: "force",
      selectionRef: LOAD_SELECTION_ID,
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    }],
    meshSettings: { preset: "medium", status: "not_started" },
    solverSettings: { analysisType: "linear_static", smallDisplacement: true },
    validation: [],
    runs: []
  };
}

function faceSelection(id: string, name: string, face: StepFaceRecord): Study["namedSelections"][number] {
  return {
    id,
    name,
    entityType: "face",
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: face.faceId, label: face.faceId }],
    fingerprint: face.fingerprint
  };
}

function requireSelection(
  study: Study,
  selectionRef: string | undefined,
  role: string
): Study["namedSelections"][number] {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  if (!selection) throw new Error(`${role} did not retain its named selection`);
  return selection;
}

function requireGeometryFaceId(selection: Study["namedSelections"][number], role: string): string {
  const faceId = selection.geometryRefs.find((reference) => reference.entityType === "face")?.entityId;
  if (!faceId) throw new Error(`${role} selection did not retain a face reference`);
  return faceId;
}

function requireMappedAssignment(
  picked: PickedFace,
  selection: Study["namedSelections"][number],
  role: string
): void {
  requireCondition(picked.faceId === requireGeometryFaceId(selection, role), `${role} changed face identity to ${picked.faceId}`);
  requireCondition(picked.fingerprint === selection.fingerprint, `${role} changed topology fingerprint`);
}

function previewTriangleCount(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    count += (geometry.getIndex()?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3;
  });
  return count;
}

function previewEdgeSegmentCount(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((child) => {
    if (!(child instanceof THREE.LineSegments)) return;
    const positions = (child.geometry as THREE.BufferGeometry).getAttribute("position");
    count += (positions?.count ?? 0) / 2;
  });
  return count;
}

function disposeObjectTree(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments)) return;
    (child.geometry as THREE.BufferGeometry | undefined)?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose();
  });
}

function requireFace(face: StepFaceRecord | undefined, label: string): StepFaceRecord {
  if (!face) throw new Error(`${label} was not found`);
  return face;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function renderProofResult(result: StepSelectionProofResult): void {
  let proof = document.getElementById("openfea-step-selection-proof");
  if (!proof) {
    proof = document.createElement("pre");
    proof.id = "openfea-step-selection-proof";
    proof.setAttribute("role", "status");
    proof.style.cssText = [
      "position:fixed",
      "inset:16px",
      "z-index:2147483647",
      "overflow:auto",
      "margin:0",
      "padding:20px",
      "border:2px solid #38bdf8",
      "border-radius:12px",
      "background:#07111dee",
      "color:#e0f2fe",
      "font:13px/1.5 ui-monospace,monospace",
      "white-space:pre-wrap"
    ].join(";");
    document.body.appendChild(proof);
  }
  const summary = result.scales.map((scale) => (
    `${scale.diameterMm} mm · support ${scale.supportFaceId} · load ${scale.loadFaceId} · ` +
    `triangles ${scale.detailed.triangleCount} detailed / ${scale.balanced.triangleCount} playback · ` +
    `multi-pick ${scale.detailed.multiPick.faceIds.join(" + ")} (detailed) / ${scale.balanced.multiPick.faceIds.join(" + ")} (playback)`
  ));
  proof.textContent = [
    `STEP selection LOD proof: ${result.ok ? "PASS" : "FAIL"}`,
    "",
    ...summary,
    ...(result.failures.length ? ["", ...result.failures] : [])
  ].join("\n");
}

declare global {
  interface Window {
    __openfeaStepSelectionProof?: {
      run: typeof runStepSelectionProof;
      lastResult?: StepSelectionProofResult;
    };
  }
}

window.__openfeaStepSelectionProof = { run: runStepSelectionProof };

if (new URLSearchParams(window.location.search).has("stepSelectionProof")) {
  void runStepSelectionProof().then((result) => {
    window.__openfeaStepSelectionProof!.lastResult = result;
    renderProofResult(result);
    document.title = `STEPSELECTION ${result.ok ? "OK" : "FAIL"} scales=${result.scales.length}`;
    console.log("[stepSelectionProof]", result);
  }).catch((error: unknown) => {
    const result: StepSelectionProofResult = {
      ok: false,
      scales: [],
      failures: [error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)]
    };
    window.__openfeaStepSelectionProof!.lastResult = result;
    renderProofResult(result);
    document.title = "STEPSELECTION FAIL";
    console.error("[stepSelectionProof]", result);
  });
}
