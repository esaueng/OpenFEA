import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { bracketDisplayModel } from "@openfea/samples";
import type { DisplayModel, Load, MeshConvergenceRecord, Project, ResultSummary, Study } from "@openfea/schema";
import { StudySchema } from "@openfea/schema";
import { RightPanel } from "../RightPanel";
import type { StepId } from "../StepNav";
import { readinessForStudy } from "../../runReadiness";
import { assignedFaceTintsForStudy, LOAD_FACE_TINT, SUPPORT_FACE_TINT } from "../../assignedFaceTints";
import { stepFaceLabelForUnits } from "../../stepFaceLabels";
import { areaForUnits, formatArea, temperatureForUnits } from "../../unitDisplay";
import { directionVectorForLabel } from "../../loadPreview";
import { additionalFacesReducer, DisplacementField, duplicateLoadFeedback, justAddedLoadAfterChange, LoadEditForm, loadDirectionDescription, multiFaceLoadNote, storedLoadDirectionLabel, SupportEditForm, TemperatureField } from "./SupportsLoadsPanels";

// An imperial (US) project on an imported STEP part. Face labels carry the
// importer's mm² area suffix, exactly as stepFaces.ts writes and saves them.
const imperialProject: Project = {
  id: "project-us",
  name: "Imperial bracket",
  schemaVersion: "0.1.0",
  unitSystem: "US",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};
const metricProject: Project = { ...imperialProject, id: "project-si", unitSystem: "SI" };

// 645.16 mm² is exactly 1 in²; 1290.32 mm² is 2 in²; 1935.48 mm² is 3 in².
const faces = [
  { id: "step-face-1", label: "+Z planar face F1 (645 mm²)", area: 645.16 },
  { id: "step-face-2", label: "-Z planar face F2 (1,290 mm²)", area: 1290.32 },
  { id: "step-face-3", label: "Cylindrical hole wall F3 (1,935 mm²)", area: 1935.48 }
];
const displayModel: DisplayModel = {
  id: "display-step",
  name: "bracket.step",
  bodyCount: 1,
  faces: faces.map((face, index) => ({ ...face, color: "#8b949e", center: [index, 0, 0], normal: [0, 0, 1], stressValue: 0, surfaceType: "planar" }))
};
const namedSelections: Study["namedSelections"] = faces.map((face) => ({
  id: `selection-${face.id}`,
  name: face.label,
  entityType: "face",
  geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: face.id, label: face.label }],
  fingerprint: face.id
}));
const study: Study = {
  id: "study-us",
  projectId: imperialProject.id,
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Body" }],
  materialAssignments: [],
  namedSelections,
  contacts: [],
  constraints: [],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
};
const resultSummary: ResultSummary = { maxStress: 0, maxStressUnits: "MPa", maxDisplacement: 0, maxDisplacementUnits: "mm", safetyFactor: 0, reactionForce: 0, reactionForceUnits: "N" };

function renderPanel(activeStep: StepId, overrides: Partial<Parameters<typeof RightPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <RightPanel
      activeStep={activeStep}
      project={imperialProject}
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
      canRunSimulation={false}
      missingRunItems={[]}
      resultPlaybackPlaying={false}
      resultPlaybackFps={12}
      resultPlaybackReverseLoop={false}
      onResultPlaybackToggle={vi.fn()}
      onResultPlaybackFpsChange={vi.fn()}
      onResultPlaybackReverseLoopChange={vi.fn()}
      onStepSelect={vi.fn()}
      runReadiness={readinessForStudy(overrides.study ?? study)}
      {...overrides}
    />
  );
}

/** The <input> inside a field element, found without a DOM by walking the element tree. */
function inputIn(node: ReactNode): ReactElement<{ value: string; onChange: (event: { currentTarget: { value: string } }) => void }> {
  const queue: ReactNode[] = [node];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...(current as ReactNode[]));
      continue;
    }
    if (!current || typeof current !== "object" || !("props" in current)) continue;
    const element = current as ReactElement<{ children?: ReactNode }>;
    if (element.type === "input") return element as never;
    queue.push(element.props.children);
  }
  throw new Error("No input in field");
}

