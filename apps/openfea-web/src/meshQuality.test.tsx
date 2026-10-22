import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { computeTetMeshQuality } from "@openfea/core";
import { bracketDemoProject, bracketDisplayModel } from "@openfea/samples";
import { MeshQualityMetricsSchema, ProjectSchema, type Project, type ResultSummary } from "@openfea/schema";
import { buildAutosavedWorkspace, parseAutosavedWorkspacePayload, type WorkspaceUiSnapshot } from "./appPersistence";
import { MeshQualityCard } from "./components/panels/MeshQualityCard";
import { openLocalProjectPayload } from "./localProjectFactory";
import { meshQualityMetricRows, meshQualityReportRows } from "./meshQualityDisplay";
import { worstElementOverlayGeometry } from "./meshQualityOverlay";
import { buildReportData } from "./report/reportData";

// A version-2 project saved before plan 036 R2.1: a gmsh-wasm mesh summary without qualityMetrics.
const PRE_R2_1_PROJECT_FILE = JSON.parse(readFileSync(resolve(__dirname, "testdata/mesh-quality/pre-r2-1-project.openfea.json"), "utf8")) as {
  project: Project;
  displayModel: unknown;
};

// One regular tet, one sliver, one inverted copy of the regular tet.
const COORDINATES = [1, 1, 1, -1, 1, -1, 1, -1, -1, -1, -1, 1, 0, 0, 0, 1, 0, 1e-4, 1, 1, 0, 0, 1, 1e-4];
const CONNECTIVITY = [0, 1, 2, 3, 4, 5, 6, 7, 1, 0, 2, 3];
const QUALITY = computeTetMeshQuality({ coordinates: COORDINATES, connectivity: CONNECTIVITY, elementType: "Tet4" })!;

const UI = {
  activeStep: "mesh",
  homeRequested: false,
  selectedFaceId: null,
  selectedLoadPoint: null,
  selectedPayloadObject: null,
  viewMode: "mesh",
  themeMode: "dark",
  resultMode: "stress",
  showDeformed: false,
  showDimensions: false,
  stressExaggeration: 1,
  resultFrameIndex: 0,
  resultPlaybackFps: 12,
  resultPlaybackReverseLoop: false,
  draftLoadType: "force",
  draftLoadValue: 500,
  draftLoadDirection: "-Z",
  sampleModel: "cantilever",
  sampleAnalysisType: "static_stress",
  activeRunId: "",
  completedRunId: "",
  runProgress: 0,
  undoStack: [],
  redoStack: [],
  status: "Ready",
  logs: []
} satisfies WorkspaceUiSnapshot;

function projectWithQuality(qualityMetrics: unknown): Project {
  const project = structuredClone(PRE_R2_1_PROJECT_FILE.project);
  const summary = project.studies[0]!.meshSettings.summary!;
  (summary as Record<string, unknown>).qualityMetrics = qualityMetrics;
  return project;
}

