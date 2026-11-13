import { describe, expect, test } from "vitest";
import { StudySchema, type Study } from "@openfea/schema";

import { TET4_BENDING_LOCKING_NOTE, runAdvisoriesForStudy, tet4BendingLockingApplies } from "./runAdvisories";

const SLENDER = { dimensions: { x: 1000, y: 20, z: 20, units: "mm" } };
const PLATE = { dimensions: { x: 200, y: 200, z: 5, units: "mm" } };
const BLOCK = { dimensions: { x: 200, y: 100, z: 100, units: "mm" } };

function study(type: Study["type"], options: { nodes?: number; elementOrder?: 1 | 2; modeCount?: number } = {}): Study {
  const meshed = options.nodes !== undefined;
  return StudySchema.parse({
    id: "study-advisory",
    projectId: "project-advisory",
    name: "Advisory",
    type,
    geometryScope: [],
    materialAssignments: [],
    namedSelections: [],
    contacts: [],
    constraints: [],
    loads: [],
    meshSettings: meshed
      ? { preset: "medium", status: "complete", summary: { nodes: options.nodes, elements: options.nodes, warnings: [], source: "wasm_gmsh", ...(options.elementOrder ? { density: { elementOrder: options.elementOrder } } : {}) } }
      : { preset: "medium", status: "not_started" },
    solverSettings: { ...(options.elementOrder ? { elementOrder: options.elementOrder } : {}), ...(options.modeCount ? { modeCount: options.modeCount } : {}) },
    validation: [],
    runs: []
  });
}

const ids = (advisories: ReturnType<typeof runAdvisoriesForStudy>) => advisories.map((advisory) => advisory.id);

describe("slender long-run warning", () => {
  test("appears for a slender part whose projected run is long, with the range and the first-look advice", () => {
    // 50k nodes = 150k DOF Tet10 static on a 50:1 bar: the ladder's 22-minute case.
    const advisories = runAdvisoriesForStudy(study("static_stress", { nodes: 50_000, elementOrder: 2 }), SLENDER);
    const warning = advisories.find((advisory) => advisory.id === "slender-long-run");
    expect(warning?.tone).toBe("warning");
    expect(warning?.text).toContain("bounding box about 50:1");
    expect(warning?.text).toMatch(/projected to take about \d+–\d+ min/);
    expect(warning?.text).toContain("try a coarser mesh preset.");
    expect(warning?.text).toContain("approximate and depends on your browser and device");
  });

  test("suggests fewer modes for a slender modal study", () => {
    const warning = runAdvisoriesForStudy(study("modal_analysis", { nodes: 10_000, elementOrder: 2, modeCount: 6 }), SLENDER).find((advisory) => advisory.id === "slender-long-run");
    expect(warning?.text).toContain("request fewer modes");
  });

  test.each(["static_stress", "modal_analysis", "dynamic_structural", "steady_state_thermal"] as const)("does not appear for a compact part (%s)", (type) => {
    expect(ids(runAdvisoriesForStudy(study(type, { nodes: 50_000, elementOrder: 2 }), BLOCK))).not.toContain("slender-long-run");
  });

  test("does not appear for a slender part whose run is short", () => {
    // 2k nodes Tet4 static: well under the long-run threshold even at 50:1.
    expect(ids(runAdvisoriesForStudy(study("static_stress", { nodes: 2_000, elementOrder: 1 }), SLENDER))).not.toContain("slender-long-run");
  });

  test("does not appear before a mesh exists (no DOF count to project from)", () => {
    expect(ids(runAdvisoriesForStudy(study("static_stress"), SLENDER))).not.toContain("slender-long-run");
  });
});

describe("Tet4 bending-locking note", () => {
  test.each(["static_stress", "modal_analysis"] as const)("appears for a slender Tet4 %s study", (type) => {
    const note = runAdvisoriesForStudy(study(type, { nodes: 2_000, elementOrder: 1 }), SLENDER).find((advisory) => advisory.id === "tet4-bending-locking");
    expect(note?.tone).toBe("note");
    expect(note?.text).toContain(TET4_BENDING_LOCKING_NOTE);
    expect(note?.text).toContain("5–14%");
  });

  test("appears for a thin plate, which the bounding box also reads as slender", () => {
    expect(ids(runAdvisoriesForStudy(study("static_stress", { nodes: 2_000, elementOrder: 1 }), PLATE))).toContain("tet4-bending-locking");
  });

  test("uses the requested order before meshing", () => {
    expect(ids(runAdvisoriesForStudy(study("static_stress", { elementOrder: 1 }), SLENDER))).toContain("tet4-bending-locking");
    // Default request is quadratic.
    expect(ids(runAdvisoriesForStudy(study("static_stress"), SLENDER))).not.toContain("tet4-bending-locking");
  });

  test("covers a large quadratic modal mesh that the solver projects to Tet4", () => {
    const note = runAdvisoriesForStudy(study("modal_analysis", { nodes: 40_000, elementOrder: 2 }), SLENDER).find((advisory) => advisory.id === "tet4-bending-locking");
    expect(note?.text).toContain("Tet4 projection of the quadratic mesh");
  });

  test.each([
    ["Tet10", study("static_stress", { nodes: 2_000, elementOrder: 2 }), SLENDER],
    ["a compact part", study("static_stress", { nodes: 2_000, elementOrder: 1 }), BLOCK],
    ["dynamic", study("dynamic_structural", { nodes: 2_000, elementOrder: 1 }), SLENDER],
    ["thermal", study("steady_state_thermal", { nodes: 2_000, elementOrder: 1 }), SLENDER],
    ["unknown extents", study("static_stress", { nodes: 2_000, elementOrder: 1 }), {}]
  ] as const)("does not appear for %s", (_label, candidate, model) => {
    expect(ids(runAdvisoriesForStudy(candidate, model))).not.toContain("tet4-bending-locking");
  });

  test("rule table", () => {
    expect(tet4BendingLockingApplies({ analysis: "static", elementOrder: "Tet4", aspectRatio: 20 })).toBe(true);
    expect(tet4BendingLockingApplies({ analysis: "static", elementOrder: "Tet4", aspectRatio: 19.9 })).toBe(false);
    expect(tet4BendingLockingApplies({ analysis: "modal", elementOrder: "Tet10", aspectRatio: 50 })).toBe(false);
    expect(tet4BendingLockingApplies({ analysis: "static", elementOrder: "Tet4", aspectRatio: null })).toBe(false);
  });
});