function typeInto(field: ReactElement, value: string) {
  inputIn(field).props.onChange({ currentTarget: { value } });
}

describe("imperial project walk-through: supports, loads and mesh read in project units", () => {
  test("face area labels read in in² on an imperial project and stay mm² on a metric one", () => {
    expect(stepFaceLabelForUnits(faces[0]!.label, faces[0]!.area, "US")).toBe("+Z planar face F1 (1 in²)");
    expect(stepFaceLabelForUnits(faces[1]!.label, faces[1]!.area, "US")).toBe("-Z planar face F2 (2 in²)");
    expect(stepFaceLabelForUnits(faces[0]!.label, faces[0]!.area, "SI")).toBe(faces[0]!.label);
    // No measured area or no STEP suffix: the stored label is shown as-is, never re-derived from its text.
    expect(stepFaceLabelForUnits(faces[0]!.label, undefined, "US")).toBe(faces[0]!.label);
    expect(stepFaceLabelForUnits("Top face", 645.16, "US")).toBe("Top face");
    expect(areaForUnits(645.16, "mm^2", "US")).toEqual({ value: 1, units: "in^2" });
    expect(formatArea(1, "in^2", "SI")).toBe("645.2 mm²");

    const html = renderPanel("supports", { selectedFace: displayModel.faces[0]! });
    expect(html).toContain("Selected +Z planar face F1 (1 in²)");
    expect(html).toContain("-Z planar face F2 (2 in²)");
    expect(html).not.toContain("mm²");
    expect(renderPanel("supports", { project: metricProject, selectedFace: displayModel.faces[0]! })).toContain("Selected +Z planar face F1 (645 mm²)");
  });

  test("boundary temperature is entered and listed in °F while the study keeps °C", () => {
    const thermal = StudySchema.parse({
      ...study,
      type: "steady_state_thermal",
      constraints: [{ id: "t-1", type: "prescribed_temperature", selectionRef: namedSelections[1]!.id, parameters: { value: 100, units: "°C" }, status: "complete" }]
    });
    const html = renderPanel("supports", { study: thermal, draftSupportTemperature: 20 });
    expect(html).toContain('type="number" value="68"');
    expect(html).toContain("<span>°F</span>");
    expect(html).toContain("Prescribed temperature (212 °F)");
    expect(html).not.toContain("°C");

    // Typing 212 °F drafts 100 °C — the value the solver consumes.
    const onChange = vi.fn();
    typeInto(TemperatureField({ valueCelsius: 20, unitSystem: "US", onChange }), "212");
    expect(onChange).toHaveBeenCalledWith(100);
    expect(inputIn(TemperatureField({ valueCelsius: 20, unitSystem: "US", onChange })).props.value).toBe("68");
    // Metric projects are unchanged.
    expect(inputIn(TemperatureField({ valueCelsius: 20, unitSystem: "SI", onChange })).props.value).toBe("20");
    expect(temperatureForUnits(32, "°F", "SI")).toEqual({ value: 0, units: "°C" });
  });

  test("prescribed displacement is entered and listed in inches while the study keeps mm", () => {
    const displaced: Study = {
      ...study,
      constraints: [{ id: "pd-1", type: "prescribed_displacement", selectionRef: namedSelections[0]!.id, parameters: { value: 2.54, units: "mm", component: "x" }, status: "complete" }]
    };
    expect(renderPanel("supports", { study: displaced })).toContain("Prescribed displacement (0.1 in x)");
    expect(renderPanel("supports", { project: metricProject, study: displaced })).toContain("Prescribed displacement (2.54 mm x)");

    const onChange = vi.fn();
    const field = DisplacementField({ valueMm: 2.54, unitSystem: "US", onChange });
    expect(inputIn(field).props.value).toBe("0.1");
    expect(renderToStaticMarkup(field)).toContain("<span>in</span>");
    typeInto(field, "0.5");
    expect(onChange).toHaveBeenLastCalledWith(12.7);
    typeInto(DisplacementField({ valueMm: 0, unitSystem: "SI", onChange }), "3");
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  test("remote point coordinates name their frame instead of a length unit", () => {
    const html = renderPanel("loads", { selectedFace: displayModel.faces[0]!, selectedLoadPoint: [1, 2, 3], draftLoadType: "remote_force" });
    expect(html).toContain("Remote point coordinates (viewer frame)");
    expect(html).toContain('aria-label="Remote point X (viewer frame)"');
    expect(html).toContain("not in values");
  });

  test("mesh element sizes and convergence rungs read in project units", () => {
    expect(renderPanel("mesh")).toContain("target element size 0.472 in");
    expect(renderPanel("mesh")).not.toContain("element size 12 mm");
    expect(renderPanel("mesh", { project: metricProject })).toContain("target element size 12 mm");

    const meshed: Study = {
      ...study,
      meshSettings: { preset: "medium", status: "complete", summary: { nodes: 10, elements: 4, warnings: [], density: { requestedMeshSizeMm: 25.4, actualMeshSizeMm: 12.7 } } as Study["meshSettings"]["summary"] }
    };
    const meshedHtml = renderPanel("mesh", { study: meshed });
    expect(meshedHtml).toContain("1 in");
    expect(meshedHtml).toContain("0.5 in");

    const convergenceHtml = renderPanel("mesh", { project: { ...imperialProject, convergenceRecords: [convergenceRecord()] }, study: convergenceStudy() });
    expect(convergenceHtml).toContain("elements · 1.000 in");
    expect(convergenceHtml).toContain("1.000 in · 1.000 ksi");
    expect(convergenceHtml).not.toContain(" mm<");
  });

  test("a rung missing counts shows the app's -- placeholder, not an em dash", () => {
    const record = convergenceRecord();
    const sparse: MeshConvergenceRecord = { ...record, rungs: [{ ...record.rungs[0]!, totalDofs: undefined, freeDofs: undefined, actualNodeCount: undefined, actualMeshSizeMm: undefined }, record.rungs[1]!] };
    const html = renderPanel("mesh", { project: { ...imperialProject, convergenceRecords: [sparse] }, study: convergenceStudy() });
    expect(html).toContain("-- total · -- free DOF");
    expect(html).toContain("-- nodes · 300 elements · --");
    expect(html).not.toContain("—");
  });
});

describe("edit forms name a face picked in the viewer in project units", () => {
  const fixedSupport: Study["constraints"][number] = { id: "support-1", type: "fixed", selectionRef: namedSelections[0]!.id, parameters: {}, status: "complete" };
  const faceForce: Load = { id: "load-1", type: "force", selectionRef: namedSelections[0]!.id, parameters: { value: 10, units: "N", direction: [0, 0, -1] }, status: "complete" };
  const editingStudy: Study = { ...study, constraints: [fixedSupport], loads: [faceForce] };
  const picked = displayModel.faces[1]!;

  function supportForm(unitSystem: "SI" | "US") {
    return renderToStaticMarkup(<SupportEditForm support={fixedSupport} study={editingStudy} displayModel={displayModel} unitSystem={unitSystem} retargetFace={picked} onSave={vi.fn()} onCancel={vi.fn()} />);
  }

  function loadForm(unitSystem: "SI" | "US") {
    return renderToStaticMarkup(<LoadEditForm load={faceForce} study={editingStudy} displayModel={displayModel} unitSystem={unitSystem} accessibleName="Load 1" retargetFace={picked} onSave={vi.fn()} onCancel={vi.fn()} onPreviewChange={vi.fn()} />);
  }

  test("an imperial project reads the picked face's area in in², not the stored mm² suffix", () => {
    for (const html of [supportForm("US"), loadForm("US")]) {
      expect(html).toContain("<span>Move to -Z planar face F2 (2 in²) (picked in the viewer)</span>");
      expect(html).toContain('aria-label="Move to -Z planar face F2 (2 in²)"');
      expect(html).not.toContain("mm²");
    }
  });

  test("a metric project keeps the stored label", () => {
    for (const html of [supportForm("SI"), loadForm("SI")]) {
      expect(html).toContain("<span>Move to -Z planar face F2 (1,290 mm²) (picked in the viewer)</span>");
    }
  });

  test("the offer is absent when the pick is the entry's own face", () => {
    const html = renderToStaticMarkup(<SupportEditForm support={fixedSupport} study={editingStudy} displayModel={displayModel} unitSystem="US" retargetFace={displayModel.faces[0]!} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(html).not.toContain("picked in the viewer");
  });
});

describe("load direction radio group", () => {
  test("keeps one Tab stop, on the checked direction", () => {
    const html = renderPanel("loads", { selectedFace: displayModel.faces[0]!, draftLoadDirection: "-Z" });
    const group = html.match(/<div class="segmented direction-choice" role="radiogroup"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const radios = group.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => radio.includes('aria-checked="true"') && radio.includes('tabindex="0"'))).toHaveLength(1);
    expect(radios.filter((radio) => radio.includes('aria-checked="false"') && radio.includes('tabindex="-1"'))).toHaveLength(2);
  });
});

describe("assembly connections", () => {
  const twoBodies: DisplayModel = { ...displayModel, bodyCount: 2 };
  const connected: Study = {
    ...study,
    contacts: [
      { id: "connection-contact", type: "contact", source: namedSelections[0]!.id, target: namedSelections[1]!.id, formulation: "frictionless", kinematics: "small_sliding", status: "ready" },
      { id: "connection-tie", type: "tie", source: namedSelections[1]!.id, target: namedSelections[2]!.id, kinematics: "small_sliding", status: "ready" }
    ]
  };

  test("labels every existing contact connection as a penalty approximation, not just the draft", () => {
    const html = renderPanel("mesh", { displayModel: twoBodies, study: connected });
    expect(html.match(/<div class="load-case-row connection-row">/g)).toHaveLength(2);
    // One chip, on the contact row only: tied and fused rows are not approximated that way.
    expect(html.match(/<span class="result-tier-chip approximation"[^>]*>Penalty contact \(approximation\)<\/span>/g)).toHaveLength(1);
    const contactRow = html.slice(html.indexOf("Frictionless contact</strong>"), html.indexOf("Tied</strong>"));
    expect(contactRow).toContain("Penalty contact (approximation)");
    // The draft form defaults to Tied, so the draft callout is not what carries the caveat here.
    expect(html).not.toContain("node-to-surface penalty contact. Large sliding");
  });
});

describe("multi-face supports and loads stay visible after creation", () => {
  const multiFaceStudy: Study = {
    ...study,
    constraints: [{ id: "fs-1", type: "fixed", selectionRef: namedSelections[0]!.id, selectionRefs: [namedSelections[1]!.id], parameters: {}, status: "complete" }],
    loads: [{ id: "load-1", type: "force", selectionRef: namedSelections[1]!.id, selectionRefs: [namedSelections[2]!.id, namedSelections[0]!.id], parameters: { value: 445, units: "N", direction: [0, 0, -1], directionMode: "-Z" }, status: "complete" }]
  };

  test("support rows show +N faces and list every face", () => {
    const html = renderPanel("supports", { study: multiFaceStudy });
    expect(html).toContain("+Z planar face F1 (1 in²) +1 face");
    expect(html).toContain("Faces (2): +Z planar face F1 (1 in²) + -Z planar face F2 (2 in²)");
  });

  test("load rows list every face and say a total force is shared by area", () => {
    const html = renderPanel("loads", { study: multiFaceStudy });
    expect(html).toContain("-Z planar face F2 (2 in²) +2 faces");
    expect(html).toContain("Faces (3): -Z planar face F2 (2 in²) + Cylindrical hole wall F3 (3 in²) + +Z planar face F1 (1 in²) — total force shared by area");
  });

  test("single-face rows are unchanged", () => {
    const single: Study = { ...study, constraints: [{ id: "fs-1", type: "fixed", selectionRef: namedSelections[0]!.id, parameters: {}, status: "complete" }] };
    const html = renderPanel("supports", { study: single });
    expect(html).toContain("<small>+Z planar face F1 (1 in²)</small>");
    expect(html).not.toContain("Faces (");
  });

  test("the draft explains how the adapter applies a load across several faces", () => {
    expect(multiFaceLoadNote("force", 1)).toBeNull();
    expect(multiFaceLoadNote("force", 3)).toBe("The total force is shared across all 3 faces in proportion to their area, not applied in full to each face.");
    expect(multiFaceLoadNote("pressure", 2)).toBe("The full pressure acts on each of the 2 faces.");
    expect(multiFaceLoadNote("remote_force", 2)).toContain("combined area of all 2 faces");
  });

  test("every face of a multi-face support or load is tinted in the viewer", () => {
    expect(assignedFaceTintsForStudy(multiFaceStudy)).toEqual(expect.arrayContaining([
      { faceId: "step-face-1", color: SUPPORT_FACE_TINT },
      { faceId: "step-face-2", color: SUPPORT_FACE_TINT },
      { faceId: "step-face-3", color: LOAD_FACE_TINT }
    ]));
    expect(assignedFaceTintsForStudy(multiFaceStudy)).toHaveLength(3);
    expect(assignedFaceTintsForStudy(null)).toEqual([]);
  });

  test("the extra-face checklist clears after an Add succeeds, so the next Add starts from one face", () => {
    let state = { refs: [] as string[], entryCount: 0 };
    state = additionalFacesReducer(state, { type: "toggle", ref: "a" });
    state = additionalFacesReducer(state, { type: "toggle", ref: "b" });
    state = additionalFacesReducer(state, { type: "toggle", ref: "a" });
    expect(state.refs).toEqual(["b"]);
    // Same count (a re-render): the draft stays.
    expect(additionalFacesReducer(state, { type: "entries", count: 0 })).toBe(state);
    // A support or load was added: the checklist clears.
    state = additionalFacesReducer(state, { type: "toggle", ref: "c" });
    const afterAdd = additionalFacesReducer(state, { type: "entries", count: 1 });
    expect(afterAdd).toEqual({ refs: [], entryCount: 1 });
    // Removing an entry keeps an in-progress draft.
    const drafted = additionalFacesReducer(afterAdd, { type: "toggle", ref: "d" });
    expect(additionalFacesReducer(drafted, { type: "entries", count: 0 }).refs).toEqual(["d"]);
  });
});

describe("mesh convergence controls", () => {
  test("offers a stop action while the ladder runs", () => {
    const html = renderPanel("mesh", { project: metricProject, study: convergenceStudy(), onRunMeshConvergence: vi.fn(), onCancelMeshConvergence: vi.fn(), convergenceBusy: true });
    expect(html).toMatch(/<button class="secondary wide" type="button" aria-label="Stop mesh-convergence study">[\s\S]*?Stop convergence<\/button>/);
    expect(html).not.toContain("Running convergence…");
    // Without a cancel handler the busy state stays a disabled label, as before.
    expect(renderPanel("mesh", { project: metricProject, study: convergenceStudy(), onRunMeshConvergence: vi.fn(), convergenceBusy: true })).toContain("Running convergence…");
  });

  test("draws the two chart series with distinct dash and marker shapes plus a legend", () => {
    const html = renderPanel("mesh", { project: { ...metricProject, convergenceRecords: [convergenceRecord()] }, study: convergenceStudy() });
    expect(html).toMatch(/<polyline[^>]*class="chart-stress"[^>]*stroke-dasharray="5 3"/);
    expect(html).not.toMatch(/<polyline[^>]*class="chart-displacement"[^>]*stroke-dasharray/);
    expect(html.match(/data-marker="circle"/g)).toHaveLength(3); // two rungs + legend
    expect(html.match(/data-marker="square"/g)).toHaveLength(3);
    expect(html).toContain('class="chart-legend"');
    expect(html).toContain("Displacement: solid line, round markers. Stress: dashed line, square markers.");
  });
});

function convergenceStudy(): Study {
  return {
    ...study,
    loads: [{ id: "load-1", type: "force", selectionRef: namedSelections[0]!.id, parameters: { value: 10, units: "N", direction: [0, 0, -1], applicationPoint: [0, 0, 0] }, status: "complete" }],
    loadCases: [{ id: "case-default", name: "Default", enabled: true, loadIds: ["load-1"] }],
    loadCombinations: []
  } satisfies Study;
}

function convergenceRecord(): MeshConvergenceRecord {
  const rung = {
    status: "complete" as const,
    actualNodeCount: 100,
    actualElementCount: 300,
    freeDofs: 270,
    actualMeshSizeMm: 25.4,
    rawElementPeakVonMises: 6.894757293168361,
    stressUnits: "MPa",
    probeDisplacement: 25.4,
    displacementUnits: "mm"
  };
  return {
    id: "convergence-1",
    studyId: study.id,
    caseId: "case-default",
    createdAt: "2026-07-14T12:00:00.000Z",
    completedAt: "2026-07-14T12:01:00.000Z",
    probe: { point: [0, 0, 0], source: "primary_load" },
    classification: "inconclusive",
    rungs: [
      { ...rung, requestedPreset: "coarse", totalDofs: 300 },
      { ...rung, requestedPreset: "medium", totalDofs: 600 }
    ]
  };
}

describe("load rows and the add flow agree with the form that created them (live review)", () => {
  const topFace = bracketDisplayModel.faces.find((face) => face.id === "face-load-top")!;
  const topSelection: Study["namedSelections"][number] = {
    id: "selection-top",
    name: topFace.label,
    entityType: "face",
    geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: topFace.id, label: topFace.label }],
    fingerprint: topFace.id
  };
  const minusZ = directionVectorForLabel("-Z", topFace, bracketDisplayModel);
  // What Add creates from the default "Along axis / Global -Z" form: the -Z vector,
  // the chosen mode, and the picked point where the arrow is drawn.
  const added: Load = { id: "load-2", type: "force", selectionRef: topSelection.id, parameters: { label: "L2", value: 500, units: "N", direction: minusZ, directionMode: "-Z", applicationPoint: topFace.center }, status: "complete" };
  // The sample's own load: a vector only, no stored mode.
  const legacy: Load = { id: "load-1", type: "force", selectionRef: topSelection.id, parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" };
  const bracketStudy: Study = { ...study, namedSelections: [topSelection], loads: [legacy, added] };

  test("a load added along global -Z is listed along global -Z, and a face force is not called a point load", () => {
    // On this face -Z is also the inward normal; the chosen label leads and the other reading follows.
    expect(sameVector(minusZ, [0, -1, 0])).toBe(true);
    const html = renderPanel("loads", { project: metricProject, displayModel: bracketDisplayModel, study: bracketStudy });
    expect(html).toContain(`${topFace.label} · along global -Z (into the face)`);
    expect(html).toContain(`${topFace.label} · into the face (along global -Z)`);
    expect(html).not.toContain("point load");
    expect(storedLoadDirectionLabel(added, bracketDisplayModel, topFace)).toBe("-Z");
    expect(loadDirectionDescription(added, bracketDisplayModel, topFace)).toBe("along global -Z (into the face)");
    // The edit form opens on the stored label; a stale mode never overrides the vector.
    expect(storedLoadDirectionLabel(legacy, bracketDisplayModel, topFace)).toBe("Opposite normal");
    const stale: Load = { ...added, parameters: { ...added.parameters, directionMode: "+X" } };
    expect(storedLoadDirectionLabel(stale, bracketDisplayModel, topFace)).toBe("Opposite normal");
  });

  test("right after Add the still-selected face reads as added, not as a duplicate; a genuine duplicate is still refused", () => {
    const draftKey = [topSelection.id, "force", 500, "-Z"].join("|");
    // Before the Add: nothing to compare against.
    let justAdded = justAddedLoadAfterChange([], [], draftKey, null);
    expect(duplicateLoadFeedback(undefined, justAdded, draftKey)).toBeNull();
    // The Add succeeds: one new load from the unchanged draft is the one just created.
    justAdded = justAddedLoadAfterChange([], ["load-2"], draftKey, justAdded);
    expect(duplicateLoadFeedback("load-2", justAdded, draftKey)).toBe("just_added");
    // Change the magnitude and come back: that is a real duplicate again.
    const otherKey = [topSelection.id, "force", 600, "-Z"].join("|");
    justAdded = justAddedLoadAfterChange(["load-2"], ["load-2"], otherKey, justAdded);
    expect(justAdded).toBeNull();
    expect(duplicateLoadFeedback("load-2", justAddedLoadAfterChange(["load-2"], ["load-2"], draftKey, justAdded), draftKey)).toBe("duplicate");
    // An older identical load is always a duplicate.
    expect(duplicateLoadFeedback("load-1", { loadId: "load-2", draftKey }, draftKey)).toBe("duplicate");

    // Rendered: a face that already carries the identical load still shows the red error and a disabled Add.
    const html = renderPanel("loads", { project: metricProject, displayModel: bracketDisplayModel, study: { ...bracketStudy, loads: [added] }, selectedFace: topFace, draftLoadValue: 500, draftLoadDirection: "-Z" });
    expect(html).toContain("is already applied to");
    expect(html).toMatch(/<button class="outline-action wide" disabled=""[^>]*>[^<]*<svg[\s\S]*?Add load<\/button>/);
  });
});

describe("per-component fixed and symmetry supports (plan 036 R1.4)", () => {
  const partial: Study["constraints"][number] = { id: "fs-partial", type: "fixed", selectionRef: namedSelections[0]!.id, parameters: { label: "FS 1", components: ["x", "z"] }, status: "complete" };
  const symmetry: Study["constraints"][number] = { id: "sym-1", type: "symmetry", selectionRef: namedSelections[1]!.id, parameters: { label: "SYM 1" }, status: "complete" };

  test("support rows describe the components each support holds, and label them development-grade", () => {
    const html = renderPanel("supports", { study: { ...study, constraints: [partial, symmetry] } });
    expect(html).toContain("FS 1 · Fixed support (X, Z; Y free)");
    expect(html).toContain("SYM 1 · Symmetry / roller (holds Z, the face normal)");
    expect(html).toContain("development-grade");
    const classic = renderPanel("supports", { study: { ...study, constraints: [{ ...partial, parameters: { label: "FS 1" } }] } });
    expect(classic).toContain("FS 1 · Fixed support (X, Y, Z)");
    expect(classic).not.toContain("development-grade");
  });

  test("the add form offers symmetry, and held directions as a radio group defaulting to all three", () => {
    const html = renderPanel("supports", { selectedFace: displayModel.faces[0]! });
    expect(html).toContain('<option value="symmetry">Symmetry / roller</option>');
    const group = html.match(/<div class="segmented" role="radiogroup" aria-labelledby="fixed-components-label"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const radios = group.match(/<button[^>]*role="radio"[^>]*>[^<]*/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios.filter((radio) => radio.includes('aria-checked="true"') && radio.includes('tabindex="0"'))).toEqual([expect.stringContaining("All (X, Y, Z)")]);
    expect(html).not.toContain("Components held");
  });

  test("a modal study offers symmetry but not prescribed displacement", () => {
    const modal = { ...study, type: "modal_analysis", solverSettings: { modeCount: 6 } } as unknown as Study;
    const html = renderPanel("supports", { study: modal, selectedFace: displayModel.faces[0]! });
    expect(html).toContain('<option value="symmetry">Symmetry / roller</option>');
    expect(html).not.toContain('<option value="prescribed_displacement">');
  });

  test("editing a partial fixed support shows its held components", () => {
    const html = renderToStaticMarkup(<SupportEditForm support={partial} study={{ ...study, constraints: [partial] }} displayModel={displayModel} unitSystem="SI" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toMatch(/role="radio" aria-checked="true" tabindex="0"[^>]*>Chosen components/);
    expect(html).toContain("Components held");
    const boxes = html.match(/<input type="checkbox"[^>]*\/><span>[XYZ]<\/span>/g) ?? [];
    expect(boxes.map((box) => [box.slice(-8, -7), box.includes('checked=""')])).toEqual([["X", true], ["Y", false], ["Z", true]]);
  });

  test("editing a symmetry support states the axis tolerance", () => {
    const html = renderToStaticMarkup(<SupportEditForm support={symmetry} study={{ ...study, constraints: [symmetry] }} displayModel={displayModel} unitSystem="SI" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('<option value="symmetry" selected="">Symmetry / roller</option>');
    expect(html).toContain("within 1° of the global X, Y or Z axis");
    expect(html).not.toContain("Held directions");
  });
});

function sameVector(left: readonly number[], right: readonly number[]) {
  return left.every((value, index) => Math.abs(value - right[index]!) < 1e-9);
}

describe("named selections in the Supports and Loads panels (plan 036 R1.2)", () => {
  const boltHoles: Study["namedSelections"][number] = {
    id: "selection-named-bolt-holes",
    name: "Bolt holes",
    entityType: "face",
    geometryRefs: [namedSelections[0]!.geometryRefs[0]!, namedSelections[2]!.geometryRefs[0]!],
    fingerprint: 'faceset:v1:["step-face-1","step-face-3"]'
  };
  const reusedStudy: Study = {
    ...study,
    namedSelections: [...namedSelections, boltHoles],
    constraints: [{ id: "fs-1", type: "fixed", selectionRef: boltHoles.id, parameters: {}, status: "complete" }],
    loads: [{ id: "load-1", type: "pressure", selectionRef: boltHoles.id, parameters: { value: 1, units: "MPa", direction: [0, 0, -1], directionMode: "-Z" }, status: "complete" }]
  };
  const manager = {
    selectedFaceNames: ["+Z planar face F1 (645 mm²)", "-Z planar face F2 (1,290 mm²)"],
    boundSelectionId: null,
    onCreate: vi.fn(() => null),
    onRename: vi.fn(() => null),
    onDelete: vi.fn(() => null),
    onUse: vi.fn()
  };

  test("a support and a load reusing one named selection name it and list every face", () => {
    const supports = renderPanel("supports", { study: reusedStudy });
    expect(supports).toContain("<small>Bolt holes · +Z planar face F1 (1 in²) +1 face</small>");
    expect(supports).toContain("Faces (2): +Z planar face F1 (1 in²) + Cylindrical hole wall F3 (3 in²)");
    const loads = renderPanel("loads", { study: reusedStudy });
    expect(loads).toContain("Bolt holes · +Z planar face F1 (1 in²) +1 face");
    expect(loads).toContain("Faces (2): +Z planar face F1 (1 in²) + Cylindrical hole wall F3 (3 in²)");
  });

  test("the Additional faces checklist offers faces, not named selections", () => {
    const html = renderPanel("supports", { study: reusedStudy, selectedFace: displayModel.faces[0]! });
    expect(html).toContain("Additional faces");
    expect(html).toContain("<span>-Z planar face F2 (2 in²)</span>");
    expect(html).not.toContain("<span>Bolt holes");
  });

  test("viewer Ctrl/Cmd-click picks arrive as checked Additional faces through the workspace", () => {
    const html = renderPanel("supports", {
      selectedFace: displayModel.faces[0]!,
      additionalSelectionRefs: [namedSelections[1]!.id],
      onToggleAdditionalSelectionRef: vi.fn()
    });
    expect(html).toContain('<input type="checkbox" checked=""/><span>-Z planar face F2 (2 in²)</span>');
    expect(html).toContain('<input type="checkbox"/><span>Cylindrical hole wall F3 (3 in²)</span>');
    expect(html).toContain("1 selected");
    expect(html).toContain("Add fixed support (2 faces)");
  });

  test("the manager entry shows the face count and opens a dialog", () => {
    const html = renderPanel("supports", { selectedFace: displayModel.faces[0]!, namedSelectionManager: manager });
    expect(html).toContain('<span class="working-selection-count">2 faces selected</span>');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Named selections…");
    // Not offered for body loads, which act on the whole part.
    expect(renderPanel("loads", { draftLoadType: "volume_force", namedSelectionManager: manager })).not.toContain("Named selections…");
  });
});