describe("mesh quality persistence", () => {
  test("projects saved before mesh-quality metrics still load", () => {
    const parsed = ProjectSchema.parse(PRE_R2_1_PROJECT_FILE.project);
    expect(parsed.studies[0]?.meshSettings.summary?.source).toBe("wasm_gmsh");
    expect(parsed.studies[0]?.meshSettings.summary?.qualityMetrics).toBeUndefined();
    expect(() => openLocalProjectPayload(PRE_R2_1_PROJECT_FILE)).not.toThrow();

    const autosave = buildAutosavedWorkspace({ project: parsed, displayModel: bracketDisplayModel, ui: UI });
    const restored = parseAutosavedWorkspacePayload(JSON.stringify(autosave));
    expect(restored?.projectFile.project.studies[0]?.meshSettings.summary?.nodes).toBe(1234);
  });

  test("the computed summary is JSON-safe, matches the schema and survives autosave restore", () => {
    expect(MeshQualityMetricsSchema.parse(JSON.parse(JSON.stringify(QUALITY)))).toEqual(QUALITY);
    const project = ProjectSchema.parse(projectWithQuality(QUALITY));
    const autosave = buildAutosavedWorkspace({ project, displayModel: bracketDisplayModel, ui: UI });
    const restored = parseAutosavedWorkspacePayload(JSON.stringify(autosave));
    expect(restored?.projectFile.project.studies[0]?.meshSettings.summary?.qualityMetrics).toEqual(QUALITY);
  });

  test("an unreadable summary is dropped instead of failing the project load", () => {
    const parsed = ProjectSchema.safeParse(projectWithQuality({ version: 99, metrics: "corrupt" }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.studies[0]?.meshSettings.summary?.qualityMetrics).toBeUndefined();
    expect(parsed.success && parsed.data.studies[0]?.meshSettings.summary?.nodes).toBe(1234);
  });
});

describe("mesh quality display", () => {
  test("rows label the worst side and count elements past each threshold", () => {
    const rows = meshQualityMetricRows(QUALITY);
    expect(rows.map((row) => row.key)).toEqual(["scaledJacobian", "aspectRatio", "minDihedralDeg", "maxDihedralDeg"]);
    expect(rows[0]).toMatchObject({ thresholdLabel: "< 0.2", flagged: 2, lowerIsWorse: true });
    expect(rows[1]).toMatchObject({ thresholdLabel: "> 3", flagged: 1, lowerIsWorse: false });
  });

  test("the Mesh panel card shows statistics, histograms, flags and the worst-element toggle", () => {
    const html = renderToStaticMarkup(<MeshQualityCard quality={QUALITY} showWorst={false} onShowWorstChange={() => undefined} />);
    expect(html).toContain("Element quality");
    expect(html).toContain("2 flagged");
    expect(html).toContain("Scaled Jacobian");
    expect(html).toContain("never block a solve");
    expect(html.match(/class="mesh-quality-histogram"/g)).toHaveLength(4);
    expect(html).toContain(`Show worst ${QUALITY.worstElements.length} elements`);
    expect(html).toContain('aria-pressed="false"');
    expect(renderToStaticMarkup(<MeshQualityCard quality={QUALITY} showWorst={false} />)).not.toContain("Show worst");
  });

  test("the card warns when a Tet10 element has non-positive det J", () => {
    const tet10 = { ...QUALITY, elementType: "Tet10" as const, flagged: { ...QUALITY.flagged, tet10NonPositiveDetJ: 3, tet10DetJRatio: 3 } };
    const html = renderToStaticMarkup(<MeshQualityCard quality={tet10} showWorst={false} />);
    expect(html).toContain("3 Tet10 elements have det J ≤ 0 at a solver Gauss point");
  });

  test("the report adds a mesh-quality block only when the mesh carries metrics", () => {
    const summary = bracketDemoProject.studies[0]!.meshSettings.summary!;
    const base = {
      project: bracketDemoProject,
      displayModel: bracketDisplayModel,
      resultSummary: { maxStress: 1, maxStressUnits: "MPa", maxDisplacement: 1, maxDisplacementUnits: "mm", safetyFactor: 2, reactionForce: 1, reactionForceUnits: "N" } satisfies ResultSummary,
      resultFields: [],
      solverMeshSummary: null,
      runTiming: null,
      unitSystem: "SI" as const,
      captures: {},
      generatedAt: new Date("2026-10-21T00:00:00.000Z"),
      exaggeration: 1
    };
    const study = bracketDemoProject.studies[0]!;
    expect(buildReportData({ ...base, study }).meshQuality).toBeNull();
    const withQuality = buildReportData({ ...base, study: { ...study, meshSettings: { ...study.meshSettings, summary: { ...summary, qualityMetrics: QUALITY } } } });
    expect(withQuality.meshQuality?.[0]).toEqual({ label: "Elements checked", value: "3 Tet4 elements" });
    expect(withQuality.meshQuality).toEqual(expect.arrayContaining(meshQualityReportRows(QUALITY)));
    expect(withQuality.meshQuality?.at(-1)?.value).toContain("do not block solving");
  });
});

describe("worst-element overlay geometry", () => {
  test("draws each listed element's corner faces, edges and centroid in mesh order across blocks", () => {
    const model = {
      nodes: { coordinates: COORDINATES },
      elementBlocks: [
        { type: "Tet4", connectivity: CONNECTIVITY.slice(0, 4) },
        { type: "Tet4", connectivity: CONNECTIVITY.slice(4) }
      ]
    };
    const geometry = worstElementOverlayGeometry(model, [1, 99])!;
    expect(geometry.triangles).toHaveLength(4 * 3 * 3);
    expect(geometry.edges).toHaveLength(6 * 2 * 3);
    expect(Array.from(geometry.centroids)).toEqual([0.5, 0.5, 0.5e-4].map((value) => Math.fround(value)));
    expect(worstElementOverlayGeometry(model, [42])).toBeNull();
  });
});
