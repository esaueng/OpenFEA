import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, ResultSummary, Study } from "@openfea/schema";
import { StudySchema } from "@openfea/schema";
import { RightPanel } from "../RightPanel";
import { readinessForStudy } from "../../runReadiness";

// Run-panel behaviour of the pre-run solve-time estimate and its non-blocking
// warnings (plan 036 Release A). Same render harness as RightPanel.test.tsx.

const project: Project = {
  id: "project-run",
  name: "Run estimate project",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const face = { id: "face-top", label: "Top face", color: "#4da3ff", center: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], stressValue: 0 };
const slenderModel: DisplayModel = { id: "display-bar", name: "bar.step", bodyCount: 1, faces: [face], dimensions: { x: 1000, y: 20, z: 20, units: "mm" } };
const blockModel: DisplayModel = { ...slenderModel, id: "display-block", name: "block.step", dimensions: { x: 200, y: 100, z: 100, units: "mm" } };

const resultSummary: ResultSummary = {
  maxStress: 0,
  maxStressUnits: "MPa",
  maxDisplacement: 0,
  maxDisplacementUnits: "mm",
  safetyFactor: 0,
  reactionForce: 0,
  reactionForceUnits: "N"
};

function meshedStudy(type: Study["type"], nodes: number | null, elementOrder: 1 | 2): Study {
  return StudySchema.parse({
    id: "study-run",
    projectId: project.id,
    name: "Study",
    type,
    geometryScope: [],
    materialAssignments: [],
    namedSelections: [],
    contacts: [],
    constraints: [],
    loads: [],
    meshSettings: nodes === null
      ? { preset: "medium", status: "not_started" }
      : { preset: "medium", status: "complete", summary: { nodes, elements: nodes, warnings: [], source: "wasm_gmsh", density: { elementOrder } } },
    solverSettings: { elementOrder },
    validation: [],
    runs: []
  });
}

function renderRun(study: Study, displayModel: DisplayModel, overrides: Partial<Parameters<typeof RightPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <RightPanel
      activeStep="run"
      project={project}
      displayModel={displayModel}
      study={study}
      selectedFace={null}
      viewMode="model"
      resultMode="stress"
      showDeformed={false}
      showDimensions={false}
      stressExaggeration={1}
      resultSummary={resultSummary}
      runProgress={0}
      runTiming={null}
      sampleModel="bracket"
      sampleAnalysisType="static_stress"
      draftLoadType="force"
      draftLoadValue={500}
      draftLoadDirection="-Z"
      selectedLoadPoint={null}
      selectedPayloadObject={null}
      onFitView={vi.fn()}
      onRotateModel={vi.fn()}
      onResetModelOrientation={vi.fn()}
      onLoadSample={vi.fn()}
      onUploadModel={vi.fn()}
      onSampleModelChange={vi.fn()}
      onSampleAnalysisTypeChange={vi.fn()}
      onViewModeChange={vi.fn()}
      onResultModeChange={vi.fn()}
      onToggleDeformed={vi.fn()}
      onToggleDimensions={vi.fn()}
      onStressExaggerationChange={vi.fn()}
      onAssignMaterial={vi.fn()}
      onAddSupport={vi.fn()}
      onUpdateSupport={vi.fn()}
      onRemoveSupport={vi.fn()}
      onDraftLoadTypeChange={vi.fn()}
      onDraftLoadValueChange={vi.fn()}
      onDraftLoadDirectionChange={vi.fn()}
      onAddLoad={vi.fn()}
      onUpdateLoad={vi.fn()}
      onPreviewLoadEdit={vi.fn()}
      onRemoveLoad={vi.fn()}
      onGenerateMesh={vi.fn()}
      onCancelMesh={vi.fn()}
      onRunSimulation={vi.fn()}
      onCancelSimulation={vi.fn()}
      canRunSimulation={true}
      missingRunItems={[]}
      resultPlaybackPlaying={false}
      resultPlaybackFps={12}
      resultPlaybackReverseLoop={false}
      onResultPlaybackToggle={vi.fn()}
      onResultPlaybackFpsChange={vi.fn()}
      onResultPlaybackReverseLoopChange={vi.fn()}
      onStepSelect={vi.fn()}
      runReadiness={readinessForStudy(study)}
      {...overrides}
    />
  );
}

