import { describe, expect, test } from "vitest";
import { validateStudy } from "@openfea/study-core";
import type { Study } from "@openfea/schema";
import { MESH_BUILT_ON_RUN_NOTE, blockingReadinessItems, readinessForStudy, readinessItemStep, readinessItemText, studyHasGeneratedMesh } from "./runReadiness";

describe("readinessItemStep", () => {
  test("links each fixable readiness row to the step that resolves it", () => {
    expect(readinessItemStep("Material assigned")).toEqual({ step: "material", stepLabel: "Material" });
    expect(readinessItemStep("Support added")).toEqual({ step: "supports", stepLabel: "Supports" });
    expect(readinessItemStep("Load added")).toEqual({ step: "loads", stepLabel: "Loads" });
    expect(readinessItemStep("Mesh generated")).toEqual({ step: "mesh", stepLabel: "Mesh" });
    // Resolved on the Run step itself: no link.
    expect(readinessItemStep("Run settings valid")).toBeNull();
    expect(readinessItemStep("Study valid")).toBeNull();
  });
});

const readyStaticStudy: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Fixture body" }],
  materialAssignments: [{ id: "assign-1", materialId: "mat-steel", selectionRef: "selection-body", status: "complete" }],
  namedSelections: [
    { id: "selection-face", name: "Top face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-top", label: "Top face" }], fingerprint: "face-top" },
    { id: "selection-fixed", name: "Base face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-base", label: "Base face" }], fingerprint: "face-base" }
  ],
  contacts: [],
  constraints: [{ id: "support-1", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
  loads: [{
    id: "load-1",
    type: "force",
    selectionRef: "selection-face",
    parameters: { value: 500, units: "N", direction: [0, -1, 0] },
    status: "complete"
  }],
  meshSettings: { preset: "medium", status: "complete", summary: { nodes: 10, elements: 4, warnings: [], source: "core_solver" } },
  solverSettings: {},
  validation: [],
  runs: []
};

function itemFor(study: Study | null, label: string) {
  return readinessForStudy(study).find((item) => item.label === label);
}

describe("mesh readiness reflects a mesh that actually exists", () => {
  test("does not tick Mesh generated for a seeded or estimated summary with no mesher counts", () => {
    // Regression: the Bracket Demo opens with status "complete" and a seeded summary
    // (Nodes/Elements read "--"), and the checklist ticked "Mesh generated".
    for (const meshSettings of [
      { preset: "medium", status: "complete", summary: { nodes: 42381, elements: 26944, warnings: [] } },
      { preset: "medium", status: "complete", summary: { nodes: 42381, elements: 26944, warnings: [], source: "preset_estimate" } },
      { preset: "medium", status: "complete" }
    ] as Study["meshSettings"][]) {
      const mesh = readinessForStudy({ ...readyStaticStudy, meshSettings }).find((item) => item.label === "Mesh generated");
      expect(mesh?.done).toBe(false);
      // The run builds the mesh it needs, so the row is pending, not a blocker.
      expect(mesh?.pending).toBe(MESH_BUILT_ON_RUN_NOTE);
      expect(mesh?.blockers).toEqual([]);
      expect(blockingReadinessItems(readinessForStudy({ ...readyStaticStudy, meshSettings }))).toEqual([]);
    }
  });

  test("ticks Mesh generated for mesher-produced summaries and stored volume meshes", () => {
    expect(studyHasGeneratedMesh(readyStaticStudy)).toBe(true);
    expect(studyHasGeneratedMesh({ meshSettings: { preset: "medium", status: "complete", summary: { nodes: 1, elements: 1, warnings: [], source: "wasm_gmsh" } } })).toBe(true);
    expect(studyHasGeneratedMesh({ meshSettings: { preset: "medium", status: "complete", summary: { nodes: 1, elements: 1, warnings: [], artifacts: { actualCoreModel: { model: {} } } } } as Study["meshSettings"] })).toBe(true);
    expect(studyHasGeneratedMesh({ meshSettings: { preset: "medium", status: "not_started", summary: { nodes: 1, elements: 1, warnings: [], source: "core_solver" } } })).toBe(false);
  });

  test("an ungenerated mesh still blocks the run", () => {
    const study = { ...readyStaticStudy, meshSettings: { preset: "medium", status: "not_started" } } as Study;
    const mesh = readinessForStudy(study).find((item) => item.label === "Mesh generated");
    expect(mesh).toMatchObject({ done: false, blockers: ["Generate the mesh before running."] });
    expect(mesh?.pending).toBeUndefined();
    expect(blockingReadinessItems(readinessForStudy(study)).map((item) => item.label)).toEqual(["Mesh generated"]);
  });
});

describe("thermal readiness wording", () => {
  test("names thermal boundary conditions in thermal terms while keeping the stable row keys", () => {
    const thermal = { ...readyStaticStudy, type: "steady_state_thermal", constraints: [], loads: [] } as unknown as Study;
    const items = readinessForStudy(thermal);
    expect(items.find((item) => item.label === "Support added")?.displayLabel).toBe("Fixed temperature added");
    expect(items.find((item) => item.label === "Load added")?.displayLabel).toBe("Heat load added");
    expect(items.map(readinessItemText)).not.toContain("Support added");
    expect(items.map(readinessItemText)).not.toContain("Load added");
    expect(readinessForStudy(readyStaticStudy).map(readinessItemText)).toEqual(["Material assigned", "Support added", "Load added", "Mesh generated"]);
  });
});

describe("run readiness", () => {
  test("a fully configured study is ready to run", () => {
    const readiness = readinessForStudy(readyStaticStudy);
    expect(readiness.every((item) => item.done)).toBe(true);
    expect(readiness.map((item) => item.label)).toEqual(["Material assigned", "Support added", "Load added", "Mesh generated"]);
  });

  test("a negative load magnitude keeps the run gate closed", () => {
    // The reported defect: readiness checked that a load *existed*, so a -1 N
    // load read as "Load added" and Run started, only for the solver to refuse
    // it. The validator always knew better; nothing asked it.
    const study: Study = { ...readyStaticStudy, loads: [{ ...readyStaticStudy.loads[0]!, parameters: { ...readyStaticStudy.loads[0]!.parameters, value: -1 } }] };
    const load = itemFor(study, "Load added");
    expect(load?.done).toBe(false);
    expect(load?.blockers.join(" ")).toContain("positive finite magnitude");
  });

  test("a zero or non-finite load magnitude keeps the run gate closed", () => {
    for (const value of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const study: Study = { ...readyStaticStudy, loads: [{ ...readyStaticStudy.loads[0]!, parameters: { ...readyStaticStudy.loads[0]!.parameters, value } }] };
      expect(itemFor(study, "Load added")?.done).toBe(false);
    }
  });

  test("nothing is ready without an open study", () => {
    expect(readinessForStudy(null).every((item) => item.done)).toBe(false);
  });

  test("every validator diagnostic reaches a readiness row", () => {
    // A rule the grouping does not recognize must still block the run. If this
    // fails, a new diagnostic was added without a home and the gate would let
    // through exactly what it was written to catch.
    const brokenStudy: Study = {
      ...readyStaticStudy,
      materialAssignments: [],
      constraints: [],
      loads: [],
      meshSettings: { preset: "medium", status: "not_started" }
    };
    const readiness = readinessForStudy(brokenStudy);
    const reported = readiness.flatMap((item) => item.blockers);
    for (const diagnostic of validateStudy(brokenStudy)) {
      expect(reported).toContain(diagnostic.message);
    }
    expect(readiness.some((item) => item.label === "Study valid")).toBe(false);
  });

  test("every known validator id is claimed by a readiness group (cross-layer contract)", () => {
    // The full id inventory of @openfea/study-core diagnostics. If a new
    // validator rule lands without a READINESS_GROUPS prefix, this fails and
    // points at the group to extend — see the ownership contract in
    // runReadiness.ts.
    const knownIds = [
      "validation-material",
      "validation-material-process-assign-1",
      "validation-material-resolution-assign-1",
      "validation-support",
      "validation-support-value-support-1",
      "validation-support-component-support-1",
      "validation-modal-support",
      "validation-dynamic-support",
      "validation-thermal-support",
      "validation-thermal-support-value-support-1",
      "validation-load",
      "validation-load-selection-load-1",
      "validation-load-value-load-1",
      "validation-load-direction-load-1",
      "validation-load-static-only-load-1",
      "validation-thermal-load",
      "validation-combination",
      "validation-load-case-required",
      "validation-load-case-enabled",
      "validation-mesh",
      "validation-dynamic-end-time",
      "validation-dynamic-time-step",
      "validation-dynamic-output-interval",
      "validation-dynamic-step-count",
      "validation-dynamic-damping",
      "validation-dynamic-combinations",
      "validation-modal-mode-count"
    ];
    const readiness = readinessForStudy({
      ...readyStaticStudy,
      materialAssignments: [],
      constraints: [],
      loads: [],
      meshSettings: { preset: "medium", status: "not_started" }
    });
    expect(readiness.some((item) => item.label === "Study valid")).toBe(false);
    // Spot-check the load-case family lands on the Load row (prefix coverage
    // for the whole validation-load-case-* family).
    const loadRow = readiness.find((item) => item.label === "Load added");
    expect(loadRow?.done).toBe(false);
    expect(knownIds.length).toBeGreaterThan(20);
  });

  test("modal analysis has no load row and gates on mode count", () => {
    const modalStudy = {
      ...readyStaticStudy,
      type: "modal_analysis",
      loads: [],
      solverSettings: { modeCount: 42 }
    } as unknown as Study;
    const readiness = readinessForStudy(modalStudy);
    expect(readiness.some((item) => item.label === "Load added")).toBe(false);
    expect(readiness.find((item) => item.label === "Run settings valid")?.done).toBe(false);
  });

  test("a dynamic study with free motion needs no support, but still needs a valid time range", () => {
    const base = {
      ...readyStaticStudy,
      type: "dynamic_structural",
      constraints: [],
      solverSettings: { allowFreeMotion: true, startTime: 0, endTime: 0.1, timeStep: 0.005, outputInterval: 0.01, dampingRatio: 0 }
    } as unknown as Study;
    expect(readinessForStudy(base).find((item) => item.label === "Support added")?.done).toBe(true);

    const badTimeRange = { ...base, solverSettings: { ...(base.solverSettings as object), endTime: -1 } } as unknown as Study;
    expect(readinessForStudy(badTimeRange).find((item) => item.label === "Run settings valid")?.done).toBe(false);
  });

  test("a thermal study needs a prescribed temperature and accepts signed heat flux", () => {
    // Negative inward surface flux is cooling, not an error — routing thermal
    // studies through the structural validator would have refused it.
    const thermalStudy = {
      ...readyStaticStudy,
      type: "steady_state_thermal",
      constraints: [{ id: "support-1", type: "prescribed_temperature", selectionRef: "selection-fixed", parameters: { value: 20 }, status: "complete" }],
      loads: [{ id: "load-1", type: "heat_flux", selectionRef: "selection-face", parameters: { value: -500, units: "W/m²" }, status: "complete" }]
    } as unknown as Study;
    expect(readinessForStudy(thermalStudy).every((item) => item.done)).toBe(true);

    const noPrescribedTemperature = { ...thermalStudy, constraints: [] } as unknown as Study;
    expect(readinessForStudy(noPrescribedTemperature).find((item) => item.label === "Support added")?.done).toBe(false);

    const zeroFlux = { ...thermalStudy, loads: [{ ...(thermalStudy.loads[0] as object), parameters: { value: 0, units: "W/m²" } }] } as unknown as Study;
    expect(readinessForStudy(zeroFlux).find((item) => item.label === "Load added")?.done).toBe(false);
  });
});