const runButton = (html: string) => html.match(/<button class="primary wide"[^>]*>/)?.[0] ?? "";

describe("Run panel solve-time estimate", () => {
  test("shows an approximate range, labelled as device-dependent, once a mesh exists", () => {
    const html = renderRun(meshedStudy("static_stress", 10_000, 2), blockModel);
    expect(html).toMatch(/<span>Estimated solve time<\/span><strong>(under 10 s|about [^<]+)<\/strong>/);
    expect(html).toContain("Approximate range from in-browser benchmark solves, scaled for 30,000 DOF, Tet10");
    expect(html).toContain("and a 2:1 bounding box");
    expect(html).toContain("Actual time depends on your browser and device; meshing is not included.");
  });

  test("waits for the mesh instead of estimating from preset counts", () => {
    const html = renderRun(meshedStudy("static_stress", null, 2), blockModel);
    expect(html).toContain("<span>Estimated solve time</span><strong>After meshing</strong>");
    expect(html).not.toContain("Approximate range from in-browser benchmark solves");
  });

  test("hides the pre-run estimate while a run is in progress", () => {
    const html = renderRun(meshedStudy("static_stress", 10_000, 2), blockModel, { runProgress: 40, canCancelSimulation: true });
    expect(html).not.toContain("Estimated solve time");
  });

  test("says why the range is wider for an analysis the ladder did not measure", () => {
    const html = renderRun(meshedStudy("steady_state_thermal", 10_000, 2), blockModel);
    expect(html).toContain("Wider range: Thermal solves were not benchmarked");
  });
});

describe("Run panel slender and Tet4 warnings", () => {
  test("warns about a long slender solve without disabling Run", () => {
    const html = renderRun(meshedStudy("static_stress", 50_000, 2), slenderModel);
    expect(html).toContain('class="panel-warning run-advisory" data-advisory="slender-long-run"');
    expect(html).toContain("<strong>Long solve expected.</strong>");
    expect(html).toMatch(/projected to take about \d+–\d+ min/);
    expect(html).toContain("For a first look, try a coarser mesh preset.");
    expect(runButton(html)).not.toContain("disabled");
    // Warnings sit in the Readiness section, before the settings.
    expect(html.indexOf("slender-long-run")).toBeLessThan(html.indexOf("Simulation settings"));
  });

  test.each(["static_stress", "modal_analysis", "dynamic_structural", "steady_state_thermal"] as const)("shows no slender warning for a compact %s part", (type) => {
    const html = renderRun(meshedStudy(type, 50_000, 2), blockModel);
    expect(html).not.toContain("run-advisory");
  });

  test("offers fewer modes for a slender modal study", () => {
    const html = renderRun(meshedStudy("modal_analysis", 10_000, 2), slenderModel);
    expect(html).toContain("try a coarser mesh preset or request fewer modes");
  });

  test("adds the Tet4 bending note for a slender static Tet4 part", () => {
    const html = renderRun(meshedStudy("static_stress", 2_000, 1), slenderModel);
    expect(html).toContain('class="callout run-advisory" data-advisory="tet4-bending-locking"');
    expect(html).toContain("<strong>Tet4 bending stiffness.</strong>");
    expect(html).toContain("5–14% less deflection than beam theory");
    expect(html).toContain("Tet10 is recommended for bending-dominated parts");
    // Short run: the bending note stands alone.
    expect(html).not.toContain("slender-long-run");
    expect(runButton(html)).not.toContain("disabled");
  });

  test("omits the Tet4 note for Tet10 and for dynamic studies", () => {
    expect(renderRun(meshedStudy("static_stress", 2_000, 2), slenderModel)).not.toContain("tet4-bending-locking");
    expect(renderRun(meshedStudy("dynamic_structural", 2_000, 1), slenderModel)).not.toContain("tet4-bending-locking");
  });
});
